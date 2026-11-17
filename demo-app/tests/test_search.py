import json

import httpx
import pyarrow as pa
import pytest
from fastapi.testclient import TestClient

from search import api, dataset, ingest
from search import queries as Q
from search.backends import Backpressure, TemupufferBackend, TurbopufferBackend
from search.service import SearchService, redact_vectors


# --- queries ---------------------------------------------------------------------------------

def test_filters_to_db():
    assert Q.Filters().to_db() is None
    assert Q.Filters(field="Mathematics").to_db() == ["field", "Eq", "Mathematics"]
    assert Q.Filters(field="Physics", year_min=2010, year_max=2020).to_db() == [
        "And", [["field", "Eq", "Physics"], ["year", "Gte", 2010], ["year", "Lte", 2020]]]


def test_rrf_rewards_docs_found_by_both():
    a = [{"id": 1}, {"id": 2}, {"id": 3}]
    b = [{"id": 3}, {"id": 4}, {"id": 1}]
    out = Q.rrf({"vector": a, "keyword": b}, limit=4)
    assert [r["id"] for r in out][:2] == [1, 3]          # in both lists beats a single #2
    assert out[0]["ranks"] == {"vector": 1, "keyword": 3}
    assert {r["id"] for r in out} == {1, 2, 3, 4}


def test_keyword_rank_weights_title():
    assert Q.keyword_rank("x") == ["Sum", [["Product", 2, ["title", "BM25", "x"]], ["abstract", "BM25", "x"]]]


# --- service ---------------------------------------------------------------------------------

def test_hybrid_search_is_one_multi_query_and_fuses(settings, embedder, backend):
    svc = SearchService(settings, embedder, {"temupuffer": backend})
    out = svc.search(Q.SearchRequest(q="dark matter", mode="hybrid", filters=Q.Filters(year_min=2015)))
    kind, ns, subs, cons = backend.calls[-1]
    assert kind == "multi_query" and ns == "arxiv-test" and cons == {"level": "strong"}
    assert subs[0]["rank_by"][:2] == ["vector", "ANN"] and subs[1]["rank_by"][0] == "Sum"
    assert all(s["filters"] == ["year", "Gte", 2015] and "consistency" not in s for s in subs)
    assert len(out["results"]) == 5 and set(out["results"][0]["ranks"]) == {"vector", "keyword"}
    # vectors are abbreviated in the request shown to the user
    assert "floats" in json.dumps(out["request"])


def test_keyword_search_does_not_embed(settings, backend):
    class Boom:
        def embed(self, *a, **k):
            raise AssertionError("keyword search must not call the embedder")
    svc = SearchService(settings, Boom(), {"temupuffer": backend})
    out = svc.search(Q.SearchRequest(q="lattice QCD", mode="keyword", consistency="eventual"))
    assert backend.calls[-1][2]["consistency"] == {"level": "eventual"}
    assert out["timing"]["embed_ms"] == 0


def test_write_then_read_cleans_up(settings, embedder, backend):
    svc = SearchService(settings, embedder, {"temupuffer": backend})
    out = svc.write_then_read()
    assert [s["step"] for s in out["steps"]] == ["write", "query (eventual)", "query (strong)", "delete probe"]
    assert len(backend.deleted) == 1 and backend.deleted[0] >= 9_000_000_000


def test_redact_vectors_keeps_shape():
    body = {"queries": [{"rank_by": ["vector", "ANN", [0.1] * 384]}, {"rank_by": ["title", "BM25", "x"]}]}
    r = redact_vectors(body)
    assert r["queries"][0]["rank_by"][2].endswith("384 floats]") and r["queries"][1] == body["queries"][1]


# --- API -------------------------------------------------------------------------------------

