"""The indexer: folds WAL entries into index segments and advances the cursor.

It runs as its own Deployment, separate from the query nodes. turbopuffer
(Architecture docs) also runs indexing on separate nodes, which find their
work through a queue on object storage (the queue blog post). One pass for a
namespace:

    1. claim a job in queue.json                         (CAS If-Match)
    2. read meta.json and manifest.json (note its etag)
    3. LIST wal/ after the cursor; take entries up to INDEXER_MAX_ROWS_PER_PASS rows
    4. GET those entries and keep the newest op per id (tombstones included)
    5. build a segment (docs, vectors, clusters, postings, filter index)
    6. PUT the segment files                             (If-None-Match, new random id)
    7. PUT manifest.json with segment added, cursor = last seq   (CAS If-Match)
         - 412? another indexer advanced it first. Delete our orphan files and stop.
    8. too many segments? compact: merge them all into one, then CAS the manifest again
    9. finish the job in queue.json (remove it, or put it back if there's more)

Step 7 is the commit point. Before it, queries don't know the new segment
exists and keep scanning those WAL entries as the tail. After it, they use
the segment and the tail gets shorter. There's never a moment where a row is
in neither place, or counted twice.

Several indexer replicas are safe: queue.json makes sure (normally) only one
works on a namespace at a time, and the manifest CAS makes sure that even if
two do (a lease expired while the first one was still running), only one
result is committed.
"""

from __future__ import annotations

import json
import socket
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor

from . import jobqueue, keys, manifest as manifest_mod, meta as meta_mod, segment, wal
from .cache import NodeCache
from .config import Settings
from .meta import now_iso
from .schema import VECTOR_ATTR
from .storage import ObjectStore, PreconditionFailed


