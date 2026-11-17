"""The WAL: group commit, the 1 entry/sec cap, and CAS retries."""

import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from temupuffer import keys, wal
from temupuffer.storage import MemoryStore


def make_writer(store, gap=0.02, node="n1", ns="ns1"):
    return wal.WalWriter(store, ns, node, gap, 32 * 1024 * 1024)


def entries(store, ns="ns1"):
    return [json.loads(store.get(o.key)[0]) for o in wal.list_entries(store, ns)]


def test_sequential_appends_get_consecutive_seqs():
    store = MemoryStore()
    w = make_writer(store)
    seqs = [w.submit({"upserts": [{"id": i}], "deletes": []}, 10) for i in range(3)]
    assert seqs == [0, 1, 2]
    assert [keys.wal_seq(o.key) for o in wal.list_entries(store, "ns1")] == [0, 1, 2]


def test_group_commit_batches_concurrent_writes():
    """50 concurrent writers during one gap share a small number of entries."""
    store = MemoryStore()
    w = make_writer(store, gap=0.3)
    w.submit({"upserts": [{"id": "warm"}], "deletes": []}, 10)  # start the gap clock
    with ThreadPoolExecutor(50) as pool:
        seqs = list(pool.map(lambda i: w.submit({"upserts": [{"id": i}], "deletes": []}, 10), range(50)))
    assert len(set(seqs)) <= 3  # all 50 fit in one or two entries, not 50
    all_ids = [r["id"] for e in entries(store) for b in e["batches"] for r in b["upserts"]]
    assert sorted(i for i in all_ids if i != "warm") == list(range(50))


def test_one_entry_per_gap():
    """The cap: entries start at least wal_min_gap_s apart (turbopuffer: 1/s)."""
    store = MemoryStore()
    w = make_writer(store, gap=0.15)
    t0 = time.monotonic()
    for i in range(4):
        w.submit({"upserts": [{"id": i}], "deletes": []}, 10)
    assert time.monotonic() - t0 >= 0.15 * 3 * 0.95


def test_cas_retry_when_another_node_took_the_seq():
    store = MemoryStore()
    a, b = make_writer(store, node="a"), make_writer(store, node="b")
    assert a.submit({"upserts": [{"id": 1}], "deletes": []}, 10) == 0
    assert b.submit({"upserts": [{"id": 2}], "deletes": []}, 10) == 1  # b discovers 0 exists via LIST
    # Now a believes the head is 0, but b wrote 1. a's PUT of 1 gets 412 -> retry -> 2.
    assert a.submit({"upserts": [{"id": 3}], "deletes": []}, 10) == 2
    assert a.lost_races == 1
    assert [e["node"] for e in entries(store)] == ["a", "b", "a"]


def test_two_racing_nodes_lose_nothing():
    """Like the lab's 10-writer race: every acknowledged write is in exactly one entry."""
    store = MemoryStore()
    writers = [make_writer(store, gap=0.0, node=f"n{i}") for i in range(4)]
    acked = []
    lock = threading.Lock()

    def client(i):
        seq = writers[i % 4].submit({"upserts": [{"id": i}], "deletes": []}, 10)
        with lock:
            acked.append((i, seq))

    with ThreadPoolExecutor(40) as pool:
        list(pool.map(client, range(200)))
    stored = {r["id"]: e["seq"] for e in entries(store) for b in e["batches"] for r in b["upserts"]}
    assert len(stored) == 200
    for i, seq in acked:
        assert stored[i] == seq
    assert sum(w.lost_races for w in writers) > 0  # they really did race


def test_versions_order_ops_within_and_across_entries():
    e1 = {"seq": 1, "batches": [{"upserts": [{"id": "a"}], "deletes": []}, {"upserts": [], "deletes": ["a"]}]}
    ops = list(wal.iter_ops(e1))
    assert ops[0][0] < ops[1][0]  # the later request in the same entry wins
    e2 = {"seq": 2, "batches": [{"upserts": [{"id": "a"}], "deletes": []}]}
    assert list(wal.iter_ops(e2))[0][0] > ops[1][0]


class _TimedStore(MemoryStore):
    """Records when each WAL entry became durable (successful If-None-Match PUT)."""

    def __init__(self):
        super().__init__()
        self.commits: list[tuple[float, int]] = []

    def _put(self, key, body, if_none_match, if_match):
        etag = super()._put(key, body, if_none_match, if_match)
        if "/wal/" in key:
            self.commits.append((time.monotonic(), keys.wal_seq(key)))
        return etag


