"""Attribute filters, evaluated two ways that must always agree.

Query docs syntax:

    ["category", "Eq", "news"]
    ["year", "Gte", 2020]
    ["And", [ f1, f2, ... ]]     ["Or", [ ... ]]     ["Not", f]

Supported operators: Eq NotEq In NotIn Lt Lte Gt Gte Contains NotContains
ContainsAny NotContainsAny ContainsAllTokens. (turbopuffer has more, such as
Glob, Regex, Fuzzy and the Any* comparisons. See docs/compat.md.)

The two evaluators:

* ``matches(f, row)`` checks one row (a dict). Used for the unindexed WAL tail,
  which by definition has no index, so this is the brute-force path.
* ``mask(f, segment)`` returns a numpy boolean array over a whole indexed
  segment and uses the segment's exact inverted index where it can. The
  Architecture docs say metadata filters use "an exact inverted index".

``test_filters.py`` generates random filters and checks that both evaluators
return the same rows.

Null semantics: a missing attribute is null. ``Eq null`` matches missing
values (Query docs). Comparisons (Lt/Gt...) never match null. ``NotEq x``
matches null because it's defined as "not Eq x". The docs don't spell that
last rule out, so treat it as our choice.
"""

from __future__ import annotations

import bisect
from typing import Any

import numpy as np

from .errors import BadRequest

LEAF_OPS = {"Eq", "NotEq", "In", "NotIn", "Lt", "Lte", "Gt", "Gte",
            "Contains", "NotContains", "ContainsAny", "NotContainsAny", "ContainsAllTokens"}
NEGATED = {"NotEq": "Eq", "NotIn": "In", "NotContains": "Contains", "NotContainsAny": "ContainsAny"}


def validate(f: Any) -> None:
    """Raise BadRequest unless f is a well-formed filter."""
    if not isinstance(f, list) or not f:
        raise BadRequest(f"filter must be a non-empty array, got {f!r}")
    if f[0] in ("And", "Or"):
        if len(f) != 2 or not isinstance(f[1], list) or not f[1]:
            raise BadRequest(f'{f[0]} takes a list of filters: ["{f[0]}", [f1, f2]]')
        for sub in f[1]:
            validate(sub)
        return
    if f[0] == "Not":
        if len(f) != 2:
            raise BadRequest('Not takes one filter: ["Not", f]')
        validate(f[1])
        return
    if len(f) != 3 or not isinstance(f[0], str):
        raise BadRequest(f"filter must be [attribute, op, value], got {f!r}")
    op, value = f[1], f[2]
    if op not in LEAF_OPS:
        raise BadRequest(f"unsupported filter op {op!r} (temupuffer supports {sorted(LEAF_OPS)})")
    if op in ("In", "NotIn", "ContainsAny", "NotContainsAny") and not isinstance(value, list):
        raise BadRequest(f"{op} takes an array value")


def _comparable(a: Any, b: Any) -> bool:
    num = (int, float)
    if isinstance(a, bool) or isinstance(b, bool):
        return False
    return (isinstance(a, num) and isinstance(b, num)) or (isinstance(a, str) and isinstance(b, str))


def _leaf(op: str, v: Any, target: Any) -> bool:
    if op in NEGATED:
        return not _leaf(NEGATED[op], v, target)
    if op == "Eq":
        return v == target
    if op == "In":
        return v is not None and not isinstance(v, list) and v in target
    if op in ("Lt", "Lte", "Gt", "Gte"):
        if v is None or isinstance(v, list) or not _comparable(v, target):
            return False
        return {"Lt": v < target, "Lte": v <= target, "Gt": v > target, "Gte": v >= target}[op]
    if op == "Contains":
        return isinstance(v, list) and target in v
    if op == "ContainsAny":
        return isinstance(v, list) and any(t in v for t in target)
    if op == "ContainsAllTokens":
        from .bm25 import tokenize

        text = " ".join(v) if isinstance(v, list) else v
        return isinstance(text, str) and set(tokenize(target)) <= set(tokenize(text))
    raise BadRequest(f"unsupported op {op}")


def matches(f: list, row: dict) -> bool:
    """Brute-force evaluation of one row."""
    head = f[0]
    if head == "And":
        return all(matches(s, row) for s in f[1])
    if head == "Or":
        return any(matches(s, row) for s in f[1])
    if head == "Not":
        return not matches(f[1], row)
    attr, op, target = f
    return _leaf(op, row.get(attr), target)


# --- Index-backed evaluation over a segment -----------------------------------
#
# A segment exposes, per filterable attribute:
#   seg.eq_index[attr]    : {value: np.array of row positions}  (for arrays: per element)
#   seg.range_index[attr] : (sorted values list, np.array of positions)  numeric scalars only
#   seg.array_attrs       : set of attributes whose values are arrays
#   seg.rows(i)           : the attributes of row i (for the fallback path)


def mask(f: list, seg) -> np.ndarray:
    n = seg.count
    head = f[0]
    if head == "And":
        out = np.ones(n, dtype=bool)
        for s in f[1]:
            out &= mask(s, seg)
        return out
    if head == "Or":
        out = np.zeros(n, dtype=bool)
        for s in f[1]:
            out |= mask(s, seg)
        return out
    if head == "Not":
        return ~mask(f[1], seg)
    attr, op, target = f
    if op in NEGATED:
        return ~mask([attr, NEGATED[op], target], seg)

    eq = seg.eq_index.get(attr)
    is_array = attr in seg.array_attrs
    out = np.zeros(n, dtype=bool)

    if eq is not None and not is_array and op == "Eq" and target is not None and not isinstance(target, list):
        out[eq.get(target, _EMPTY)] = True
        return out
    if eq is not None and not is_array and op == "In" and all(not isinstance(t, list) for t in target):
        for t in target:
            if t is not None:
                out[eq.get(t, _EMPTY)] = True
        return out
    if eq is not None and is_array and op == "Contains" and not isinstance(target, list):
        out[eq.get(target, _EMPTY)] = True
        return out
    if eq is not None and is_array and op == "ContainsAny":
        for t in target:
            if not isinstance(t, list):
                out[eq.get(t, _EMPTY)] = True
        return out
    rng = seg.range_index.get(attr)
    if rng is not None and op in ("Lt", "Lte", "Gt", "Gte") and isinstance(target, (int, float)) \
            and not isinstance(target, bool):
        values, positions = rng
        if op == "Lt":
            sel = positions[:bisect.bisect_left(values, target)]
        elif op == "Lte":
            sel = positions[:bisect.bisect_right(values, target)]
        elif op == "Gt":
            sel = positions[bisect.bisect_right(values, target):]
        else:
            sel = positions[bisect.bisect_left(values, target):]
        out[sel] = True
        return out

    # No usable index (unfilterable attribute, null target, string range, tokens...):
    # fall back to checking each row. Same answer, just slower.
    for i in range(n):
        out[i] = _leaf(op, seg.attr_value(i, attr), target)
    return out


_EMPTY = np.zeros(0, dtype=np.int64)
