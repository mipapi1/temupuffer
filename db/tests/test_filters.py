"""Index-backed filters must return exactly what brute force returns."""

import random

import numpy as np
import pytest

from temupuffer import filters, segment
from temupuffer.errors import BadRequest

META = {"distance_metric": None, "dims": None, "schema": {
    "cat": {"type": "string", "filterable": True},
    "year": {"type": "int", "filterable": True},
    "price": {"type": "float", "filterable": True},
    "tags": {"type": "[]string", "filterable": True},
    "title": {"type": "string", "filterable": False, "full_text_search": {"k1": 1.2, "b": 0.75}},
}}


def make_rows(n=300, seed=1):
    rng = random.Random(seed)
    rows = []
    for i in range(n):
        r = {"id": i, "cat": rng.choice(["news", "sport", "tech", None]), "year": rng.randint(2000, 2024),
             "price": round(rng.uniform(0, 100), 2), "tags": rng.sample(["a", "b", "c", "d"], rng.randint(0, 3)),
             "title": rng.choice(["quick brown fox", "lazy dog", "brown dog jumps"])}
        rows.append({k: v for k, v in r.items() if v is not None})
    return rows


def build_seg(rows):
    latest = {r["id"]: (i, r) for i, r in enumerate(rows)}
    return segment.parse("t", segment.build(latest, META, ann_min_rows=10_000))


def random_filter(rng, depth=0):
    if depth < 2 and rng.random() < 0.35:
        op = rng.choice(["And", "Or", "Not"])
        if op == "Not":
            return ["Not", random_filter(rng, depth + 1)]
        return [op, [random_filter(rng, depth + 1) for _ in range(rng.randint(2, 3))]]
    leaf = rng.choice([
        lambda: ["cat", rng.choice(["Eq", "NotEq"]), rng.choice(["news", "tech", None])],
        lambda: ["cat", rng.choice(["In", "NotIn"]), rng.sample(["news", "sport", "tech"], 2)],
        lambda: ["year", rng.choice(["Lt", "Lte", "Gt", "Gte", "Eq"]), rng.randint(1999, 2025)],
        lambda: ["price", rng.choice(["Lt", "Gte"]), rng.uniform(0, 100)],
        lambda: ["tags", rng.choice(["Contains", "NotContains"]), rng.choice(["a", "b", "z"])],
        lambda: ["tags", "ContainsAny", rng.sample(["a", "c", "z"], 2)],
        lambda: ["title", "ContainsAllTokens", rng.choice(["brown", "brown dog", "cat"])],
        lambda: ["id", "In", rng.sample(range(300), 5)],
    ])
    return leaf()


def test_index_and_brute_force_agree_on_random_filters():
    rows = make_rows()
    seg = build_seg(rows)
    rng = random.Random(7)
    for _ in range(400):
        f = random_filter(rng)
        expected = {r["id"] for r in rows if filters.matches(f, r)}
        got = {seg.ids[i] for i in np.nonzero(filters.mask(f, seg))[0]}
        assert got == expected, f


def test_null_semantics():
    rows = [{"id": 1, "cat": "a"}, {"id": 2}]
    assert [r["id"] for r in rows if filters.matches(["cat", "Eq", None], r)] == [2]
    assert [r["id"] for r in rows if filters.matches(["cat", "NotEq", "a"], r)] == [2]
    assert [r["id"] for r in rows if filters.matches(["cat", "Lt", "z"], r)] == [1]


@pytest.mark.parametrize("bad", [[], ["And", []], ["x", "Like", 1], ["x", "In", 3], "x"])
def test_invalid_filters_are_rejected(bad):
    with pytest.raises(BadRequest):
        filters.validate(bad)
