"""SearchBackend: the only way the app talks to a database.

Two implementations with one contract:
  * TemupufferBackend   plain HTTP to temupuffer's /v2 and /v1 API
  * TurbopufferBackend  the official `turbopuffer` Python SDK

Both take and return plain dicts in turbopuffer's wire shape (rank_by, filters,
rows with "$dist", "performance"), so everything above this file is
backend-agnostic. Switching is configuration: BACKEND=temupuffer|turbopuffer.
"""

from __future__ import annotations

import hashlib
import time
from abc import ABC, abstractmethod
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import httpx

from .config import Settings


class Backpressure(Exception):
    """The database refused a write with 429: too much unindexed data. Retry later."""


class BackendError(Exception):
    pass


class SearchBackend(ABC):
    name: str

    @abstractmethod
    def write(self, ns: str, *, upsert_rows: list[dict] | None = None, deletes: list | None = None,
              schema: dict | None = None, distance_metric: str | None = None) -> dict: ...

    @abstractmethod
    def query(self, ns: str, body: dict) -> dict:
        """One query. Returns {"rows": [...], "performance": {...}, "client_ms": float}."""

    @abstractmethod
    def multi_query(self, ns: str, queries: list[dict], consistency: dict | None = None) -> dict:
        """Several queries on one snapshot. Returns {"results": [{"rows": ...}, ...], "performance", "client_ms"}."""

    @abstractmethod
    def metadata(self, ns: str) -> dict | None:
        """Namespace metadata, or None if the namespace doesn't exist."""

    @abstractmethod
    def delete_namespace(self, ns: str) -> None: ...

    def close(self) -> None:
        pass


# --- temupuffer ---------------------------------------------------------------------------


class TemupufferBackend(SearchBackend):
    name = "temupuffer"

    def __init__(self, url: str, api_key: str, timeout: float = 120.0, transport: httpx.BaseTransport | None = None):
        self.http = httpx.Client(base_url=url, headers={"Authorization": f"Bearer {api_key}"}, timeout=timeout,
                                 limits=httpx.Limits(max_connections=64, max_keepalive_connections=32),
                                 transport=transport)

    def _post(self, path: str, body: dict) -> dict:
        t0 = time.perf_counter()
        r = self.http.post(path, json=body)
        client_ms = (time.perf_counter() - t0) * 1000
        if r.status_code == 429:
            raise Backpressure(r.json().get("error", "429 backpressure"))
        if r.status_code >= 400:
            raise BackendError(f"temupuffer {r.status_code}: {r.text[:300]}")
        out = r.json()
        out["client_ms"] = round(client_ms, 2)
        out["routed_to"] = r.headers.get("x-temupuffer-upstream")
        return out

    def write(self, ns, *, upsert_rows=None, deletes=None, schema=None, distance_metric=None):
        body: dict[str, Any] = {}
        if upsert_rows:
            body["upsert_rows"] = upsert_rows
        if deletes:
            body["deletes"] = deletes
        if schema:
            body["schema"] = schema
        if distance_metric:
            body["distance_metric"] = distance_metric
        return self._post(f"/v2/namespaces/{ns}", body)

    def query(self, ns, body):
        return self._post(f"/v2/namespaces/{ns}/query", body)

    def multi_query(self, ns, queries, consistency=None):
        body: dict[str, Any] = {"queries": queries}
        if consistency:
            body["consistency"] = consistency
        return self._post(f"/v2/namespaces/{ns}/query", body)

    def metadata(self, ns):
        r = self.http.get(f"/v1/namespaces/{ns}/metadata")
        if r.status_code == 404:
            return None
        if r.status_code >= 400:
            raise BackendError(f"temupuffer {r.status_code}: {r.text[:300]}")
        return r.json()

    def delete_namespace(self, ns):
        r = self.http.delete(f"/v2/namespaces/{ns}")
        if r.status_code not in (200, 404):
            raise BackendError(f"temupuffer {r.status_code}: {r.text[:300]}")

    def close(self):
        self.http.close()


# --- turbopuffer --------------------------------------------------------------------------


