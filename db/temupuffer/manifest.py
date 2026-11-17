"""The index manifest (ns/<name>/index/manifest.json): which segments are live,
and the *index cursor*.

    {"version": 7,
     "cursor": 41,                       <- every WAL entry <= 41 is in a segment
     "segments": [ {"id": "a1b2", "min_seq": 0,  "max_seq": 30, "rows": 9000, ...},
                   {"id": "c3d4", "min_seq": 31, "max_seq": 41, "rows": 1200, ...} ],
     "garbage":  [ {"id": "old1", "since": 1731100000.0} ]}

WAL entries with seq > cursor are the *unindexed tail*. A strongly consistent
query brute-forces them on every query (performance.exhaustive_search_count),
which is why a growing backlog shows up as slower queries before it shows up
as 429s on writes.

The manifest is the commit point of indexing. An indexer writes the segment
files first, then swaps in the new manifest with If-Match. If that swap
fails, another indexer got there first, and the orphaned segment files are
deleted. Readers never see a half-built segment, because a segment doesn't
exist as far as queries are concerned until the manifest names it.
"""

from __future__ import annotations

import json

from . import keys
from .meta import now_iso
from .storage import NotFound, ObjectStore


def empty() -> dict:
    return {"version": 0, "cursor": -1, "segments": [], "garbage": [], "updated_at": None}


def read(store: ObjectStore, ns: str) -> tuple[dict, str | None]:
    try:
        body, etag = store.get(keys.manifest(ns))
    except NotFound:
        return empty(), None
    return json.loads(body), etag


def write(store: ObjectStore, ns: str, doc: dict, etag: str | None) -> str:
    """CAS-write the manifest. Raises PreconditionFailed if someone else wrote it since we read it."""
    doc = dict(doc, version=doc.get("version", 0) + 1, updated_at=now_iso())
    body = json.dumps(doc, indent=1).encode()
    if etag is None:
        return store.put(keys.manifest(ns), body, if_none_match=True)
    return store.put(keys.manifest(ns), body, if_match=etag)
