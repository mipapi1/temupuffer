"""The query node's brain: write, query, metadata, list, delete, warm.

A query node is stateless apart from its cache. Everything here can be
rebuilt from the bucket, which is why any node can serve any namespace and
why killing a node loses nothing that was acknowledged (Architecture docs:
"any node can serve any namespace"). What lives in memory:

    MetaCache     meta.json per namespace (5 s TTL)
    WalWriter     one group-commit thread per namespace
    ViewManager   the cached view per namespace (what eventual reads reuse)
    NodeCache     memory + disk cache of immutable objects
"""

from __future__ import annotations

import collections
import contextvars
import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from . import jobqueue, keys, manifest as manifest_mod, meta as meta_mod, wal
from .cache import CacheStats, NodeCache, current_cache_stats
from .config import Settings
from .errors import Backpressure, BadRequest, NamespaceNotFound
from .query import QueryRunner
from .schema import VECTOR_ATTR, columns_to_rows, validate_attr_name, validate_id
from .storage import NotFound, ObjectStore, RequestStats, current_stats
from .views import ViewManager

WRITE_KEYS = {"upsert_rows", "upsert_columns", "deletes", "distance_metric", "schema", "disable_backpressure"}
UNSUPPORTED_WRITE_KEYS = {"patch_rows", "patch_columns", "delete_by_filter", "patch_by_filter",
                          "upsert_condition", "patch_condition", "delete_condition", "copy_from_namespace",
                          "branch_from_namespace", "encryption", "sharding"}


