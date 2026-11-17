"""Indexer housekeeping: garbage collection on idle namespaces, and the readiness signal."""

import time

from temupuffer import jobqueue, keys, manifest
from conftest import drain


def _compact(engine, indexer, ns):
    """Write in separate passes until compaction leaves garbage in the manifest."""
    for i in range(4):
        engine.write(ns, {"upsert_rows": [{"id": i, "v": "x"}]})
        drain(indexer)
    man, _ = manifest.read(engine.store, ns)
    assert man["garbage"], "expected compaction to leave replaced segments in garbage"
    return man


def test_sweep_collects_garbage_on_an_idle_namespace(engine, indexer, store):
    indexer.s.gc_delay_s = 3600  # nothing is due yet
    man = _compact(engine, indexer, "idle")
    dead = [g["id"] for g in man["garbage"]]
    assert all(store.list(keys.segment_prefix("idle", d))[0] for d in dead)

    # No writes from here on. A sweep doesn't touch garbage that isn't due...
    indexer.sweep()
    assert "idle" not in jobqueue.read(store)[0]["jobs"]

    # ...but once it is due, the sweep queues a pass, and that pass deletes it.
    indexer.s.gc_delay_s = 0
    indexer.sweep()
    assert "idle" in jobqueue.read(store)[0]["jobs"]
    drain(indexer)

    man, _ = manifest.read(store, "idle")
    assert man["garbage"] == []
    assert not any(store.list(keys.segment_prefix("idle", d))[0] for d in dead)
    # The live data is untouched.
    rows = engine.query("idle", {"rank_by": ["id", "asc"], "limit": 10})["rows"]
    assert [r["id"] for r in rows] == [0, 1, 2, 3]


def test_readiness_follows_the_loop(indexer):
    stale = 30
    ok, body = indexer.readiness(stale)
    assert ok and body["last_ok_age_s"] is None  # just started, first step not done yet

    indexer.last_ok = time.time()
    assert indexer.readiness(stale)[0]

    # Object storage stops answering: steps keep failing, last_ok ages out.
    indexer.last_ok = time.time() - 120
    indexer.last_error = "ConnectionError('Failed to resolve')"
    ok, body = indexer.readiness(stale)
    assert not ok and "Failed to resolve" in body["last_error"]

    # A long pass in progress counts as healthy (the heartbeat keeps the lease).
    indexer.current = {"ns": "big", "stage": "building"}
    assert indexer.readiness(stale)[0]


def test_readiness_never_ok_before_a_first_success(indexer):
    indexer.started_at = time.time() - 120
    indexer.last_error = "ConnectionError('Failed to resolve')"
    assert not indexer.readiness(30)[0]


def test_size_capped_compaction_keeps_tombstones_for_unmerged_segments(engine, indexer, store):
    """A partial merge must keep tombstones: an older copy may live in a segment it didn't touch."""
    indexer.s.indexer_max_segment_rows = 10
    for lo in (0, 8, 16):  # three 8-row segments: no two fit under the cap together
        engine.write("cap", {"upsert_rows": [{"id": i, "v": "x"} for i in range(lo, lo + 8)]})
        drain(indexer)
    assert len(manifest.read(store, "cap")[0]["segments"]) == 3
    engine.write("cap", {"deletes": [3, 20]})  # 20 lives in the third segment
    drain(indexer)
    engine.write("cap", {"upsert_rows": [{"id": 100, "v": "y"}]})
    drain(indexer)

    man, _ = manifest.read(store, "cap")
    assert len(man["segments"]) == 3, "the two tiny segments + one 8-row segment merged; two stayed"
    assert all(s["rows"] <= 10 for s in man["segments"])
    ids = [r["id"] for r in engine.query("cap", {"rank_by": ["id", "asc"], "limit": 100})["rows"]]
    assert ids == [i for i in range(24) if i not in (3, 20)] + [100]


def test_pick_merge_takes_the_smallest_segments_under_the_cap():
    from temupuffer.indexer import Indexer
    segs = [{"id": c, "rows": n} for c, n in [("a", 50), ("b", 5), ("c", 5), ("d", 30), ("e", 12)]]
    assert [s["id"] for s in Indexer.pick_merge(segs, 25)] == ["b", "c", "e"]
    assert Indexer.pick_merge(segs, 6) == []  # one segment alone is not a merge
