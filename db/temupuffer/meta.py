"""Namespace metadata (ns/<name>/meta.json): distance metric, vector dims and schema.

A namespace is created by its first write (Write docs: "created implicitly on
the first document insert"). The first writer creates meta.json with
If-None-Match: *. When two nodes race to create the same namespace, one of
them gets 412, re-reads the winner's meta.json and checks that its own
request is compatible with it.

Later writes that add attributes update meta.json with If-Match. That's a
read-modify-write protected by the etag, the same CAS pattern as queue.json.

Rules from the Write docs that are enforced here:
  * distance_metric is set by the first write that has vectors and can't change.
  * Every vector in a namespace has the same number of dimensions.
  * An existing attribute's type can't change ("currently an error").
"""

from __future__ import annotations

import json
import threading
import time
from datetime import datetime, timezone

from . import keys
from .errors import BadRequest
from .schema import (DISTANCE_METRICS, VECTOR_ATTR, fits, infer_type, normalize_attr_spec,
                     vector_dims)
from .storage import NotFound, ObjectStore, PreconditionFailed


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def read(store: ObjectStore, ns: str) -> tuple[dict, str] | None:
    try:
        body, etag = store.get(keys.meta(ns))
    except NotFound:
        return None
    return json.loads(body), etag


def apply_write(meta: dict | None, ns: str, upserts: list[dict], distance_metric: str | None,
                declared_schema: dict | None) -> dict:
    """Return the meta.json this write needs, or raise BadRequest. Doesn't mutate its input."""
    m = json.loads(json.dumps(meta)) if meta else {
        "name": ns, "created_at": now_iso(), "updated_at": now_iso(),
        "distance_metric": None, "dims": None, "schema": {"id": {"type": "auto"}}, "version": 0,
    }
    schema = m["schema"]

    if distance_metric is not None and distance_metric not in DISTANCE_METRICS:
        raise BadRequest(f"distance_metric must be one of {sorted(DISTANCE_METRICS)}")

    # 1. Attributes declared explicitly in "schema".
    for name, spec in (declared_schema or {}).items():
        if name == "id":
            continue
        full = normalize_attr_spec(name, spec)
        old = schema.get(name)
        if old and old["type"] != full["type"]:
            raise BadRequest(f"cannot change type of {name!r} from {old['type']} to {full['type']}")
        if name == VECTOR_ATTR:
            dims = vector_dims(full["type"])
            if m["dims"] is not None and m["dims"] != dims:
                raise BadRequest(f"vector dims are fixed at {m['dims']}, schema says {dims}")
            m["dims"] = dims
        # Schema docs: filterable and full_text_search can be changed online.
        schema[name] = {**(old or {}), **full}

    # 2. Attributes inferred from the rows themselves.
    for row in upserts:
        for name, value in row.items():
            if name == "id":
                continue
            if name == VECTOR_ATTR:
                if not isinstance(value, list) or not value or not all(
                        isinstance(x, (int, float)) and not isinstance(x, bool) for x in value):
                    raise BadRequest("vector must be a non-empty array of numbers")
                if m["dims"] is None:
                    m["dims"] = len(value)
                    schema[VECTOR_ATTR] = {"type": f"[{len(value)}]f32", "ann": True}
                elif len(value) != m["dims"]:
                    raise BadRequest(f"vector has {len(value)} dims, this namespace uses {m['dims']}")
                continue
            if name in schema:
                if not fits(schema[name]["type"], value):
                    raise BadRequest(
                        f"attribute {name!r} is {schema[name]['type']}, got {infer_type(value)}")
            else:
                t = infer_type(value)
                if t is not None:
                    schema[name] = normalize_attr_spec(name, t)

    # 3. Vector rules.
    if m["dims"] is not None:
        # Write docs: "If the namespace has vector indexes, every doc must include all vector attributes."
        for row in upserts:
            if VECTOR_ATTR not in row:
                raise BadRequest(f"row {row.get('id')!r} has no vector, but this namespace has vectors")
        if m["distance_metric"] is None:
            if distance_metric is None:
                raise BadRequest("distance_metric is required on the first write with vectors")
            m["distance_metric"] = distance_metric
        elif distance_metric is not None and distance_metric != m["distance_metric"]:
            raise BadRequest(
                f"distance_metric is {m['distance_metric']} for this namespace and cannot change")
    return m


class MetaCache:
    """A per-node cache of meta.json, so most writes don't need a GET.

    A stale cache is safe. If this node's copy is missing an attribute that
    another node just added, the write tries to add it, the If-Match fails
    because the etag is old, and we re-read and re-check. Entries expire after
    a few seconds anyway, so a deleted-and-recreated namespace is noticed quickly.
    """

    def __init__(self, store: ObjectStore, ttl_s: float = 5.0):
        self.store = store
        self.ttl_s = ttl_s
        self.entries: dict[str, tuple[float, dict, str]] = {}
        self.lock = threading.Lock()

    def get(self, ns: str, fresh: bool = False) -> tuple[dict, str] | None:
        with self.lock:
            hit = self.entries.get(ns)
        if hit and not fresh and time.monotonic() - hit[0] < self.ttl_s:
            return hit[1], hit[2]
        got = read(self.store, ns)
        with self.lock:
            if got:
                self.entries[ns] = (time.monotonic(), got[0], got[1])
            else:
                self.entries.pop(ns, None)
        return got

    def forget(self, ns: str) -> None:
        with self.lock:
            self.entries.pop(ns, None)

    def ensure(self, ns: str, upserts: list[dict], distance_metric: str | None,
               declared_schema: dict | None) -> dict:
        """Make meta.json compatible with this write (creating or updating it), and return it."""
        fresh = False
        for _ in range(20):
            got = self.get(ns, fresh=fresh)
            current, etag = got if got else (None, None)
            wanted = apply_write(current, ns, upserts, distance_metric, declared_schema)
            if current is not None and wanted == current:
                return current  # nothing to change: the common case, no request at all
            wanted["version"] = (current or {}).get("version", 0) + 1
            wanted["updated_at"] = now_iso()
            body = json.dumps(wanted, indent=1).encode()
            try:
                if current is None:
                    new_etag = self.store.put(keys.meta(ns), body, if_none_match=True)
                else:
                    new_etag = self.store.put(keys.meta(ns), body, if_match=etag)
            except PreconditionFailed:
                fresh = True  # someone else changed meta.json first: re-read and re-validate
                continue
            with self.lock:
                self.entries[ns] = (time.monotonic(), wanted, new_etag)
            return wanted
        raise RuntimeError(f"could not update meta.json for {ns} after 20 attempts")
