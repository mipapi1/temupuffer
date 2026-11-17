"""The write-ahead log: group commit, conditional PUT, retry on a lost race.

This is labs/c-wal/wal_cap.py grown up. The pieces map one to one:

    lab                                  here
    -----------------------------------  ---------------------------------------
    submit(record) + threading.Event     WalWriter.submit(batch)
    flusher() thread                     WalWriter._flusher()
    MIN_GAP = 1.0                        settings.wal_min_gap_s (turbopuffer: 1 entry/s)
    drain with get_nowait()              same
    next_seq() with a paginated LIST     _discover_head(): LIST StartAfter=<last known>
    append() with IfNoneMatch="*"        _append(): put(..., if_none_match=True)
    retry on 412/409                     same

One WalWriter exists per namespace per query node. With two query nodes, two
writers can race for the same sequence number. The conditional PUT makes sure
only one wins, and the loser retries with the next number. That's the
safety net the Guarantees docs describe: "all concurrency control is delegated
to object storage". The docs don't say whether turbopuffer routes all of a
namespace's writes to one node (they say queries are routed for cache
locality), so we don't claim that it does.

A write returns once its entry is durable in the bucket, before it's indexed
(Guarantees docs: "committed to object storage before the API returns").

The entry format (one JSON object per WAL entry):

    {"seq": 42, "committed_at": "...", "node": "query-0",
     "batches": [ {"upserts": [{"id": 1, ...}], "deletes": [7]},   # request A
                  {"upserts": [...], "deletes": []} ]}             # request B (same group commit)

Each operation gets a *version*: (seq << 32) | position-within-entry. Newer
versions win, which is how "the newer WAL entry wins" works for upserts and
deletes of the same id.

Retention: temupuffer never deletes WAL entries, even after they're indexed.
Deleting them safely is harder than it looks. A writer that was idle while
the log was trimmed could still believe the head is an old seq, and its
If-None-Match PUT would *succeed* on a key that was deleted, recreating an
entry below the index cursor that no indexer will ever read. Fixing that needs a
fence (e.g. writers checking the cursor). turbopuffer's WAL retention isn't documented.
"""

from __future__ import annotations

import json
import queue
import threading
import time
from dataclasses import dataclass, field
from typing import Callable, Iterator

from . import keys
from .meta import now_iso
from .storage import NotFound, ObjectStore, PreconditionFailed


def version(seq: int, op_index: int) -> int:
    return (seq << 32) | op_index


def version_seq(v: int) -> int:
    return v >> 32


def encode_entry(seq: int, node: str, batches: list[dict]) -> bytes:
    return json.dumps({"seq": seq, "committed_at": now_iso(), "node": node, "batches": batches},
                      separators=(",", ":")).encode()


def iter_ops(entry: dict) -> Iterator[tuple[int, str, object]]:
    """Yield (version, kind, payload) for each op in an entry, in commit order.

    kind is "upsert" (payload = the row) or "delete" (payload = the id).
    """
    i = 0
    seq = entry["seq"]
    for batch in entry["batches"]:
        for row in batch.get("upserts", []):
            yield version(seq, i), "upsert", row
            i += 1
        for doc_id in batch.get("deletes", []):
            yield version(seq, i), "delete", doc_id
            i += 1


def entry_rows(entry: dict) -> int:
    return sum(len(b.get("upserts", [])) + len(b.get("deletes", [])) for b in entry["batches"])


def list_entries(store: ObjectStore, ns: str, after_seq: int = -1):
    """LIST the WAL entries after after_seq. One request per 1000 keys.

    The query path uses this to find the WAL head (the "is there anything newer?"
    check a strong query has to make). turbopuffer's docs describe that check
    as cheap and put a ~10 ms floor on consistent reads, but they don't say how
    it's done. LIST with StartAfter is our version.
    """
    start_after = keys.wal_entry(ns, after_seq) if after_seq >= 0 else None
    objs, _ = store.list(keys.wal_prefix(ns), start_after=start_after)
    return objs


class _LostRace(Exception):
    """Another node committed the seq this writer tried (412/409 on If-None-Match)."""

    def __init__(self, at: float):
        super().__init__()
        self.at = at  # time.monotonic() when the 412 came back


