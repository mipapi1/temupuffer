"""A node's view of one namespace, and how strong and eventual reads differ.

A *view* is what this node believes the namespace looks like right now:

    manifest (segments + cursor)  +  the unindexed WAL tail (entries cursor+1 .. head)

Refreshing a view costs two small requests:

    1. GET manifest.json with If-None-Match: <etag we have>   -> usually 304, no body
    2. LIST wal/ StartAfter=<newest entry we know>            -> usually empty

plus one GET per WAL entry that's new to us (those are immutable, so
they're cached forever after that).

Strong (Query docs, consistency): "searches all unindexed writes". Every
strong query refreshes the view first, so it sees every write that was
acknowledged before the query started. Those two round trips are the
consistency tax, turbopuffer's "~10 ms floor" on consistent reads.

Eventual: reuses the cached view if it's at most 60 s old (or the request's
max_staleness_seconds) and starts a refresh in the background, so the next
query is fresher. It also scans at most 128 MiB of the unindexed tail, oldest
first. A write made on *another* node can therefore be missed for a short
while. That's the trade: fewer round trips, a small chance of staleness.
"""

from __future__ import annotations

import contextvars
import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

import numpy as np

from . import keys, manifest as manifest_mod, segment as segment_mod, wal
from .cache import NodeCache
from .segment import Segment
from .storage import NotFound, NotModified, ObjectStore


@dataclass
class TailEntry:
    seq: int
    entry: dict
    nbytes: int
    rows: int
    etag: str = ""


@dataclass
class View:
    ns: str
    manifest: dict
    manifest_etag: str | None
    tail: list[TailEntry]
    fetched_at: float  # time.monotonic() of the last refresh against object storage
    _tail_latest: dict | None = field(default=None, repr=False)

    @property
    def cursor(self) -> int:
        return self.manifest["cursor"]

    @property
    def head(self) -> int:
        return self.tail[-1].seq if self.tail else self.cursor

    @property
    def unindexed_rows(self) -> int:
        return sum(t.rows for t in self.tail)

    @property
    def unindexed_bytes(self) -> int:
        return sum(t.nbytes for t in self.tail)

    def age_s(self) -> float:
        return time.monotonic() - self.fetched_at