def test_api_search_compare_and_errors(settings, embedder, backend):
    app = api.create_app(SearchService(settings, embedder, {"temupuffer": backend}))
    c = TestClient(app)
    assert c.get("/api/config").json()["backends"] == ["temupuffer"]
    r = c.post("/api/search", json={"q": "graphs", "mode": "vector", "filters": {"field": "Mathematics"}})
    assert r.status_code == 200 and r.json()["results"]
    cmp = c.post("/api/compare", json={"q": "graphs"}).json()
    assert set(cmp["columns"]) == {"hybrid", "keyword", "vector"}
    assert c.post("/api/search", json={"q": "x", "mode": "fuzzy"}).status_code == 400
    assert c.post("/api/search", json={"q": "x", "backend": "turbopuffer"}).status_code == 502
    c.post("/api/ingest/progress", json={"acked": 10, "target": 100})
    assert c.get("/api/stats").json()["ingest"]["acked"] == 10


# --- backends --------------------------------------------------------------------------------

def test_temupuffer_backend_wire_format_and_429():
    seen = []

    def handler(req: httpx.Request):
        seen.append((req.method, req.url.path, req.headers.get("authorization"),
                     json.loads(req.content) if req.content else None))
        if req.url.path.endswith("/full"):
            return httpx.Response(429, json={"status": "error", "error": "backpressure"})
        if req.method == "GET":
            return httpx.Response(404, json={})
        return httpx.Response(200, json={"rows": [{"id": 1, "$dist": 0.2}], "performance": {"server_total_ms": 3}},
                              headers={"x-temupuffer-upstream": "10.0.0.1:8080"})

    b = TemupufferBackend("http://t", "k", transport=httpx.MockTransport(handler))
    out = b.multi_query("ns", [{"rank_by": ["id", "asc"]}], {"level": "eventual"})
    assert seen[-1][:3] == ("POST", "/v2/namespaces/ns/query", "Bearer k")
    assert seen[-1][3] == {"queries": [{"rank_by": ["id", "asc"]}], "consistency": {"level": "eventual"}}
    assert out["routed_to"] == "10.0.0.1:8080" and "client_ms" in out
    with pytest.raises(Backpressure):
        b.write("full", upsert_rows=[{"id": 1}])
    assert b.metadata("missing") is None


def test_turbopuffer_backend_prefixes_every_namespace():
    class FakeResp:
        def __init__(self, d):
            self.d = d

        def to_dict(self):
            return self.d

    class FakeNs:
        def __init__(self, name, log):
            self.name, self.log = name, log

        def query(self, **kw):
            self.log.append((self.name, "query", kw))
            return FakeResp({"rows": [{"id": 1, "$dist": 0.3}], "performance": {"server_total_ms": 9}})

        def multi_query(self, **kw):
            self.log.append((self.name, "multi_query", kw))
            return FakeResp({"results": [{"rows": []}], "performance": {}})

        def write(self, **kw):
            self.log.append((self.name, "write", kw))
            return FakeResp({"rows_affected": 1})

        def delete_all(self):
            self.log.append((self.name, "delete_all", {}))

    class FakeClient:
        def __init__(self):
            self.log = []

        def namespace(self, name):
            return FakeNs(name, self.log)

    fc = FakeClient()
    b = TurbopufferBackend("key", "gcp-us-central1", prefix="demo-", client=fc)
    b.query("arxiv", {"rank_by": ["title", "BM25", "x"], "top_k": 3, "consistency": {"level": "strong"}})
    b.multi_query("arxiv", [{"rank_by": ["title", "BM25", "x"]}], {"level": "eventual"})
    b.write("arxiv", upsert_rows=[{"id": 1}], distance_metric="cosine_distance")
    b.delete_namespace("arxiv")
    assert {name for name, _, _ in fc.log} == {"demo-arxiv"}
    assert fc.log[1][2] == {"queries": [{"rank_by": ["title", "BM25", "x"]}], "consistency": {"level": "eventual"}}
    with pytest.raises(ValueError):
        TurbopufferBackend("key", "r", prefix="", client=fc)


# --- dataset + load --------------------------------------------------------------------------