class Engine:
    def __init__(self, settings: Settings, store: ObjectStore, role: str = "query"):
        self.s = settings
        self.store = store
        self.role = role
        self.started_at = time.time()
        self.pool = ThreadPoolExecutor(max_workers=32, thread_name_prefix="io")
        self.cache = NodeCache(store, settings.cache_dir, settings.cache_disk_bytes, settings.cache_memory_bytes)
        self.metas = meta_mod.MetaCache(store)
        self.views = ViewManager(store, self.cache, self.pool)
        self.writers: dict[str, wal.WalWriter] = {}
        self.writers_lock = threading.Lock()
        self.events: collections.deque = collections.deque(maxlen=300)  # the console's activity feed
        self.query_count = 0
        self.write_count = 0
        self.rejected_429 = 0

    def event(self, kind: str, ns: str, **detail) -> None:
        self.events.append({"t": time.time(), "node": self.s.node_id, "kind": kind, "ns": ns, **detail})

    # --- writes ---------------------------------------------------------------------

    def _writer(self, ns: str) -> wal.WalWriter:
        with self.writers_lock:
            w = self.writers.get(ns)
            if w is None:
                def hint(ns=ns):
                    v = self.views.get(ns)
                    return v.cursor if v else manifest_mod.read(self.store, ns)[0]["cursor"]

                def on_commit(entry, nbytes, etag, ns=ns):
                    if self.s.view_includes_own_writes:
                        self.views.add_own_commit(ns, entry, nbytes, etag)
                    jobqueue.enqueue(self.store, ns)  # tell the indexers there's work
                    self.event("wal_commit", ns, seq=entry["seq"], rows=wal.entry_rows(entry), bytes=nbytes,
                               requests=len(entry["batches"]))

                w = wal.WalWriter(self.store, ns, self.s.node_id, self.s.wal_min_gap_s,
                                  self.s.wal_max_entry_bytes, head_hint=hint, on_commit=on_commit)
                self.writers[ns] = w
            return w

    def write(self, ns: str, body: dict) -> dict:
        t0 = time.perf_counter()
        if not keys.valid_namespace(ns):
            raise BadRequest("namespace names must match [A-Za-z0-9-_.]{1,128}")
        if not isinstance(body, dict):
            raise BadRequest("request body must be a JSON object")
        bad = set(body) & UNSUPPORTED_WRITE_KEYS
        if bad:
            raise BadRequest(f"{sorted(bad)} not supported by temupuffer (see docs/compat.md)")
        unknown = set(body) - WRITE_KEYS
        if unknown:
            raise BadRequest(f"unknown write parameter(s) {sorted(unknown)}")

        upserts = list(body.get("upsert_rows") or [])
        if body.get("upsert_columns"):
            upserts += columns_to_rows(body["upsert_columns"])
        deletes = list(body.get("deletes") or [])
        seen = set()
        for row in upserts:
            if not isinstance(row, dict) or "id" not in row:
                raise BadRequest("every upsert row needs an 'id'")
            validate_id(row["id"])
            for name in row:
                validate_attr_name(name)
            if row["id"] in seen:
                raise BadRequest(f"duplicate id {row['id']!r} in one request")  # Write docs: 400
            seen.add(row["id"])
        for doc_id in deletes:
            validate_id(doc_id)
            if doc_id in seen:
                raise BadRequest(f"id {doc_id!r} appears more than once in one request")
            seen.add(doc_id)
        if not upserts and not deletes and "schema" not in body:
            raise BadRequest("nothing to write: pass upsert_rows, upsert_columns, deletes or schema")

        meta = self.metas.ensure(ns, upserts, body.get("distance_metric"), body.get("schema"))
        if not upserts and not deletes:
            return {"rows_affected": 0, "performance": {"server_total_ms": round((time.perf_counter() - t0) * 1000)}}

        # Backpressure (Write docs): 429 once unindexed data passes the limit,
        # unless disable_backpressure is set (allowed for upserts and deletes by id).
        if not body.get("disable_backpressure"):
            view = self.views.get(ns)
            if view is None or view.age_s() > 1.0:
                view = self.views.refresh(ns)
            if view.unindexed_rows >= self.s.backpressure_max_unindexed_rows or \
                    view.unindexed_bytes >= self.s.backpressure_max_unindexed_bytes:
                self.rejected_429 += 1
                self.event("backpressure_429", ns, unindexed_rows=view.unindexed_rows,
                           unindexed_bytes=view.unindexed_bytes)
                raise Backpressure(
                    f"too much unindexed data: {view.unindexed_rows} rows / {view.unindexed_bytes} bytes "
                    f"(limits {self.s.backpressure_max_unindexed_rows} rows / "
                    f"{self.s.backpressure_max_unindexed_bytes} bytes). Retry with backoff once the indexer "
                    "catches up, or set disable_backpressure.")

        batch = {"upserts": upserts, "deletes": deletes}
        nbytes = len(json.dumps(batch, separators=(",", ":")))
        if nbytes > self.s.max_request_bytes:
            raise BadRequest(f"request is {nbytes} bytes; the limit is {self.s.max_request_bytes}")
        t_commit = time.perf_counter()
        seq = self._writer(ns).submit(batch, nbytes)
        self.write_count += 1
        out = {"rows_affected": len(upserts) + len(deletes)}
        if upserts:
            out["rows_upserted"] = len(upserts)
        if deletes:
            out["rows_deleted"] = len(deletes)
        out["billing"] = {"billable_logical_bytes_written": nbytes}
        out["performance"] = {"server_total_ms": round((time.perf_counter() - t0) * 1000)}
        # Not in turbopuffer's response: which WAL entry this write landed in, and
        # how long it waited for the group commit.
        out["temupuffer"] = {"wal_seq": seq, "commit_wait_ms": round((time.perf_counter() - t_commit) * 1000),
                             "node": self.s.node_id, "distance_metric": meta.get("distance_metric")}
        return out

    # --- queries --------------------------------------------------------------------

    def query(self, ns: str, body: dict) -> dict:
        t0 = time.perf_counter()
        if not isinstance(body, dict):
            raise BadRequest("request body must be a JSON object")
        level, staleness = self._consistency(body.get("consistency"))
        stats, cstats = RequestStats(), CacheStats()
        tok1, tok2 = current_stats.set(stats), current_cache_stats.set(cstats)
        try:
            got = self.metas.get(ns)
            if got is None:
                raise NamespaceNotFound(f"namespace {ns!r} not found")
            meta = got[0]
            view = self.views.for_query(ns, level, staleness)
            # Write docs: with disable_backpressure, strong queries return errors
            # above the backpressure limits. Ordinary writes can overshoot the
            # limit by one batch before the 429 kicks in, so we only refuse at
            # 2x the limit. That factor is our choice, not documented.
            if level == "strong" and (view.unindexed_rows > self.s.backpressure_max_unindexed_rows * 2 or
                                      view.unindexed_bytes > self.s.backpressure_max_unindexed_bytes * 2):
                raise Backpressure("too much unindexed data for a strong query; use consistency eventual")
            max_tail = self.s.eventual_max_unindexed_bytes if level == "eventual" else None
            try:
                snap = self.views.snapshot(view, max_tail)
            except NotFound:
                # A segment named by an old cached manifest was garbage-collected
                # (possible with a long max_staleness_seconds). Refresh and retry once.
                view = self.views.refresh(ns)
                snap = self.views.snapshot(view, max_tail)
            t_exec = time.perf_counter()
            if "queries" in body:
                subs = body["queries"]
                if not isinstance(subs, list) or not (1 <= len(subs) <= 16):
                    raise BadRequest("queries must be a list of 1 to 16 query objects")
                # Query docs: all subqueries share one snapshot.
                runners = [QueryRunner(snap, meta, self.s) for _ in subs]
                results = [r.run(q) for r, q in zip(runners, subs)]
                out = {"results": results}
                exhaustive = max(r.exhaustive for r in runners)
            else:
                runner = QueryRunner(snap, meta, self.s)
                out = runner.run({k: v for k, v in body.items() if k != "consistency"})
                exhaustive = runner.exhaustive
            exec_ms = (time.perf_counter() - t_exec) * 1000
        finally:
            current_stats.reset(tok1)
            current_cache_stats.reset(tok2)
        self.query_count += 1
        total_ms = (time.perf_counter() - t0) * 1000
        out["performance"] = {
            # The turbopuffer field names (Query docs, response).
            "cache_hit_ratio": cstats.hit_ratio(),
            "cache_temperature": cstats.temperature(),
            "server_total_ms": round(total_ms, 2),
            "query_execution_ms": round(exec_ms, 2),
            "exhaustive_search_count": exhaustive,
            "approx_namespace_size": snap.approx_size,
            # temupuffer extras: where the time went.
            "object_storage_round_trips": stats.round_trips,
            "object_storage_requests": dict(stats.by_op),
            "consistency": level,
            "view_age_ms": round(view.age_s() * 1000) if level == "eventual" else 0,
            "index_cursor": view.cursor,
            "wal_head": view.head,
            "unindexed_entries_scanned": len(snap.tail_entries),
            "unindexed_entries_skipped": snap.tail_skipped_entries,
            "segments_searched": len(snap.segments),
            "node": self.s.node_id,
        }
        self.event("query", ns, level=level, ms=round(total_ms, 1), temperature=cstats.temperature(),
                   round_trips=stats.round_trips, exhaustive=exhaustive)
        return out

    def _consistency(self, c) -> tuple[str, float]:
        if c is None:
            return "strong", 0.0
        if not isinstance(c, dict) or c.get("level") not in ("strong", "eventual"):
            raise BadRequest('consistency must be {"level": "strong"} or {"level": "eventual"}')
        staleness = c.get("max_staleness_seconds", self.s.eventual_max_staleness_s)
        if not isinstance(staleness, (int, float)) or not (0 <= staleness <= 3600):
            raise BadRequest("max_staleness_seconds must be between 0 and 3600")
        return c["level"], float(staleness)

    # --- metadata, list, delete, warm -------------------------------------------------

    def metadata(self, ns: str) -> dict:
        got = self.metas.get(ns, fresh=True)
        if got is None:
            raise NamespaceNotFound(f"namespace {ns!r} not found")
        meta = got[0]
        view = self.views.refresh(ns)
        man = view.manifest
        tail_upserts = sum(len(b.get("upserts", [])) for t in view.tail for b in t.entry["batches"])
        indexed_rows = sum(s.get("live_rows", s.get("rows", 0)) for s in man["segments"])
        out = {
            "schema": {k: v for k, v in meta["schema"].items() if k != "id" or v.get("type") != "auto"},
            "approx_logical_bytes": sum(s.get("bytes", 0) for s in man["segments"]) + view.unindexed_bytes,
            "approx_row_count": indexed_rows + tail_upserts,
            "created_at": meta["created_at"],
            "updated_at": meta["updated_at"],
            "last_write_at": view.tail[-1].entry["committed_at"] if view.tail else man.get("updated_at"),
            "index": {"status": "updating" if view.tail else "up-to-date"},
            # temupuffer extras
            "distance_metric": meta.get("distance_metric"),
            "dims": meta.get("dims"),
            "temupuffer": {"index_cursor": view.cursor, "wal_head": view.head,
                           "segments": len(man["segments"]), "manifest_version": man.get("version", 0)},
        }
        if view.tail:
            # Metadata docs: unindexed_bytes / unindexed_rows appear only while updating.
            out["index"]["unindexed_bytes"] = view.unindexed_bytes
            out["index"]["unindexed_rows"] = view.unindexed_rows
        return out

    def list_namespaces(self, prefix: str = "", cursor: str | None = None, page_size: int = 100) -> dict:
        page_size = max(1, min(int(page_size), 1000))
        _, prefixes = self.store.list(keys.NS_ROOT, delimiter="/")
        names = sorted(p[len(keys.NS_ROOT):-1] for p in prefixes)
        names = [n for n in names if n.startswith(prefix) and (cursor is None or n > cursor)]
        out = {"namespaces": [{"id": n} for n in names[:page_size]]}
        if len(names) > page_size:
            out["next_cursor"] = names[page_size - 1]
        return out

    def delete_namespace(self, ns: str) -> dict:
        if meta_mod.read(self.store, ns) is None:
            raise NamespaceNotFound(f"namespace {ns!r} not found")
        # meta.json goes first, so other nodes stop treating the namespace as
        # existing as early as possible. Then everything else under the prefix.
        self.store.delete(keys.meta(ns))
        deleted = 1 + self.store.delete_prefix(keys.ns_prefix(ns))
        jobqueue.remove(self.store, ns)
        self.metas.forget(ns)
        self.views.forget(ns)
        self.cache.drop_prefix(f"seg:{ns}/")
        with self.writers_lock:
            w = self.writers.get(ns)
            if w:
                w.reset()
        self.event("namespace_deleted", ns, objects=deleted)
        return {"status": "ok", "temupuffer": {"objects_deleted": deleted}}

    def warm(self, ns: str) -> dict:
        """hint_cache_warm: load the namespace into this node's cache in the background."""
        if self.metas.get(ns) is None:
            raise NamespaceNotFound(f"namespace {ns!r} not found")

        def run():
            t0 = time.perf_counter()
            view = self.views.refresh(ns)
            self.views.snapshot(view, None)
            self.event("cache_warmed", ns, ms=round((time.perf_counter() - t0) * 1000))

        ctx = contextvars.Context()  # don't count this against any request
        threading.Thread(target=lambda: ctx.run(run), daemon=True).start()
        return {"status": "ACCEPTED", "message": "cache warm hint accepted"}

    # --- the console's "under the hood" data ---------------------------------------------

    def node_stats(self) -> dict:
        with self.writers_lock:
            writers = {ns: {"entries_written": w.entries_written, "lost_races": w.lost_races,
                            "queue_depth": w.queue_depth(), "last_commit_ms": round(w.last_commit_ms, 1),
                            "last_batch_requests": w.last_batch_requests, "known_head": w.known_head}
                       for ns, w in self.writers.items()}
        with self.views.lock:
            views = {ns: {"cursor": v.cursor, "head": v.head, "age_s": round(v.age_s(), 1),
                          "unindexed_rows": v.unindexed_rows} for ns, v in self.views.views.items()}
        return {
            "node": self.s.node_id, "role": self.role, "uptime_s": round(time.time() - self.started_at),
            "store_totals": dict(self.store.totals), "store_rate_10s": dict(self.store.request_rate(10)),
            "cache": self.cache.snapshot(), "writers": writers, "views": views,
            "queries": self.query_count, "writes": self.write_count, "rejected_429": self.rejected_429,
            "events": list(self.events)[-100:],
            "config": {"wal_min_gap_s": self.s.wal_min_gap_s,
                       "backpressure_max_unindexed_rows": self.s.backpressure_max_unindexed_rows,
                       "backpressure_max_unindexed_bytes": self.s.backpressure_max_unindexed_bytes,
                       "eventual_max_staleness_s": self.s.eventual_max_staleness_s,
                       "eventual_max_unindexed_bytes": self.s.eventual_max_unindexed_bytes},
        }

    def wal_state(self, ns: str, limit: int = 400) -> dict:
        """Every WAL entry (newest `limit`), whether it's indexed, plus the manifest. For the WAL strip."""
        if self.metas.get(ns) is None:
            raise NamespaceNotFound(f"namespace {ns!r} not found")
        man, _ = manifest_mod.read(self.store, ns)
        objs = wal.list_entries(self.store, ns, max(-1, man["cursor"] - limit))
        view = self.views.refresh(ns)
        rows_by_seq = {t.seq: t.rows for t in view.tail}
        entries = [{"seq": keys.wal_seq(o.key), "bytes": o.size, "at": o.last_modified,
                    "indexed": keys.wal_seq(o.key) <= man["cursor"],
                    "rows": rows_by_seq.get(keys.wal_seq(o.key))} for o in objs][-limit:]
        return {"namespace": ns, "cursor": man["cursor"], "head": view.head, "entries": entries,
                "manifest": man, "unindexed_rows": view.unindexed_rows, "unindexed_bytes": view.unindexed_bytes}