class Indexer:
    def __init__(self, settings: Settings, store: ObjectStore, worker_id: str | None = None):
        self.s = settings
        self.store = store
        self.worker = worker_id or f"indexer-{socket.gethostname()}-{uuid.uuid4().hex[:4]}"
        self.pool = ThreadPoolExecutor(max_workers=16, thread_name_prefix="idx-io")
        self.cache = NodeCache(store, settings.cache_dir, settings.cache_disk_bytes, settings.cache_memory_bytes)
        self.started_at = time.time()
        self.passes = 0
        self.compactions = 0
        self.lost_manifest_races = 0
        self.current: dict | None = None  # what we're working on right now, for the console
        self.last_pass: dict | None = None
        self.events: list[dict] = []
        self._last_sweep = 0.0
        self._stop = threading.Event()
        # Readiness: when the loop last finished a step without an exception
        # (every step reads queue.json, so this is also "object storage answered").
        self.last_ok: float | None = None
        self.last_error: str | None = None

    def event(self, kind: str, ns: str, **detail) -> None:
        self.events.append({"t": time.time(), "node": self.worker, "kind": kind, "ns": ns, **detail})
        del self.events[:-300]

    # --- main loop ------------------------------------------------------------------

    def run_forever(self) -> None:
        print(f"[{self.worker}] indexer started")
        while not self._stop.is_set():
            try:
                did_work = self.step()
                self.last_ok, self.last_error = time.time(), None
            except Exception as e:
                print(f"[{self.worker}] error: {e!r}")
                self.last_error = repr(e)[:300]
                did_work = False
            if not did_work:
                self._stop.wait(self.s.indexer_poll_s)

    def stop(self) -> None:
        self._stop.set()

    def readiness(self, stale_after_s: float) -> tuple[bool, dict]:
        """Ready = the loop finished a step recently. A long pass (building a big
        segment) doesn't count against it: the heartbeat thread keeps the lease,
        and the step finishes successfully afterwards."""
        now = time.time()
        busy = self.current is not None
        age = None if self.last_ok is None else round(now - self.last_ok, 1)
        ok = busy or (self.last_ok is not None and now - self.last_ok <= stale_after_s)
        if self.last_ok is None and self.last_error is None:
            ok = now - self.started_at <= stale_after_s  # still on the first step
        return ok, {"ok": ok, "worker": self.worker, "last_ok_age_s": age, "last_error": self.last_error}

    def step(self) -> bool:
        """Claim and process one job. Returns True if there was work."""
        if time.time() - self._last_sweep > self.s.indexer_sweep_s:
            self.sweep()
        ns = jobqueue.claim(self.store, self.worker, self.s.indexer_lease_s)
        if ns is None:
            return False
        more = False
        hb_stop = threading.Event()
        hb = threading.Thread(target=self._heartbeat_loop, args=(ns, hb_stop), daemon=True)
        hb.start()
        try:
            more = self.index_pass(ns)
        finally:
            hb_stop.set()
            hb.join()
            self.current = None
            jobqueue.finish(self.store, ns, self.worker, more_work=more)
        if self.s.indexer_pass_delay_s:
            time.sleep(self.s.indexer_pass_delay_s)
        return True

    def _heartbeat_loop(self, ns: str, stop: threading.Event) -> None:
        interval = max(1.0, self.s.indexer_lease_s / 3)
        while not stop.wait(interval):
            if not jobqueue.heartbeat(self.store, ns, self.worker):
                print(f"[{self.worker}] lost the lease on {ns}")
                return

    def sweep(self) -> None:
        """Safety net: enqueue any namespace that has work nobody queued.

        Two kinds of work:
          * WAL entries above the cursor. The write path enqueues after each
            commit, but that call can fail (the node can die right after the
            WAL PUT, for example). Without a sweep those entries would wait
            until the next write to the namespace.
          * Garbage segments past GC_DELAY_S. Garbage is collected during an
            index pass, so a namespace that stops receiving writes would keep
            its replaced segments in the bucket forever. A pass with no WAL
            entries to index just collects the garbage and rewrites the manifest.
        Going through queue.json (instead of deleting here) keeps the rule that
        only the lease holder changes a namespace's manifest.
        """
        self._last_sweep = time.time()
        _, prefixes = self.store.list(keys.NS_ROOT, delimiter="/")
        queued = jobqueue.read(self.store)[0]["jobs"]
        now = time.time()
        for p in prefixes:
            ns = p[len(keys.NS_ROOT):-1]
            if ns in queued:
                continue
            man, _ = manifest_mod.read(self.store, ns)
            if wal.list_entries(self.store, ns, man["cursor"]):
                jobqueue.enqueue(self.store, ns)
                self.event("sweep_enqueued", ns)
            elif any(now - g["since"] >= self.s.gc_delay_s for g in man.get("garbage", [])):
                jobqueue.enqueue(self.store, ns)
                self.event("sweep_enqueued", ns, reason="garbage due")

    # --- one pass ---------------------------------------------------------------------

    def index_pass(self, ns: str) -> bool:
        """Index the next batch of WAL entries for ns. Returns True if more remain."""
        t0 = time.perf_counter()
        got = meta_mod.read(self.store, ns)
        if got is None:
            return False  # namespace deleted; finish() drops the job
        meta = got[0]
        man, man_etag = manifest_mod.read(self.store, ns)
        objs = wal.list_entries(self.store, ns, man["cursor"])
        collected = self._collect_garbage(ns, man)
        if not objs:
            if collected["garbage"] != man.get("garbage", []) and man_etag:
                try:
                    manifest_mod.write(self.store, ns, collected, man_etag)
                except PreconditionFailed:
                    pass  # someone else wrote it; we'll collect next time
            return False
        man = collected

        # Take whole entries until we reach the row budget (always at least one).
        taken, rows = [], 0
        entries = []
        for o in objs:
            e, _ = self.cache.load(o.key, lambda b: (json.loads(b), len(b)), etag=o.etag)
            n = wal.entry_rows(e)
            if taken and rows + n > self.s.indexer_max_rows_per_pass:
                break
            taken.append(o)
            entries.append(e)
            rows += n
        self.current = {"ns": ns, "from_seq": entries[0]["seq"], "to_seq": entries[-1]["seq"], "rows": rows,
                        "started": time.time(), "stage": "building"}

        latest = segment.resolve_latest([op for e in entries for op in wal.iter_ops(e)])
        files = segment.build(latest, meta, self.s.ann_min_rows)
        seg_id = segment.new_id()
        self.current["stage"] = "uploading"
        nbytes = segment.write(self.store, ns, seg_id, files)
        live_rows = sum(1 for _, row in latest.values() if row is not None)
        info = {"id": seg_id, "min_seq": entries[0]["seq"], "max_seq": entries[-1]["seq"], "rows": len(latest),
                "live_rows": live_rows, "bytes": nbytes, "created_at": now_iso(), "level": 0,
                "format": segment.FORMAT}
        new_man = dict(man, cursor=entries[-1]["seq"], segments=man["segments"] + [info])

        self.current["stage"] = "committing manifest"
        try:
            man_etag = manifest_mod.write(self.store, ns, new_man, man_etag)
        except PreconditionFailed:
            # Someone else advanced the manifest since we read it. Our segment
            # was never referenced, so delete it and let the job retry.
            self.lost_manifest_races += 1
            self.store.delete_prefix(keys.segment_prefix(ns, seg_id))
            self.event("manifest_race_lost", ns, seg=seg_id)
            return True
        new_man["version"] = new_man.get("version", 0) + 1
        self.passes += 1
        ms = round((time.perf_counter() - t0) * 1000)
        self.last_pass = {"ns": ns, "entries": len(entries), "rows": rows, "segment": seg_id, "ms": ms,
                          "cursor": new_man["cursor"], "at": time.time()}
        self.event("indexed", ns, entries=len(entries), rows=rows, cursor=new_man["cursor"], ms=ms, segment=seg_id)

        if len(new_man["segments"]) >= self.s.indexer_compact_at:
            self.current["stage"] = "compacting"
            self.compact(ns, meta, new_man, man_etag)
        return len(objs) > len(taken)

    # --- compaction ---------------------------------------------------------------------

    @staticmethod
    def pick_merge(segments: list[dict], max_rows: int) -> list[dict]:
        """Size-tiered choice: the smallest segments whose rows add up to at most max_rows.

        Merging everything (0.1.7) needed memory proportional to the whole
        namespace and OOMKilled the indexer at ~60-100k arXiv rows. With a cap,
        a namespace settles into segments of about max_rows each, and a merge
        never holds more than max_rows rows. Fewer than two picked = nothing to do.
        """
        picked, total = [], 0
        for s in sorted(segments, key=lambda s: s.get("live_rows", s["rows"])):
            n = s.get("live_rows", s["rows"])
            if total + n > max_rows:
                break
            picked.append(s)
            total += n
        return picked if len(picked) >= 2 else []

    def compact(self, ns: str, meta: dict, man: dict, man_etag: str) -> None:
        """Merge the smallest segments into one (see pick_merge). Shadowed versions are dropped.

        Tombstones are dropped only when the merge covers *every* segment: then no
        older copy of a deleted document can be left behind elsewhere. In a partial
        merge they're kept, because an older version may live in a segment that
        wasn't merged. Real LSM trees do the same: tombstones drop at the bottom level.
        """
        t0 = time.perf_counter()
        from .views import ViewManager

        merge = self.pick_merge(man["segments"], self.s.indexer_max_segment_rows)
        if not merge:
            return
        merge_ids = {s["id"] for s in merge}
        everything = len(merge) == len(man["segments"])
        vm = ViewManager(self.store, self.cache, self.pool)
        latest: dict = {}
        # One segment at a time, not pinned in the memory cache: a merge touches
        # every row once, and the segments it replaces are garbage afterwards.
        for s in merge:
            seg = vm.load_segment(ns, s["id"], remember=False, fmt=s.get("format", 1))
            for pos, doc_id in enumerate(seg.ids):
                v = int(seg.versions[pos])
                cur = latest.get(doc_id)
                if cur is not None and cur[0] >= v:
                    continue
                if seg.deleted[pos]:
                    latest[doc_id] = (v, None)
                else:
                    row = {"id": doc_id, **(seg.attrs[pos] or {})}
                    if seg.vectors is not None:
                        row[VECTOR_ATTR] = seg.vectors[pos]  # a numpy row: 4 bytes/float, not a 32-byte Python float
                    latest[doc_id] = (v, row)
            del seg
        files = segment.build(latest, meta, self.s.ann_min_rows, drop_tombstones=everything)
        live = sum(1 for _, row in latest.values() if row is not None)
        n_rows = live if everything else len(latest)
        del latest
        seg_id = segment.new_id()
        nbytes = segment.write(self.store, ns, seg_id, files)
        del files
        info = {"id": seg_id, "min_seq": min(s["min_seq"] for s in merge), "max_seq": max(s["max_seq"] for s in merge),
                "rows": n_rows, "live_rows": live, "bytes": nbytes, "created_at": now_iso(),
                "level": max(s.get("level", 0) for s in merge) + 1, "format": segment.FORMAT}
        garbage = man.get("garbage", []) + [{"id": s["id"], "since": time.time()} for s in merge]
        kept = [s for s in man["segments"] if s["id"] not in merge_ids]
        new_man = dict(man, segments=sorted(kept + [info], key=lambda s: s["min_seq"]), garbage=garbage)
        try:
            manifest_mod.write(self.store, ns, new_man, man_etag)
        except PreconditionFailed:
            self.lost_manifest_races += 1
            self.store.delete_prefix(keys.segment_prefix(ns, seg_id))
            return
        self.compactions += 1
        self.event("compacted", ns, segments=len(merge), rows=live, kept=len(kept),
                   ms=round((time.perf_counter() - t0) * 1000), segment=seg_id)

    def _collect_garbage(self, ns: str, man: dict) -> dict:
        """Delete replaced segments once they've been unreferenced for gc_delay_s.

        A query that read the old manifest a moment ago may still be fetching
        the old segment's files, so we wait before deleting them. The new
        manifest written by this pass then omits them from "garbage".
        """
        keep, now = [], time.time()
        for g in man.get("garbage", []):
            if now - g["since"] >= self.s.gc_delay_s:
                self.store.delete_prefix(keys.segment_prefix(ns, g["id"]))
            else:
                keep.append(g)
        return dict(man, garbage=keep)

    # --- console ---------------------------------------------------------------------------

    def stats(self) -> dict:
        return {
            "node": self.worker, "role": "indexer", "uptime_s": round(time.time() - self.started_at),
            "passes": self.passes, "compactions": self.compactions,
            "lost_manifest_races": self.lost_manifest_races, "current": self.current,
            "last_pass": self.last_pass, "store_totals": dict(self.store.totals),
            "store_rate_10s": dict(self.store.request_rate(10)), "cache": self.cache.snapshot(),
            "events": self.events[-100:],
        }