class TurbopufferBackend(SearchBackend):
    """Real turbopuffer via its SDK. Every namespace name gets `prefix` (default "demo-")."""

    name = "turbopuffer"

    def __init__(self, api_key: str, region: str, prefix: str = "demo-", client: Any = None):
        if not prefix:
            raise ValueError("refusing to run against turbopuffer without a namespace prefix")
        self.prefix = prefix
        if client is None:
            import turbopuffer

            client = turbopuffer.Turbopuffer(api_key=api_key, region=region)
        self.client = client

    def _ns(self, ns: str):
        return self.client.namespace(self.prefix + ns)

    @staticmethod
    def _plain(resp: Any) -> dict:
        return resp.to_dict() if hasattr(resp, "to_dict") else dict(resp)

    def _call(self, fn, **kw) -> dict:
        import turbopuffer

        t0 = time.perf_counter()
        try:
            resp = fn(**kw)
        except turbopuffer.RateLimitError as e:
            raise Backpressure(str(e)) from e
        except turbopuffer.APIError as e:
            raise BackendError(f"turbopuffer: {e}") from e
        out = self._plain(resp)
        out["client_ms"] = round((time.perf_counter() - t0) * 1000, 2)
        return out

    def write(self, ns, *, upsert_rows=None, deletes=None, schema=None, distance_metric=None):
        kw: dict[str, Any] = {}
        if upsert_rows:
            kw["upsert_rows"] = upsert_rows
        if deletes:
            kw["deletes"] = deletes
        if schema:
            kw["schema"] = schema
        if distance_metric:
            kw["distance_metric"] = distance_metric
        return self._call(self._ns(ns).write, **kw)

    def query(self, ns, body):
        return self._call(self._ns(ns).query, **body)

    def multi_query(self, ns, queries, consistency=None):
        kw: dict[str, Any] = {"queries": queries}
        if consistency:
            kw["consistency"] = consistency
        return self._call(self._ns(ns).multi_query, **kw)

    def metadata(self, ns):
        import turbopuffer

        try:
            return self._plain(self._ns(ns).metadata())
        except turbopuffer.NotFoundError:
            return None

    def delete_namespace(self, ns):
        import turbopuffer

        try:
            self._ns(ns).delete_all()
        except turbopuffer.NotFoundError:
            pass


# --- sharding: one logical namespace over several real ones --------------------------------


_TEMPERATURE = {"hot": 0, "warm": 1, "cold": 2}


def _id_hash(doc_id: Any) -> int:
    if isinstance(doc_id, int):
        return doc_id
    return int.from_bytes(hashlib.blake2b(str(doc_id).encode(), digest_size=8).digest(), "big")


def _sort_key(rank_by: Any):
    """How to merge the shards' rows so the result is what one namespace would return."""
    if isinstance(rank_by, list) and rank_by and rank_by[0] == "vector":
        return lambda r: r.get("$dist", 0.0), False                     # distance: smaller is better
    if (isinstance(rank_by, list) and len(rank_by) == 2 and all(isinstance(x, str) for x in rank_by)
            and rank_by[1] in ("asc", "desc")):
        attr = rank_by[0]
        return (lambda r: (r.get(attr) is None, r.get(attr))), rank_by[1] == "desc"
    return lambda r: r.get("$dist", 0.0), True                          # BM25 score: larger is better


def _merge_rows(per_shard: list[list[dict]], rank_by: Any, top_k: int) -> list[dict]:
    key, reverse = _sort_key(rank_by)
    rows = [r for rows in per_shard for r in rows]
    rows.sort(key=key, reverse=reverse)
    return rows[:top_k]


def _merge_perf(perfs: list[dict]) -> dict:
    """The shards ran in parallel: time = the slowest shard, work (rows scanned, round trips) = the sum."""
    perfs = [p for p in perfs if p]
    if not perfs:
        return {}
    out = dict(perfs[0])
    for k in ("server_total_ms", "query_execution_ms", "view_age_ms"):
        vals = [p[k] for p in perfs if p.get(k) is not None]
        if vals:
            out[k] = max(vals)
    for k in ("exhaustive_search_count", "approx_namespace_size", "object_storage_round_trips",
              "unindexed_entries_scanned", "unindexed_entries_skipped", "segments_searched"):
        vals = [p[k] for p in perfs if p.get(k) is not None]
        if vals:
            out[k] = sum(vals)
    ratios = [p["cache_hit_ratio"] for p in perfs if p.get("cache_hit_ratio") is not None]
    if ratios:
        out["cache_hit_ratio"] = round(sum(ratios) / len(ratios), 3)
    temps = [p["cache_temperature"] for p in perfs if p.get("cache_temperature") in _TEMPERATURE]
    if temps:
        out["cache_temperature"] = max(temps, key=_TEMPERATURE.__getitem__)  # the coldest shard
    nodes = [p.get("node") for p in perfs if p.get("node")]
    if nodes:
        out["node"] = ", ".join(nodes)
    out["shards"] = perfs
    return out