def test_to_doc_parses_year_field_and_skips_empty():
    rec = {"id": "0905.0034", "title": " A  title\n", "abstract": "Some  text", "authors": "A. B",
           "categories": "math.RT hep-th", "versions": [{"version": "v1", "created": "Fri, 01 May 2009 01:52:14 GMT"}]}
    d = dataset.to_doc(2, 7, rec)
    assert d["id"] == 2_000_007 and d["year"] == 2009 and d["field"] == "Mathematics" and d["title"] == "A title"
    assert dataset.to_doc(0, 0, {**rec, "abstract": ""}) is None
    assert dataset.field_of("astro-ph.CO") == "Astrophysics" and dataset.field_of("zz") == "Other"


def test_load_retries_429_and_writes_schema_first(settings, backend, monkeypatch):
    store = dataset.ChunkStore(settings.embeddings_uri)
    for sh in (0, 1):
        rows = [{"id": sh * 1_000_000 + i, "arxiv_id": "", "title": "t", "abstract": "a", "authors": "",
                 "category": "cs.LG", "field": "Computer Science", "year": 2020, "vector": [0.1] * 384}
                for i in range(25)]
        store.write(dataset.chunk_name(sh, 0), pa.Table.from_pylist(rows, schema=dataset.CHUNK_SCHEMA))
    backend.fail_429 = 2
    monkeypatch.setattr(ingest.B, "make", lambda name, s: backend)
    monkeypatch.setattr(ingest.time, "sleep", lambda s: None)
    monkeypatch.setenv("EMBEDDINGS_URI", settings.embeddings_uri)
    monkeypatch.setenv("SEARCH_NAMESPACE", "arxiv-test")
    ingest.main(["load", "--docs", "40", "--batch", "10", "--concurrency", "2", "--wait-index", "0"])
    writes = [c for c in backend.calls if c[0] == "write"]
    # the first batch carries the schema (and is retried twice after 429s); later batches don't
    assert [c[3] for c in writes] == [True, True, True, False, False, False]
    assert len(backend.written) == 40 and len({r["id"] for r in backend.written}) == 40
    assert len(writes) == 4 + 2                                          # 4 batches + 2 rejected tries
    # interleaved order: chunk 0 of shard 0, then chunk 0 of shard 1
    assert {r["id"] // 1_000_000 for r in backend.written} == {0, 1}


# --- sharding ----------------------------------------------------------------------------------

from conftest import FakeBackend  # noqa: E402
from search.backends import ShardedBackend  # noqa: E402


class ShardFake(FakeBackend):
    """Each shard namespace keeps its own docs; queries rank them by $dist like a real namespace."""

    def __init__(self):
        super().__init__()
        self.docs: dict[str, dict[int, dict]] = {}

    def write(self, ns, *, upsert_rows=None, deletes=None, schema=None, distance_metric=None):
        super().write(ns, upsert_rows=upsert_rows, deletes=deletes, schema=schema, distance_metric=distance_metric)
        d = self.docs.setdefault(ns, {})
        for r in upsert_rows or []:
            d[r["id"]] = r
        for i in deletes or []:
            d.pop(i, None)
        return {"rows_affected": len(upsert_rows or []), "client_ms": 1.0}

    def _rank(self, ns, q):
        rows = sorted(self.docs.get(ns, {}).values(), key=lambda r: r["$dist"],
                      reverse=q["rank_by"][0] != "vector")
        return rows[: q.get("top_k", 10)]

    def query(self, ns, body):
        self.calls.append(("query", ns, body))
        return {"rows": self._rank(ns, body), "client_ms": 2.0, "routed_to": f"pod-{ns}",
                "performance": {"server_total_ms": {"a": 4.0, "b": 9.0}[ns[-1]], "exhaustive_search_count": 3,
                                "cache_temperature": {"a": "hot", "b": "cold"}[ns[-1]], "node": f"q-{ns}"}}

    def multi_query(self, ns, queries, consistency=None):
        self.calls.append(("multi_query", ns, queries, consistency))
        return {"results": [{"rows": self._rank(ns, q)} for q in queries], "client_ms": 3.0,
                "performance": {"server_total_ms": 1.0}}

    def metadata(self, ns):
        if ns not in self.docs:
            return None
        return {"approx_row_count": len(self.docs[ns]),
                "index": {"status": "up-to-date" if ns.endswith("a") else "updating", "unindexed_rows": 7}}


def _sharded():
    inner = ShardFake()
    return inner, ShardedBackend(inner, "arxiv", ["arxiv-a", "arxiv-b"])


def test_sharded_write_routes_by_id_and_schema_reaches_every_shard():
    inner, sb = _sharded()
    rows = [{"id": i, "$dist": i / 10} for i in range(10)]
    out = sb.write("arxiv", upsert_rows=rows, schema={"title": {"type": "string"}})
    assert out["rows_affected"] == 10
    assert sorted(inner.docs["arxiv-a"]) == [0, 2, 4, 6, 8]
    assert sorted(inner.docs["arxiv-b"]) == [1, 3, 5, 7, 9]
    assert {c[1] for c in inner.calls if c[0] == "write" and c[3]} == {"arxiv-a", "arxiv-b"}
    sb.write("arxiv", deletes=[3, 4])
    assert 4 not in inner.docs["arxiv-a"] and 3 not in inner.docs["arxiv-b"]


def test_sharded_query_merges_like_one_namespace():
    inner, sb = _sharded()
    sb.write("arxiv", upsert_rows=[{"id": i, "$dist": i / 10} for i in range(10)])
    vec = sb.query("arxiv", {"rank_by": ["vector", "ANN", [0.1]], "top_k": 3})
    assert [r["id"] for r in vec["rows"]] == [0, 1, 2]                  # smallest distance first
    bm25 = sb.query("arxiv", {"rank_by": ["title", "BM25", "x"], "top_k": 3})
    assert [r["id"] for r in bm25["rows"]] == [9, 8, 7]                 # largest score first
    p = vec["performance"]
    assert p["server_total_ms"] == 9.0 and p["exhaustive_search_count"] == 6
    assert p["cache_temperature"] == "cold" and len(p["shards"]) == 2
    multi = sb.multi_query("arxiv", [{"rank_by": ["vector", "ANN", [0.1]], "top_k": 2},
                                     {"rank_by": ["abstract", "BM25", "y"], "top_k": 2}])
    assert [[r["id"] for r in res["rows"]] for res in multi["results"]] == [[0, 1], [9, 8]]


def test_sharded_metadata_sums_and_waits_for_every_shard():
    inner, sb = _sharded()
    assert sb.metadata("arxiv") is None
    sb.write("arxiv", upsert_rows=[{"id": i, "$dist": 0} for i in range(5)])
    m = sb.metadata("arxiv")
    assert m["approx_row_count"] == 5 and m["index"]["unindexed_rows"] == 14
    assert m["index"]["status"] == "updating"                           # shard b isn't indexed yet
    sb.delete_namespace("arxiv")
    assert {c[1] for c in inner.calls if c[0] == "delete"} == {"arxiv-a", "arxiv-b"}


def test_sharded_passes_other_namespaces_through():
    inner, sb = _sharded()
    sb.write("other-a", upsert_rows=[{"id": 1, "$dist": 0}])
    assert list(inner.docs) == ["other-a"]


def test_search_service_hybrid_over_shards(settings, embedder):
    inner = ShardFake()
    sb = ShardedBackend(inner, settings.namespace, ["arxiv-a", "arxiv-b"])
    sb.write(settings.namespace, upsert_rows=[{"id": i, "$dist": i / 10, "title": f"t{i}"} for i in range(8)])
    svc = SearchService(settings, embedder, {"temupuffer": sb})
    out = svc.search(Q.SearchRequest(q="x", mode="hybrid", limit=4))
    assert len(out["results"]) == 4
    assert {c[1] for c in inner.calls if c[0] == "multi_query"} == {"arxiv-a", "arxiv-b"}