def test_gap_holds_per_namespace_across_nodes():
    """Two query nodes writing one namespace: still <= 1 entry per gap overall,
    not 1 per gap per node. (What the console showed: two pods committed WAL 1
    and 2 in the same second.) A lost CAS race tells the loser another node
    just committed, so it waits a full gap before trying the next seq."""
    gap = 0.3
    store = _TimedStore()
    a = make_writer(store, gap, node="a")
    b = make_writer(store, gap, node="b")
    a.submit({"upserts": [{"id": -1}], "deletes": []}, 10)  # both nodes know the head...
    b.known_head = a.known_head                             # ...like pods that wrote before
    time.sleep(gap)
    store.commits.clear()
    with ThreadPoolExecutor(20) as pool:
        list(pool.map(lambda i: (a if i % 2 else b).submit({"upserts": [{"id": i}], "deletes": []}, 10),
                      range(20)))
    times = sorted(t for t, _ in store.commits)
    gaps = [round(y - x, 3) for x, y in zip(times, times[1:])]
    assert all(g >= gap * 0.9 for g in gaps), f"entries closer than {gap}s: {gaps}"
    stored = sorted(r["id"] for e in entries(store) for bt in e["batches"] for r in bt["upserts"])
    assert stored == [-1] + list(range(20))


def test_two_busy_nodes_take_turns():
    """Sustained writes on two nodes: neither starves, entries stay >= one gap apart.
    Timing each node from its own attempts let one node win 30 rounds to 1."""
    gap = 0.1

    class Slow(_TimedStore):  # ~object-storage latency, so races are realistic
        def _put(self, *a, **k):
            time.sleep(0.01)
            return super()._put(*a, **k)

    store = Slow()
    writers = {n: make_writer(store, gap, node=n) for n in "ab"}
    stop = time.monotonic() + 2.0
    worst = {"a": 0.0, "b": 0.0}

    def client(n):
        while time.monotonic() < stop:
            t = time.monotonic()
            writers[n].submit({"upserts": [{"id": 1}], "deletes": []}, 10)
            worst[n] = max(worst[n], time.monotonic() - t)

    threads = [threading.Thread(target=client, args=(n,)) for n in "ab" for _ in range(3)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    per_node = {n: sum(1 for e in entries(store) if e["node"] == n) for n in "ab"}
    total = sum(per_node.values())
    assert min(per_node.values()) >= 0.35 * total, per_node
    assert max(worst.values()) < 6 * gap, worst
    times = sorted(t for t, _ in store.commits)
    assert all(y - x >= gap * 0.9 for x, y in zip(times, times[1:]))


def test_stale_head_after_namespace_recreate_does_not_skip_seqs():
    """Seen on K3s: a namespace was deleted via pod A, so only A's writer reset.
    Pod B still believed head=4, wrote wal/5.. into the NEW namespace, the
    indexer's cursor jumped past the hole, and A's later wal/2, wal/3 landed
    below the cursor: acknowledged but never queryable. A writer must never
    write seq N unless N-1 exists."""
    store = MemoryStore()
    a = make_writer(store, 0.0, node="a")
    b = make_writer(store, 0.0, node="b")
    for i in range(4):
        a.submit({"upserts": [{"id": i}], "deletes": []}, 10)
    b.submit({"upserts": [{"id": 4}], "deletes": []}, 10)        # B knows head = 4
    store.delete_prefix("ns/ns1/")                                # namespace deleted via A...
    a.reset()                                                     # ...so only A forgets
    assert a.submit({"upserts": [{"id": 10}], "deletes": []}, 10) == 0
    assert b.submit({"upserts": [{"id": 11}], "deletes": []}, 10) == 1   # not 5
    assert [keys.wal_seq(o.key) for o in wal.list_entries(store, "ns1")] == [0, 1]


def test_discovering_a_fresh_head_counts_as_a_lost_race():
    """Seen on K3s after a recreate: node B discovered A's brand-new wal/0 by LIST
    (no collision, so no 412) and wrote wal/1 30 ms later. Finding a head we
    didn't write, written within the last gap, must wait a gap like a lost race."""
    gap = 0.4
    store = _TimedStore()
    a = make_writer(store, gap, node="a")
    b = make_writer(store, gap, node="b")
    a.submit({"upserts": [{"id": 0}], "deletes": []}, 10)
    b.submit({"upserts": [{"id": 1}], "deletes": []}, 10)   # B has never written: discovers wal/0
    (t0, s0), (t1, s1) = store.commits
    assert (s0, s1) == (0, 1)
    assert t1 - t0 >= gap * 0.9, t1 - t0


def test_discovering_an_old_head_does_not_wait():
    store = MemoryStore()
    make_writer(store, 0.0, node="a").submit({"upserts": [{"id": 0}], "deletes": []}, 10)
    store.objects = {k: (body, etag, mtime - 3600) for k, (body, etag, mtime) in store.objects.items()}  # an hour ago
    b = make_writer(store, 5.0, node="b")
    t = time.monotonic()
    b.submit({"upserts": [{"id": 1}], "deletes": []}, 10)
    assert time.monotonic() - t < 1.0