class ShardedBackend(SearchBackend):
    """One logical namespace stored as several namespaces, e.g. arxiv -> arxiv-a + arxiv-b.

    Why: a temupuffer query pod keeps every segment of a namespace it serves in RAM, and
    namespace affinity sends a whole namespace to one pod. 1M arXiv rows (~5 GiB) don't fit
    one pod; two 500k shards that hash to different pods do. (turbopuffer doesn't need this
    for 1M rows. Splitting a dataset over namespaces is still a pattern people use there, e.g.
    one namespace per tenant, with the app querying several and merging.)

    Writes: each doc goes to shard `id % n`, so an id always lives in exactly one shard and an
    upsert or delete finds it. Queries: every shard in parallel, then merge by $dist (or the
    order_by attribute) and cut to top_k. Vector distances compare exactly across shards.
    BM25 scores are close but not identical: each shard computes IDF from its own documents.
    With a random split of 500k docs each, the difference is small.

    Not atomic across shards: a batch can land in shard a and get a 429 from shard b. The
    caller retries the whole batch, which re-upserts the same ids into a (harmless).
    """

    def __init__(self, inner: SearchBackend, logical: str, shards: list[str]):
        if len(shards) < 2:
            raise ValueError("ShardedBackend needs at least two shard namespaces")
        self.inner = inner
        self.name = inner.name
        self.logical = logical
        self.shards = shards
        self.pool = ThreadPoolExecutor(max_workers=max(8, 4 * len(shards)), thread_name_prefix="shard")

    def _targets(self, ns: str) -> list[str]:
        return self.shards if ns == self.logical else [ns]

    def _fan(self, ns: str, fn) -> list:
        targets = self._targets(ns)
        if len(targets) == 1:
            return [fn(targets[0])]
        return list(self.pool.map(fn, targets))

    def write(self, ns, *, upsert_rows=None, deletes=None, schema=None, distance_metric=None):
        if ns != self.logical:
            return self.inner.write(ns, upsert_rows=upsert_rows, deletes=deletes, schema=schema,
                                    distance_metric=distance_metric)
        n = len(self.shards)
        ups: list[list[dict]] = [[] for _ in range(n)]
        dels: list[list] = [[] for _ in range(n)]
        for r in upsert_rows or []:
            ups[_id_hash(r["id"]) % n].append(r)
        for d in deletes or []:
            dels[_id_hash(d) % n].append(d)
        jobs = [(self.shards[i], ups[i], dels[i]) for i in range(n) if ups[i] or dels[i]]
        t0 = time.perf_counter()
        results = list(self.pool.map(
            lambda j: self.inner.write(j[0], upsert_rows=j[1] or None, deletes=j[2] or None,
                                       schema=schema, distance_metric=distance_metric), jobs))
        return {"rows_affected": sum(r.get("rows_affected", 0) for r in results),
                "client_ms": round((time.perf_counter() - t0) * 1000, 2),
                "shards": {j[0]: r for j, r in zip(jobs, results)}}

    def query(self, ns, body):
        t0 = time.perf_counter()
        parts = self._fan(ns, lambda s: self.inner.query(s, body))
        if len(parts) == 1:
            return parts[0]
        out = {"rows": _merge_rows([p.get("rows", []) for p in parts], body.get("rank_by"),
                                   body.get("top_k", body.get("limit", 10))),
               "performance": _merge_perf([p.get("performance") or {} for p in parts]),
               "client_ms": round((time.perf_counter() - t0) * 1000, 2),
               "routed_to": ", ".join(str(p.get("routed_to")) for p in parts)}
        return out

    def multi_query(self, ns, queries, consistency=None):
        t0 = time.perf_counter()
        parts = self._fan(ns, lambda s: self.inner.multi_query(s, queries, consistency))
        if len(parts) == 1:
            return parts[0]
        results = []
        for i, q in enumerate(queries):
            per_shard = [(p.get("results") or [{}])[i].get("rows", []) if i < len(p.get("results") or []) else []
                         for p in parts]
            results.append({"rows": _merge_rows(per_shard, q.get("rank_by"), q.get("top_k", q.get("limit", 10)))})
        return {"results": results,
                "performance": _merge_perf([p.get("performance") or {} for p in parts]),
                "client_ms": round((time.perf_counter() - t0) * 1000, 2),
                "routed_to": ", ".join(str(p.get("routed_to")) for p in parts)}

    def metadata(self, ns):
        parts = self._fan(ns, self.inner.metadata)
        if len(parts) == 1:
            return parts[0]
        found = [(s, m) for s, m in zip(self._targets(ns), parts) if m is not None]
        if not found:
            return None
        out = dict(found[0][1])
        out["approx_row_count"] = sum(m.get("approx_row_count", 0) for _, m in found)
        if any("approx_logical_bytes" in m for _, m in found):
            out["approx_logical_bytes"] = sum(m.get("approx_logical_bytes", 0) for _, m in found)
        idx = [m.get("index") or {} for _, m in found]
        out["index"] = {
            "status": "up-to-date" if len(found) == len(parts) and all(i.get("status") == "up-to-date" for i in idx)
            else "updating",
            "unindexed_rows": sum(i.get("unindexed_rows", 0) for i in idx),
            "unindexed_bytes": sum(i.get("unindexed_bytes", 0) for i in idx),
        }
        out["shards"] = {s: m for s, m in found}
        return out

    def delete_namespace(self, ns):
        self._fan(ns, self.inner.delete_namespace)

    def close(self):
        self.pool.shutdown(wait=False)
        self.inner.close()


def make(name: str, s: Settings) -> SearchBackend:
    if name == "temupuffer":
        b: SearchBackend = TemupufferBackend(s.temupuffer_url, s.temupuffer_api_key)
        if len(s.temupuffer_shards) > 1:
            b = ShardedBackend(b, s.namespace, s.temupuffer_shards)
        return b
    if name == "turbopuffer":
        if not s.turbopuffer_enabled:
            raise BackendError("turbopuffer isn't configured: set TURBOPUFFER_API_KEY and TURBOPUFFER_REGION")
        return TurbopufferBackend(s.turbopuffer_api_key, s.turbopuffer_region, s.turbopuffer_prefix)
    raise BackendError(f"unknown backend {name!r} (use temupuffer or turbopuffer)")
