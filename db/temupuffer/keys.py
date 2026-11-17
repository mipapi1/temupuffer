"""The bucket layout. Every object temupuffer writes has its key built here.

    queue.json                                   indexer work queue (CAS with If-Match)
    ns/<name>/meta.json                          distance metric, dims, schema
    ns/<name>/wal/00000000000000000042.json      one WAL entry (immutable)
    ns/<name>/index/manifest.json                live segments + index cursor (CAS with If-Match)
    ns/<name>/index/seg-<id>/<file>              one index segment (immutable)

turbopuffer (Architecture docs) also gives each namespace its own prefix,
with the WAL and the index stored separately under it.

WAL sequence numbers are zero-padded to 20 digits. S3 returns LIST results in
lexicographic (byte) order, so padding makes "sorted by key" mean "sorted by
sequence number". It also lets us ask for "everything after entry N" with
LIST StartAfter=<key of N>, so finding the WAL head doesn't need to list the
whole log.
"""

from __future__ import annotations

import re

NS_ROOT = "ns/"
QUEUE = "queue.json"

# Write docs: namespace names must match [A-Za-z0-9-_.]{1,128}.
NAMESPACE_RE = re.compile(r"^[A-Za-z0-9\-_.]{1,128}$")


def valid_namespace(name: str) -> bool:
    return bool(NAMESPACE_RE.match(name))


def ns_prefix(ns: str) -> str:
    return f"{NS_ROOT}{ns}/"


def meta(ns: str) -> str:
    return f"{NS_ROOT}{ns}/meta.json"


def wal_prefix(ns: str) -> str:
    return f"{NS_ROOT}{ns}/wal/"


def wal_entry(ns: str, seq: int) -> str:
    return f"{wal_prefix(ns)}{seq:020d}.json"


def wal_seq(key: str) -> int:
    """'ns/foo/wal/00000000000000000042.json' -> 42"""
    return int(key.rsplit("/", 1)[1].split(".", 1)[0])


def manifest(ns: str) -> str:
    return f"{NS_ROOT}{ns}/index/manifest.json"


def segment_prefix(ns: str, seg_id: str) -> str:
    return f"{NS_ROOT}{ns}/index/seg-{seg_id}/"


def segment_file(ns: str, seg_id: str, name: str) -> str:
    return f"{segment_prefix(ns, seg_id)}{name}"
