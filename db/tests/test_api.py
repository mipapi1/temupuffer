"""The HTTP layer: routes, auth, error codes, response shapes."""

import pytest
from fastapi.testclient import TestClient

from server.main import create_app

KEY = {"Authorization": "Bearer tpuf-dev-key"}


@pytest.fixture
def client(settings, store):
    settings.api_key = "tpuf-dev-key"
    settings.selftest = True  # runs against MemoryStore, which passes
    with TestClient(create_app(settings, store)) as c:
        yield c


def test_auth_required(client):
    assert client.get("/v1/namespaces").status_code == 401
    assert client.get("/v1/namespaces", headers={"Authorization": "Bearer wrong"}).status_code == 401
    assert client.get("/healthz").status_code == 200


def test_write_query_metadata_roundtrip(client):
    r = client.post("/v2/namespaces/api-test", headers=KEY, json={
        "distance_metric": "cosine_distance",
        "upsert_rows": [{"id": 1, "vector": [1, 0], "title": "puffer"}, {"id": 2, "vector": [0, 1], "title": "fish"}],
        "schema": {"title": {"type": "string", "full_text_search": True}}})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["rows_affected"] == 2 and body["rows_upserted"] == 2
    assert "server_total_ms" in body["performance"]

    q = client.post("/v2/namespaces/api-test/query", headers=KEY, json={
        "rank_by": ["vector", "ANN", [1, 0.1]], "top_k": 1, "include_attributes": ["title"]})
    assert q.status_code == 200, q.text
    row = q.json()["rows"][0]
    assert row["id"] == 1 and row["title"] == "puffer" and "$dist" in row
    perf = q.json()["performance"]
    for field in ("server_total_ms", "exhaustive_search_count", "cache_temperature", "cache_hit_ratio",
                  "object_storage_round_trips", "approx_namespace_size"):
        assert field in perf

    m = client.get("/v1/namespaces/api-test/metadata", headers=KEY).json()
    assert m["index"]["status"] == "updating" and m["index"]["unindexed_rows"] == 2
    assert m["schema"]["title"]["full_text_search"]["k1"] == 1.2

    assert client.get("/v1/namespaces/api-test/hint_cache_warm", headers=KEY).json()["status"] == "ACCEPTED"
    assert client.get("/v1/namespaces", headers=KEY).json() == {"namespaces": [{"id": "api-test"}]}
    assert client.delete("/v2/namespaces/api-test", headers=KEY).status_code == 200
    assert client.get("/v1/namespaces/api-test/metadata", headers=KEY).status_code == 404


def test_errors_have_turbopuffer_like_codes(client, settings):
    assert client.post("/v2/namespaces/bad name!", headers=KEY, json={"upsert_rows": [{"id": 1}]}).status_code == 400
    assert client.post("/v2/namespaces/x/query", headers=KEY, json={"rank_by": ["id", "asc"]}).status_code == 404
    r = client.post("/v2/namespaces/x", headers=KEY, json={"patch_rows": [{"id": 1}]})
    assert r.status_code == 400 and "not supported" in r.json()["error"]
    settings.backpressure_max_unindexed_rows = 1
    client.post("/v2/namespaces/bp", headers=KEY, json={"upsert_rows": [{"id": 1}]})
    r = client.post("/v2/namespaces/bp", headers=KEY, json={"upsert_rows": [{"id": 2}]})
    assert r.status_code == 429 and "unindexed" in r.json()["error"]


def test_debug_endpoints(client):
    client.post("/v2/namespaces/dbg", headers=KEY, json={"upsert_rows": [{"id": 1}]})
    wal = client.get("/debug/namespaces/dbg/wal", headers=KEY).json()
    assert wal["entries"][0]["indexed"] is False and wal["cursor"] == -1
    assert "dbg" in client.get("/debug/queue", headers=KEY).json()["jobs"]
    cluster = client.get("/debug/cluster", headers=KEY).json()
    assert cluster["query_nodes"][0]["writes"] == 1
