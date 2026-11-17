"""Turn a search request into database queries, and the answers into result cards.

Three modes:
  keyword  BM25 on title (weighted 2x) + abstract          ["Sum", [["Product", 2, title BM25], abstract BM25]]
  vector   nearest neighbours of the query's embedding      ["vector", "ANN", v]
  hybrid   both, as one multi-query (one snapshot), fused here with reciprocal rank fusion

RRF is done client-side for both backends. turbopuffer can also do it server-side
(rerank_by RRF); temupuffer can't, and doing it here keeps the comparison fair.
"""

from __future__ import annotations

from dataclasses import dataclass, field

ATTRS = ["title", "abstract", "authors", "arxiv_id", "category", "field", "year"]
RRF_K = 60          # the constant from the original RRF paper; damps the top ranks
HYBRID_DEPTH = 40   # how many candidates each side contributes before fusion
MODES = ("hybrid", "keyword", "vector")


@dataclass
class Filters:
    field: str | None = None
    category: str | None = None
    year_min: int | None = None
    year_max: int | None = None

    def to_db(self):
        clauses = []
        if self.field:
            clauses.append(["field", "Eq", self.field])
        if self.category:
            clauses.append(["category", "Eq", self.category])
        if self.year_min:
            clauses.append(["year", "Gte", int(self.year_min)])
        if self.year_max:
            clauses.append(["year", "Lte", int(self.year_max)])
        if not clauses:
            return None
        return clauses[0] if len(clauses) == 1 else ["And", clauses]


@dataclass
class SearchRequest:
    q: str
    mode: str = "hybrid"
    filters: Filters = field(default_factory=Filters)
    consistency: str = "strong"          # strong | eventual
    limit: int = 10


def keyword_rank(q: str) -> list:
    return ["Sum", [["Product", 2, ["title", "BM25", q]], ["abstract", "BM25", q]]]


def vector_rank(v: list[float], exact: bool = False) -> list:
    return ["vector", "kNN" if exact else "ANN", v]


def consistency(level: str) -> dict:
    return {"level": "eventual"} if level == "eventual" else {"level": "strong"}


def single_body(rank_by: list, req: SearchRequest, limit: int, attrs: bool = True) -> dict:
    body: dict = {"rank_by": rank_by, "top_k": limit, "consistency": consistency(req.consistency)}
    f = req.filters.to_db()
    if f is not None:
        body["filters"] = f
    if attrs:
        body["include_attributes"] = ATTRS
    return body


def sub_query(rank_by: list, req: SearchRequest, limit: int) -> dict:
    """A multi-query member: consistency lives at the top level, not here."""
    body = single_body(rank_by, req, limit)
    body.pop("consistency")
    return body


def rrf(ranked_lists: dict[str, list[dict]], limit: int) -> list[dict]:
    """score(doc) = Σ 1 / (RRF_K + rank). Keeps each doc's rank in every list it appeared in."""
    scores: dict = {}
    docs: dict = {}
    ranks: dict = {}
    for source, rows in ranked_lists.items():
        for i, row in enumerate(rows, start=1):
            doc_id = row["id"]
            scores[doc_id] = scores.get(doc_id, 0.0) + 1.0 / (RRF_K + i)
            docs.setdefault(doc_id, row)
            ranks.setdefault(doc_id, {})[source] = i
    order = sorted(scores, key=lambda d: -scores[d])[:limit]
    return [card(docs[d], score=round(scores[d], 5), ranks=ranks[d]) for d in order]


def card(row: dict, score: float | None = None, ranks: dict | None = None) -> dict:
    out = {k: row.get(k) for k in ["id", *ATTRS]}
    out["score"] = score if score is not None else row.get("$dist")
    out["ranks"] = ranks or {}
    return out


def cards(rows: list[dict], source: str) -> list[dict]:
    return [card(r, ranks={source: i}) for i, r in enumerate(rows, start=1)]
