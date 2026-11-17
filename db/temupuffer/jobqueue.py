"""The indexer work queue: one JSON file (queue.json), updated only with CAS.

This follows turbopuffer's blog post "How to build a distributed queue in a
single JSON file on object storage" (Feb 2026). The idea: you don't need a
queue service if every change is a read-modify-write of one object, protected
by compare-and-swap. Here that's If-Match: <etag>.

    {"version": 12,
     "jobs": {
        "products": {"enqueued_at": 1731100000.1, "claimed_by": "indexer-7f9c", "heartbeat": 1731100003.2,
                     "rerun": false},
        "news":     {"enqueued_at": 1731100002.4, "claimed_by": null, "heartbeat": null, "rerun": false}
     }}

Lifecycle of a job (one per namespace that has unindexed WAL entries):

    query node commits a WAL entry  ->  enqueue(ns)       (add the job, or set rerun if it's being worked on)
    indexer polls                   ->  claim(worker)     (set claimed_by + heartbeat)
    indexer works, every few s      ->  heartbeat(...)    (proves it's still alive)
    indexer finishes                ->  finish(...)       (remove the job, or unclaim it if rerun/more work)
    indexer crashes                 ->  heartbeat goes stale; after lease_s another indexer may claim it

Every operation is: GET queue.json -> change the dict -> PUT with If-Match. On 412
someone else changed it first, so re-read and redo the change. The blog post
says one replace can take up to ~200 ms, and GCS allows ~1 write/s per
object, which caps how fast a single-file queue can go. That's fine because
there's one job per namespace, not one per write.

Why "rerun"? Without it there's a lost-wakeup race:
    1. the indexer lists the WAL and finds entries up to 41
    2. a writer commits 42, sees the job is already queued, and does nothing
    3. the indexer finishes 41 and deletes the job  ->  42 waits for the sweep
With rerun, step 2 sets rerun=true and step 3 puts the job back instead of
deleting it. (The indexer also sweeps every namespace periodically, as a
safety net for an enqueue that failed outright.)
"""

from __future__ import annotations

import json
import time
from typing import Callable

from . import keys
from .storage import NotFound, ObjectStore, PreconditionFailed


def read(store: ObjectStore) -> tuple[dict, str | None]:
    try:
        body, etag = store.get(keys.QUEUE)
    except NotFound:
        return {"version": 0, "jobs": {}}, None
    return json.loads(body), etag


def _cas_update(store: ObjectStore, change: Callable[[dict], object], attempts: int = 50):
    """Apply change(doc) with CAS, retrying on conflict. change returns a result, or NO_WRITE to skip."""
    for attempt in range(attempts):
        doc, etag = read(store)
        result = change(doc)
        if result is NO_WRITE:
            return None
        doc["version"] = doc.get("version", 0) + 1
        body = json.dumps(doc, indent=1).encode()
        try:
            if etag is None:
                store.put(keys.QUEUE, body, if_none_match=True)
            else:
                store.put(keys.QUEUE, body, if_match=etag)
            return result
        except PreconditionFailed:
            time.sleep(min(0.01 * (2 ** attempt), 0.5))  # back off a little under contention
    raise RuntimeError("queue.json: too much contention")


class _NoWrite:
    pass


NO_WRITE = _NoWrite()


def enqueue(store: ObjectStore, ns: str) -> None:
    def change(doc):
        job = doc["jobs"].get(ns)
        if job is None:
            doc["jobs"][ns] = {"enqueued_at": time.time(), "claimed_by": None, "heartbeat": None, "rerun": False}
            return True
        if job["claimed_by"] and not job["rerun"]:
            job["rerun"] = True
            return True
        return NO_WRITE  # already queued and not being worked on: nothing to change

    _cas_update(store, change)


def claim(store: ObjectStore, worker: str, lease_s: float) -> str | None:
    """Claim the oldest job that's free or whose holder stopped heartbeating. Returns the namespace."""
    def change(doc):
        now = time.time()
        free = [(job["enqueued_at"], ns) for ns, job in doc["jobs"].items()
                if job["claimed_by"] is None or (job["heartbeat"] or 0) < now - lease_s]
        if not free:
            return NO_WRITE
        _, ns = min(free)
        doc["jobs"][ns].update(claimed_by=worker, heartbeat=now, rerun=False)
        return ns

    return _cas_update(store, change)


def heartbeat(store: ObjectStore, ns: str, worker: str) -> bool:
    """Refresh our lease. Returns False if we lost the job (someone else took it over)."""
    def change(doc):
        job = doc["jobs"].get(ns)
        if job is None or job["claimed_by"] != worker:
            return False
        job["heartbeat"] = time.time()
        return True

    return bool(_cas_update(store, change))


def finish(store: ObjectStore, ns: str, worker: str, more_work: bool) -> None:
    def change(doc):
        job = doc["jobs"].get(ns)
        if job is None or job["claimed_by"] != worker:
            return NO_WRITE  # we lost the lease; the new holder owns it now
        if more_work or job["rerun"]:
            job.update(claimed_by=None, heartbeat=None, rerun=False)  # back in line
        else:
            del doc["jobs"][ns]
        return True

    _cas_update(store, change)


def remove(store: ObjectStore, ns: str) -> None:
    def change(doc):
        if ns not in doc["jobs"]:
            return NO_WRITE
        del doc["jobs"][ns]
        return True

    _cas_update(store, change)
