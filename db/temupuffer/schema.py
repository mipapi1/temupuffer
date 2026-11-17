"""Attribute types, schema inference and write-request validation.

Follows the Write docs ("Schema" section) for a subset of the types:

    string, int, float, bool, []string, []int, []float     inferred from values
    [N]f32                                                 the "vector" attribute

turbopuffer infers string, int and bool (and their arrays) from the payload,
treats every attribute except ``id`` as nullable, and makes changing an
existing attribute's type an error. We do the same.

Not supported here (turbopuffer has them): uint, uuid, datetime, bytes, f16
and i8 vectors, sparse vectors, more than one vector column, and the regex,
glob and fuzzy indexes. docs/compat.md lists all the differences.
"""

from __future__ import annotations

import json
from typing import Any

from .errors import BadRequest

SCALAR_TYPES = {"string", "int", "float", "bool"}
ARRAY_TYPES = {"[]string", "[]int", "[]float"}
VECTOR_ATTR = "vector"  # Write docs: an attribute named "vector" is inferred as a vector.
DISTANCE_METRICS = {"cosine_distance", "euclidean_squared"}
MAX_ID_BYTES = 64  # Limits docs: max id size 64 bytes.
MAX_ATTR_NAME_BYTES = 128  # Limits docs: max attribute name length 128 bytes, no leading "$".

FTS_DEFAULTS = {
    # Full-text search docs: defaults for the BM25 parameters and tokenizer options.
    "k1": 1.2,
    "b": 0.75,
    "case_sensitive": False,
    "remove_stopwords": False,
    "max_token_length": 39,
}


def infer_type(value: Any) -> str | None:
    """The type a JSON value implies. None means null (which fits any type)."""
    if value is None:
        return None
    if isinstance(value, bool):  # check bool before int: in Python, True is an int
        return "bool"
    if isinstance(value, int):
        return "int"
    if isinstance(value, float):
        return "float"
    if isinstance(value, str):
        return "string"
    if isinstance(value, list):
        inner = {infer_type(v) for v in value} - {None}
        if not inner:
            return None  # an empty list doesn't tell us the element type
        if inner <= {"int", "float"} and "float" in inner:
            return "[]float"
        if len(inner) == 1 and next(iter(inner)) in SCALAR_TYPES - {"bool"}:
            return "[]" + next(iter(inner))
        raise BadRequest(f"unsupported array value {json.dumps(value)[:80]}")
    raise BadRequest(f"unsupported attribute value {json.dumps(value)[:80]}")


def fits(declared: str, value: Any) -> bool:
    """Is value acceptable for an attribute of type declared? ints are accepted for floats."""
    t = infer_type(value)
    if t is None or t == declared:
        return True
    if declared == "float" and t == "int":
        return True
    if declared == "[]float" and t == "[]int":
        return True
    return False


def normalize_attr_spec(name: str, spec: Any) -> dict:
    """Turn a schema entry ("string", or {"type": ..., ...}) into its full form."""
    if isinstance(spec, str):
        spec = {"type": spec}
    if not isinstance(spec, dict) or "type" not in spec:
        raise BadRequest(f"schema for {name!r} must be a type string or an object with 'type'")
    t = spec["type"]
    if name == VECTOR_ATTR:
        if not (isinstance(t, str) and t.startswith("[") and t.endswith("]f32")):
            raise BadRequest("temupuffer supports only '[N]f32' for the vector attribute")
        return {"type": t, "ann": True}
    if t not in SCALAR_TYPES | ARRAY_TYPES:
        raise BadRequest(f"unsupported type {t!r} for {name!r} (temupuffer supports {sorted(SCALAR_TYPES | ARRAY_TYPES)})")
    out: dict = {"type": t}
    fts = spec.get("full_text_search", False)
    if fts:
        if t not in ("string", "[]string"):
            raise BadRequest(f"full_text_search needs a string or []string attribute, {name!r} is {t}")
        opts = dict(FTS_DEFAULTS)
        if isinstance(fts, dict):
            for k, v in fts.items():
                if k in ("tokenizer",) and v not in ("word_v4", "word_v3", "whitespace"):
                    raise BadRequest(f"tokenizer {v!r} is not supported by temupuffer")
                if k in ("stemming", "ascii_folding") and v:
                    raise BadRequest(f"full_text_search.{k} is not supported by temupuffer")
                if k in ("language",) and v != "english":
                    raise BadRequest("temupuffer only supports language 'english'")
                opts[k] = v
        out["full_text_search"] = opts
    # Schema docs: filterable defaults to true, but to false when full-text
    # search is enabled (unless set explicitly).
    out["filterable"] = bool(spec.get("filterable", not fts))
    return out


def vector_dims(type_str: str) -> int:
    return int(type_str[1:].split("]", 1)[0])


def validate_id(doc_id: Any) -> None:
    # Write docs: ids are u64, UUIDs or strings up to 64 bytes.
    if isinstance(doc_id, bool) or not isinstance(doc_id, (int, str)):
        raise BadRequest(f"id must be an unsigned integer or a string, got {json.dumps(doc_id)[:40]}")
    if isinstance(doc_id, int) and not (0 <= doc_id < 2**64):
        raise BadRequest(f"integer id {doc_id} is out of the u64 range")
    if isinstance(doc_id, str) and (not doc_id or len(doc_id.encode()) > MAX_ID_BYTES):
        raise BadRequest("string ids must be 1 to 64 bytes")


def validate_attr_name(name: str) -> None:
    if not name or name.startswith("$") or len(name.encode()) > MAX_ATTR_NAME_BYTES:
        raise BadRequest(f"invalid attribute name {name!r} (1-128 bytes, must not start with '$')")


def columns_to_rows(cols: dict) -> list[dict]:
    """upsert_columns -> upsert_rows. Write docs: every column must have the same length."""
    if not isinstance(cols, dict) or "id" not in cols or not isinstance(cols["id"], list):
        raise BadRequest("upsert_columns must be an object with an 'id' array")
    n = len(cols["id"])
    for k, v in cols.items():
        if not isinstance(v, list) or len(v) != n:
            raise BadRequest(f"upsert_columns[{k!r}] must be an array of length {n}")
    return [{k: cols[k][i] for k in cols if cols[k][i] is not None or k == "id"} for i in range(n)]
