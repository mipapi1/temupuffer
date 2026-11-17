"""End to end on one or two nodes sharing one bucket: writes, indexing, consistency, backpressure."""

import pytest

from temupuffer import jobqueue, keys, manifest
from temupuffer.engine import Engine
from temupuffer.errors import Backpressure, BadRequest, NamespaceNotFound
from conftest import drain


def ids(result):
    return sorted(r["id"] for r in result["rows"])


def by_id(engine, ns, **kw):
    return engine.query(ns, {"rank_by": ["id", "asc"], "limit": 1000, "include_attributes": True, **kw})


def test_write_is_queryable_before_indexing(engine):
    engine.write("a", {"upsert_rows": [{"id": 1, "x": "hi"}, {"id": 2, "x": "yo"}]})
    r = by_id(engine, "a")
    assert ids(r) == [1, 2]
    assert r["performance"]["exhaustive_search_count"] == 2  # all from the WAL tail
    assert engine.metadata("a")["index"] == {"status": "updating", "unindexed_bytes": pytest.approx(
        engine.metadata("a")["index"]["unindexed_bytes"]), "unindexed_rows": 2}


def test_indexer_advances_cursor_and_tail_shrinks(engine, indexer, store):
    for i in range(5):
        engine.write("b", {"upsert_rows": [{"id": i}]})
    assert jobqueue.read(store)[0]["jobs"].keys() == {"b"}
    drain(indexer)
    man, _ = manifest.read(store, "b")
    assert man["cursor"] == 4
    r = by_id(engine, "b")
    assert ids(r) == [0, 1, 2, 3, 4]
    assert r["performance"]["exhaustive_search_count"] == 0
    assert engine.metadata("b")["index"] == {"status": "up-to-date"}


def test_newest_version_wins_across_segments_and_tail(engine, indexer):
    engine.write("c", {"upsert_rows": [{"id": 1, "v": "old"}, {"id": 2, "v": "old"}, {"id": 3, "v": "old"}]})
    drain(indexer)
    engine.write("c", {"upsert_rows": [{"id": 1, "v": "new"}], "deletes": [2]})
    drain(indexer)  # second segment: id 1 updated, id 2 tombstoned
    engine.write("c", {"upsert_rows": [{"id": 3, "v": "tail"}], "deletes": [1]})  # still in the tail
    rows = {r["id"]: r for r in by_id(engine, "c")["rows"]}
    assert set(rows) == {3}
    assert rows[3]["v"] == "tail"
    # ...and after compaction everything still resolves the same way
    drain(indexer)
    engine.write("c", {"upsert_rows": [{"id": 4, "v": "x"}]})
    drain(indexer)
    man, _ = manifest.read(engine.store, "c")
    assert len(man["segments"]) < 3  # compacted
    assert {r["id"]: r["v"] for r in by_id(engine, "c")["rows"]} == {3: "tail", 4: "x"}


def test_strong_vs_eventual_across_two_nodes(settings, store, indexer):
    """Node B's cached view goes stale; eventual misses node A's write, strong never does."""
    a, b = Engine(settings, store), Engine(settings, store)
    a.write("d", {"upsert_rows": [{"id": 1}]})
    assert ids(by_id(b, "d", consistency={"level": "eventual"})) == [1]  # B has no view: builds one
    a.write("d", {"upsert_rows": [{"id": 2}]})
    stale = by_id(b, "d", consistency={"level": "eventual"})
    assert ids(stale) == [1]  # B reused its cached view: missed the write
    assert stale["performance"]["object_storage_round_trips"] == 0
    strong = by_id(b, "d")
    assert ids(strong) == [1, 2]  # strong re-checked object storage
    assert strong["performance"]["object_storage_round_trips"] >= 2  # manifest check + WAL LIST (+ GET)


def test_eventual_respects_max_staleness(settings, store):
    a, b = Engine(settings, store), Engine(settings, store)
    a.write("e", {"upsert_rows": [{"id": 1}]})
    by_id(b, "e", consistency={"level": "eventual"})
    a.write("e", {"upsert_rows": [{"id": 2}]})
    r = by_id(b, "e", consistency={"level": "eventual", "max_staleness_seconds": 0})
    assert ids(r) == [1, 2]  # view too old for this request: refreshed


def test_eventual_scans_at_most_n_bytes_of_tail(settings, store):
    settings.eventual_max_unindexed_bytes = 1  # tiny: only the first (oldest) entry fits
    e = Engine(settings, store)
    for i in range(3):
        e.write("f", {"upsert_rows": [{"id": i}]})
    r = by_id(e, "f", consistency={"level": "eventual", "max_staleness_seconds": 0})
    assert ids(r) == [0]
    assert r["performance"]["unindexed_entries_skipped"] == 2
    assert ids(by_id(e, "f")) == [0, 1, 2]  # strong scans the whole tail