class ViewManager:
    def __init__(self, store: ObjectStore, cache: NodeCache, pool: ThreadPoolExecutor):
        self.store = store
        self.cache = cache
        self.pool = pool
        self.views: dict[str, View] = {}
        self.lock = threading.Lock()
        self.refreshing: set[str] = set()
        # Live masks per (namespace, manifest version): which rows of each
        # segment are the newest version of their id. Recomputed only when the
        # manifest changes, not on every query.
        self._live_cache: dict[str, tuple[int, list[np.ndarray]]] = {}

    def _map(self, fn, items):
        """pool.map, but each task runs in a copy of the caller's context.

        Per-query counters (round trips, cache hits) live in contextvars, which
        don't follow work into a thread pool on their own.
        """
        ctx = contextvars.copy_context()
        return list(self.pool.map(lambda x: ctx.copy().run(fn, x), items))

    def get(self, ns: str) -> View | None:
        with self.lock:
            return self.views.get(ns)

    def forget(self, ns: str) -> None:
        with self.lock:
            self.views.pop(ns, None)
            self._live_cache.pop(ns, None)

    # --- refreshing ----------------------------------------------------------

    def refresh(self, ns: str) -> View:
        """Bring the view up to date with object storage (the strong path)."""
        old = self.get(ns)
        man, man_etag = (old.manifest, old.manifest_etag) if old else (manifest_mod.empty(), None)
        try:
            body, etag = self.store.get(keys.manifest(ns), if_none_match=man_etag) if man_etag else \
                self.store.get(keys.manifest(ns))
            man, man_etag = json.loads(body), etag
        except NotModified:
            pass  # 304: the manifest hasn't changed, keep ours
        except NotFound:
            man, man_etag = manifest_mod.empty(), None  # nothing indexed yet (or namespace deleted)

        # LIST the whole unindexed tail (everything after the cursor), not just
        # what's newer than our head. It's still one request, and it also tells
        # us if entries we cached have disappeared (the namespace was deleted).
        cursor = man["cursor"]
        objs = wal.list_entries(self.store, ns, cursor)
        # Entries are matched by (seq, etag), not seq alone: if a namespace is
        # deleted and recreated, seq 5 can come back with different content.
        cached = {(t.seq, t.etag): t for t in (old.tail if old else [])}
        missing = [o for o in objs if (keys.wal_seq(o.key), o.etag) not in cached]
        loaded = dict(zip([o.key for o in missing], self._map(self._load_entry, missing))) if missing else {}
        tail = []
        for o in objs:
            seq = keys.wal_seq(o.key)
            if (seq, o.etag) in cached:
                tail.append(cached[(seq, o.etag)])
            else:
                e, size = loaded[o.key]
                tail.append(TailEntry(seq, e, size, wal.entry_rows(e), o.etag))
        view = View(ns, man, man_etag, tail, time.monotonic())
        with self.lock:
            self.views[ns] = view
        return view

    def _load_entry(self, obj) -> tuple[dict, int]:
        def parse(body: bytes):
            return json.loads(body), len(body)

        return self.cache.load(obj.key, parse, etag=obj.etag)  # type: ignore[return-value]

    def refresh_in_background(self, ns: str) -> None:
        with self.lock:
            if ns in self.refreshing:
                return
            self.refreshing.add(ns)

        def run():
            try:
                self.refresh(ns)
            except Exception as e:
                print(f"[view {ns}] background refresh failed: {e!r}")
            finally:
                with self.lock:
                    self.refreshing.discard(ns)

        threading.Thread(target=run, daemon=True).start()

    def for_query(self, ns: str, level: str, max_staleness_s: float) -> View:
        if level == "strong":
            return self.refresh(ns)
        view = self.get(ns)
        if view is None or view.age_s() > max_staleness_s:
            return self.refresh(ns)  # nothing usable cached: this eventual query pays like a strong one
        if view.age_s() > 1.0:
            self.refresh_in_background(ns)
        return view

    def add_own_commit(self, ns: str, entry: dict, nbytes: int, etag: str) -> None:
        """This node just committed an entry. If it directly follows our view's head, append it."""
        with self.lock:
            view = self.views.get(ns)
            if view is None or entry["seq"] != view.head + 1:
                return
            tail = view.tail + [TailEntry(entry["seq"], entry, nbytes, wal.entry_rows(entry), etag)]
            self.views[ns] = View(ns, view.manifest, view.manifest_etag, tail, view.fetched_at)

    # --- segments + snapshot ---------------------------------------------------

    def load_segment(self, ns: str, seg_id: str, remember: bool = True, fmt: int = 1) -> Segment:
        """fmt is the segment's "format" in the manifest (absent = 1): it decides which files exist."""
        file_keys = [keys.segment_file(ns, seg_id, f) for f in segment_mod.files_for(fmt)]

        def parse_all(files: dict[str, bytes]) -> Segment:
            by_name = {k.rsplit("/", 1)[1]: v for k, v in files.items()}
            return segment_mod.parse(seg_id, by_name)

        return self.cache.load_many(f"seg:{ns}/{seg_id}", file_keys, parse_all, remember)  # type: ignore

    def snapshot(self, view: View, max_tail_bytes: int | None) -> "Snapshot":
        segs = self._map(lambda s: self.load_segment(view.ns, s["id"], fmt=s.get("format", 1)), view.manifest["segments"])
        live = self._live_masks(view, segs)
        return Snapshot(view, segs, live, max_tail_bytes)

    def _live_masks(self, view: View, segs: list[Segment]) -> list[np.ndarray]:
        """For each segment: True where the row is the newest version of its id and not a tombstone."""
        version_key = view.manifest.get("version", 0)
        with self.lock:
            hit = self._live_cache.get(view.ns)
        if hit and hit[0] == version_key and len(hit[1]) == len(segs):
            return hit[1]
        newest: dict = {}  # id -> (version, segment index, position)
        for si, seg in enumerate(segs):
            for pos, (doc_id, v) in enumerate(zip(seg.ids, seg.versions.tolist())):
                cur = newest.get(doc_id)
                if cur is None or v > cur[0]:
                    newest[doc_id] = (v, si, pos)
        masks = [np.zeros(seg.count, dtype=bool) for seg in segs]
        for v, si, pos in newest.values():
            if not segs[si].deleted[pos]:
                masks[si][pos] = True
        with self.lock:
            self._live_cache[view.ns] = (version_key, masks)
        return masks


class Snapshot:
    """Everything one query reads, frozen: segments + live masks + the tail's latest rows."""

    def __init__(self, view: View, segs: list[Segment], seg_live: list[np.ndarray], max_tail_bytes: int | None):
        self.view = view
        self.segments = segs
        # Eventual reads scan at most max_tail_bytes of the tail, oldest entries first.
        tail = view.tail
        scanned_bytes = 0
        if max_tail_bytes is not None:
            cut = []
            for t in tail:
                if scanned_bytes + t.nbytes > max_tail_bytes and cut:
                    break
                cut.append(t)
                scanned_bytes += t.nbytes
            tail = cut
        else:
            scanned_bytes = sum(t.nbytes for t in tail)
        self.tail_entries = tail
        self.tail_bytes = scanned_bytes
        self.tail_skipped_entries = len(view.tail) - len(tail)
        latest = segment_mod.resolve_latest([op for t in tail for op in wal.iter_ops(t.entry)])
        # The tail is newer than every segment (seq > cursor), so any id
        # that appears in it shadows the segment copies.
        self.live = [m.copy() for m in seg_live]
        for doc_id in latest:
            for si, seg in enumerate(segs):
                pos = seg.position.get(doc_id)
                if pos is not None:
                    self.live[si][pos] = False
        self.tail_docs: list[dict] = [row for (_, row) in latest.values() if row is not None]
        self.tail_versions: list[int] = [v for (v, row) in latest.values() if row is not None]

    @property
    def approx_size(self) -> int:
        return int(sum(int(m.sum()) for m in self.live)) + len(self.tail_docs)