@dataclass
class _Pending:
    batch: dict
    nbytes: int
    done: threading.Event = field(default_factory=threading.Event)
    seq: int | None = None
    error: Exception | None = None
    queued_at: float = field(default_factory=time.monotonic)


class WalWriter:
    """Group commit for one namespace on one node."""

    def __init__(self, store: ObjectStore, ns: str, node_id: str, min_gap_s: float,
                 max_entry_bytes: int, head_hint: Callable[[], int] | None = None,
                 on_commit: Callable[[dict, int, str], None] | None = None, winner_backoff: float = 0.05):
        self.store = store
        self.ns = ns
        self.node_id = node_id
        self.min_gap_s = min_gap_s
        self.max_entry_bytes = max_entry_bytes
        # After our own commit, wait a little more than the gap (this fraction of
        # it, or 2x the PUT latency if bigger), so a node that just lost a race
        # gets the next slot (see _flusher).
        self.winner_backoff = winner_backoff
        self.head_hint = head_hint  # returns a seq known to exist (e.g. the index cursor), or -1
        self.on_commit = on_commit  # called with (entry, size, etag) after each durable commit
        self.pending: queue.Queue[_Pending] = queue.Queue()
        self.known_head: int | None = None  # newest seq this writer knows exists
        # Counters for the console.
        self.entries_written = 0
        self.lost_races = 0
        self.last_commit_ms = 0.0
        self.last_batch_requests = 0
        threading.Thread(target=self._flusher, name=f"wal-{ns}", daemon=True).start()

    def submit(self, batch: dict, nbytes: int, timeout: float = 60.0) -> int:
        """Queue one request's batch and block until it's durable. Returns the WAL seq."""
        item = _Pending(batch, nbytes)
        self.pending.put(item)
        if not item.done.wait(timeout):
            raise TimeoutError("WAL commit timed out")
        if item.error:
            raise item.error
        return item.seq  # type: ignore[return-value]

    def queue_depth(self) -> int:
        return self.pending.qsize()

    def _flusher(self) -> None:
        # When the newest WAL entry we know of became durable: our own PUT's 200,
        # or the 412 that told us another node's entry already exists. Every
        # node that took part in a round sees (almost) the same moment, so
        # timing the next attempt from it keeps the gap namespace-wide. Timing from
        # our own attempt instead lets one node keep its head start and win round
        # after round (measured: 30 entries to 1).
        last_durable = float("-inf")  # nothing yet, so the first entry never waits
        lost_last = False
        last_put_s = 0.0
        carry: _Pending | None = None
        while True:
            first = carry or self.pending.get()
            carry = None
            batch = [first]
            size = first.nbytes
            while True:  # until this batch is durable (or failed)
                # 1 WAL entry per second per namespace (Architecture docs). Sleeping
                # here is what makes concurrent writes share an entry: they pile
                # up in the queue while we wait.
                # Loser goes first: after a lost race wait exactly one gap; after
                # our own commit wait a little longer, so the node that lost the
                # last round wins the next one and nodes take turns.
                # The edge must beat the timing skew between nodes, which is about
                # one PUT round trip, so it's at least 2x our last commit's latency.
                edge = max(self.min_gap_s * self.winner_backoff, 2 * last_put_s)
                gap = self.min_gap_s + (0 if lost_last else edge)
                wait = last_durable + gap - time.monotonic()
                if wait > 0:
                    time.sleep(wait)
                while carry is None:
                    try:
                        item = self.pending.get_nowait()
                    except queue.Empty:
                        break
                    if size + item.nbytes > self.max_entry_bytes:
                        carry = item  # goes into the next entry
                        break
                    batch.append(item)
                    size += item.nbytes
                attempt_start = time.monotonic()
                try:
                    seq, entry, nbytes, etag = self._append([i.batch for i in batch])
                    last_durable = time.monotonic()
                    last_put_s = last_durable - attempt_start
                    lost_last = False
                    break
                except _LostRace as lost:
                    # Another node committed the seq we wanted a moment ago.
                    # Wait a full gap from then (requests arriving meanwhile join
                    # this batch), so two nodes can't each commit in the same
                    # second. This is temupuffer's mechanism: turbopuffer
                    # documents the 1 entry/s limit, not how it's enforced.
                    last_durable = lost.at
                    lost_last = True
                    continue
                except Exception as e:  # tell every waiting caller; don't kill the thread
                    for i in batch:
                        i.error = e
                        i.done.set()
                    batch = []
                    break
            if not batch:
                continue
            self.last_commit_ms = (last_durable - attempt_start) * 1000
            self.last_batch_requests = len(batch)
            for i in batch:
                i.seq = seq
                i.done.set()
            # After the callers are released: tell the indexer and update this
            # node's cached view. This isn't on the write's latency path.
            if self.on_commit:
                try:
                    self.on_commit(entry, nbytes, etag)
                except Exception as e:  # the indexer's periodic sweep catches anything missed here
                    print(f"[wal {self.ns}] on_commit failed: {e!r}")

    def _discover_head(self) -> int:
        """Find the newest WAL seq: LIST everything after the newest one we know about."""
        after = self.known_head if self.known_head is not None else (self.head_hint() if self.head_hint else -1)
        objs = list_entries(self.store, self.ns, after)
        if objs:
            return keys.wal_seq(objs[-1].key)
        if after >= 0:
            # Make sure 'after' really exists. A deleted namespace starts again from 0.
            try:
                self.store.head(keys.wal_entry(self.ns, after))
                return after
            except NotFound:
                return self._discover_from_scratch()
        return -1

    def _wait_if_fresh(self) -> None:
        """We just learned the head by LIST, not by writing it. If another node wrote
        it within the last gap, behave as if we'd lost a race for it: no 412 told
        us, but writing now would put two entries closer than the gap.
        LastModified is the store's clock (S3 rounds it to the second), so allow
        1 s of slack for rounding and clock skew; at worst we wait one extra gap."""
        if self.known_head < 0 or self.min_gap_s <= 0:
            return
        try:
            mtime = self.store.head(keys.wal_entry(self.ns, self.known_head)).last_modified
        except NotFound:
            return
        if time.time() - mtime < self.min_gap_s + 1.0:
            raise _LostRace(time.monotonic())

    def _head_still_exists(self) -> bool:
        """One HEAD per WAL entry (<= 1/s per namespace): is our known head still there?"""
        try:
            self.store.head(keys.wal_entry(self.ns, self.known_head))
            return True
        except NotFound:
            return False

    def _discover_from_scratch(self) -> int:
        objs = list_entries(self.store, self.ns, -1)
        return keys.wal_seq(objs[-1].key) if objs else -1

    def _append(self, batches: list[dict]) -> tuple[int, dict, int, str]:
        """One attempt at the next seq. Raises _LostRace if another node got it first."""
        if self.known_head is None:
            self.known_head = self._discover_head()
            self._wait_if_fresh()
        elif self.known_head >= 0 and not self._head_still_exists():
            # The namespace was deleted (and maybe recreated) since we last wrote:
            # another node handled the delete, so only its writer was reset. Without
            # this fence we'd write known_head+1 into the new namespace, leaving a
            # hole the indexer's cursor jumps over; entries other nodes then write
            # into the hole sit below the cursor, acknowledged but never read.
            self.known_head = self._discover_from_scratch()
            self._wait_if_fresh()
        seq = self.known_head + 1
        body = encode_entry(seq, self.node_id, batches)
        try:
            etag = self.store.put(keys.wal_entry(self.ns, seq), body, if_none_match=True)
        except PreconditionFailed:
            # Another node took this seq first. Same as the lab's wal.py: find
            # the new head; the flusher waits a gap, then tries the next number.
            lost = _LostRace(time.monotonic())  # before the LIST: that's when we learned
            self.lost_races += 1
            self.known_head = self._discover_head()
            raise lost from None
        self.known_head = seq
        self.entries_written += 1
        return seq, json.loads(body), len(body), etag

    def reset(self) -> None:
        """Forget the head (used after the namespace is deleted)."""
        self.known_head = None