def test_backpressure_429_then_clears(engine, indexer, settings):
    settings.backpressure_max_unindexed_rows = 50
    engine.write("g", {"upsert_rows": [{"id": i} for i in range(50)]})
    with pytest.raises(Backpressure):
        engine.write("g", {"upsert_rows": [{"id": 999}]})
    engine.write("g", {"upsert_rows": [{"id": 1000}], "disable_backpressure": True})  # allowed
    drain(indexer)
    engine.views.refresh("g")
    engine.write("g", {"upsert_rows": [{"id": 999}]})  # cleared


def test_schema_and_metric_rules(engine):
    engine.write("h", {"distance_metric": "cosine_distance", "upsert_rows": [{"id": 1, "vector": [1, 0], "n": 1}]})
    with pytest.raises(BadRequest, match="cannot change"):
        engine.write("h", {"distance_metric": "euclidean_squared", "upsert_rows": [{"id": 2, "vector": [0, 1]}]})
    with pytest.raises(BadRequest, match="dims"):
        engine.write("h", {"upsert_rows": [{"id": 2, "vector": [0, 1, 2]}]})
    with pytest.raises(BadRequest, match="is int"):
        engine.write("h", {"upsert_rows": [{"id": 2, "vector": [0, 1], "n": "text"}]})
    with pytest.raises(BadRequest, match="duplicate"):
        engine.write("h", {"upsert_rows": [{"id": 3, "vector": [0, 1]}, {"id": 3, "vector": [1, 1]}]})
    with pytest.raises(BadRequest, match="required"):
        engine.write("h2", {"upsert_rows": [{"id": 1, "vector": [1, 0]}]})


def test_lost_wakeup_is_prevented_by_rerun(store):
    jobqueue.enqueue(store, "ns")
    assert jobqueue.claim(store, "w1", 30) == "ns"
    jobqueue.enqueue(store, "ns")  # a write lands while w1 is working
    jobqueue.finish(store, "ns", "w1", more_work=False)
    assert "ns" in jobqueue.read(store)[0]["jobs"]  # put back, not deleted


def test_stale_lease_can_be_taken_over(store):
    jobqueue.enqueue(store, "ns")
    assert jobqueue.claim(store, "w1", 30) == "ns"
    assert jobqueue.claim(store, "w2", 30) is None  # still leased
    assert jobqueue.claim(store, "w2", -1) == "ns"  # lease expired: w2 takes it
    assert not jobqueue.heartbeat(store, "ns", "w1")  # w1 finds out it lost the job


def test_upsert_columns_multi_query_and_count(engine):
    engine.write("m", {"upsert_columns": {"id": [1, 2, 3], "cat": ["a", "b", "a"]}})
    r = engine.query("m", {"queries": [
        {"rank_by": ["id", "desc"], "limit": 2},
        {"aggregate_by": {"n": ["Count"]}, "filters": ["cat", "Eq", "a"]},
    ]})
    assert [row["id"] for row in r["results"][0]["rows"]] == [3, 2]
    assert r["results"][1]["aggregations"] == {"n": 2}


def test_delete_namespace(engine, indexer, store):
    engine.write("z", {"upsert_rows": [{"id": 1}]})
    drain(indexer)
    engine.delete_namespace("z")
    assert not [k for k in store.objects if k.startswith(keys.ns_prefix("z"))]
    with pytest.raises(NamespaceNotFound):
        by_id(engine, "z")
    engine.write("z", {"upsert_rows": [{"id": 2}]})  # name can be reused
    assert ids(by_id(engine, "z")) == [2]


def test_list_namespaces(engine):
    for n in ["demo-a", "demo-b", "other"]:
        engine.write(n, {"upsert_rows": [{"id": 1}]})
    assert engine.list_namespaces(prefix="demo-") == {"namespaces": [{"id": "demo-a"}, {"id": "demo-b"}]}
    page = engine.list_namespaces(page_size=2)
    assert page["next_cursor"] == "demo-b"
    assert engine.list_namespaces(cursor=page["next_cursor"])["namespaces"] == [{"id": "other"}]


def test_cache_temperature_cold_then_hot(settings, store, indexer):
    a = Engine(settings, store)
    a.write("t", {"upsert_rows": [{"id": i} for i in range(10)]})
    drain(indexer)
    b = Engine(settings, store)  # a fresh node: nothing cached
    assert by_id(b, "t")["performance"]["cache_temperature"] == "cold"
    assert by_id(b, "t")["performance"]["cache_temperature"] == "hot"
