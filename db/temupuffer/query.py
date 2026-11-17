"""Query execution over a Snapshot (indexed segments + the unindexed tail).

Every query searches two kinds of data and merges the results:

    indexed segments   use the index (clusters for ANN, postings for BM25,
                       inverted index for filters). Cost grows slowly with size.
    unindexed tail     brute force over every row. Cost grows linearly. Its
                       row count is ``exhaustive_search_count`` in the
                       performance block, the same field turbopuffer returns.

Supported rank_by forms (Query docs):

    ["vector", "ANN", [..]]                approximate nearest neighbours
    ["vector", "kNN", [..]]                exact (exhaustive) nearest neighbours
    ["text", "BM25", "query string"]       full-text relevance
    ["Sum", [e1, e2]]  ["Max", [e1, e2]]   combine BM25 clauses
    ["Product", 2.0, e]                    weight a clause
    ["year", "desc"]  or  [["a","asc"],["b","desc"]]   order by attributes

Also: filters, limit / top_k (max 10,000), include_attributes, and
aggregate_by with Count. ``$dist`` is the distance (vectors, smaller is
better) or the score (BM25, larger is better).
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from . import bm25, filters as filt, vector
from .errors import BadRequest
from .schema import VECTOR_ATTR
from .views import Snapshot

MAX_LIMIT = 10_000  # Limits docs: max limit.total 10k.


@dataclass
class Hit:
    score: float
    source: int  # segment index, or -1 for the tail
    pos: int  # position in the segment, or index into snapshot.tail_docs


class QueryRunner:
    def __init__(self, snap: Snapshot, meta: dict, settings):
        self.snap = snap
        self.meta = meta
        self.settings = settings
        self.metric = meta.get("distance_metric")
        self.schema = meta.get("schema", {})
        self.exhaustive = 0  # unindexed rows scanned by this query

    # --- top level -------------------------------------------------------------

    def run(self, q: dict) -> dict:
        allowed = {"rank_by", "top_k", "limit", "filters", "include_attributes", "aggregate_by",
                   "exclude_attributes", "vector_encoding"}
        unknown = set(q) - allowed - {"consistency"}
        if unknown:
            raise BadRequest(f"unsupported query parameter(s) {sorted(unknown)} (see docs/compat.md)")
        f = q.get("filters")
        if f is not None:
            filt.validate(f)
        seg_masks, tail_ok = self._filter(f)

        if "aggregate_by" in q:
            if "rank_by" in q:
                raise BadRequest("aggregate_by cannot be combined with rank_by")
            return {"aggregations": self._aggregate(q["aggregate_by"], seg_masks, tail_ok)}

        rank_by = q.get("rank_by")
        if rank_by is None:
            raise BadRequest("rank_by is required (unless aggregate_by is set)")
        limit = self._limit(q)
        include = q.get("include_attributes", ["id"])
        if "exclude_attributes" in q:
            if "include_attributes" in q:
                raise BadRequest("include_attributes and exclude_attributes are mutually exclusive")
            include = ("exclude", q["exclude_attributes"])

        if self._is_order_by(rank_by):
            hits = self._order_by(rank_by, seg_masks, tail_ok, limit)
            return {"rows": [self._row(h, include, with_dist=False) for h in hits]}
        if isinstance(rank_by, list) and len(rank_by) == 3 and rank_by[1] in ("ANN", "kNN"):
            hits = self._vector(rank_by, seg_masks, tail_ok, limit)
        else:
            hits = self._text(rank_by, seg_masks, tail_ok, limit)
        return {"rows": [self._row(h, include) for h in hits]}

    @staticmethod
    def _limit(q: dict) -> int:
        limit = q.get("limit", q.get("top_k", 10))
        if isinstance(limit, dict):
            if "per" in limit:
                raise BadRequest("limit.per is not supported by temupuffer")
            limit = limit.get("total", 10)
        if not isinstance(limit, int) or not (1 <= limit <= MAX_LIMIT):
            raise BadRequest(f"limit must be an integer from 1 to {MAX_LIMIT}")
        return limit

    # --- filters ---------------------------------------------------------------

    def _filter(self, f) -> tuple[list[np.ndarray], list[bool]]:
        """Candidate masks: live rows that pass the filter, per segment and for the tail."""
        masks = []
        for seg, live in zip(self.snap.segments, self.snap.live):
            masks.append(live & filt.mask(f, seg) if f is not None else live)
        tail = self.snap.tail_docs
        self.exhaustive = len(tail)
        tail_ok = [filt.matches(f, row) for row in tail] if f is not None else [True] * len(tail)
        return masks, tail_ok

    # --- vectors ---------------------------------------------------------------

    def _vector(self, rank_by: list, seg_masks, tail_ok, limit: int) -> list[Hit]:
        attr, kind, q = rank_by
        if attr != VECTOR_ATTR:
            raise BadRequest("temupuffer has one vector column, named 'vector'")
        if self.meta.get("dims") is None:
            raise BadRequest("this namespace has no vectors")
        if not isinstance(q, list) or len(q) != self.meta["dims"]:
            raise BadRequest(f"query vector must have {self.meta['dims']} dims")
        qv = np.asarray(q, dtype=np.float32)
        hits: list[Hit] = []
        for si, (seg, m) in enumerate(zip(self.snap.segments, seg_masks)):
            if seg.vectors is None or not m.any():
                continue
            cand = self._ann_candidates(seg, m, qv, limit) if (kind == "ANN" and seg.clusters) else np.nonzero(m)[0]
            d = vector.distances(seg.vectors[cand], qv, self.metric)
            hits += [Hit(dist, si, pos) for dist, pos in vector.top_k(d, cand, limit)]
        # The unindexed tail: brute force, no index exists yet.
        tail_pos = np.asarray([i for i, ok in enumerate(tail_ok) if ok], dtype=np.int64)
        if len(tail_pos):
            tv = vector.prepare(np.asarray([self.snap.tail_docs[i][VECTOR_ATTR] for i in tail_pos]), self.metric)
            d = vector.distances(tv, qv, self.metric)
            hits += [Hit(dist, -1, pos) for dist, pos in vector.top_k(d, tail_pos, limit)]
        hits.sort(key=lambda h: h.score)
        return hits[:limit]

    def _ann_candidates(self, seg, m: np.ndarray, qv: np.ndarray, limit: int) -> np.ndarray:
        """Probe the nearest clusters until we've probed enough AND have enough matching rows.

        With a selective filter, the nearest clusters may hold few rows that
        pass it, so we keep probing further clusters until we have at least
        `limit` candidates. (turbopuffer's ANN is also filter-aware. How it
        does that isn't documented in detail.)
        """
        c = seg.clusters
        q = vector.prepare(qv.reshape(1, -1), self.metric)[0]
        order = vector.probe_order(c, q)
        k = len(order)
        want = vector.n_probe(k, self.settings.ann_probe_fraction, self.settings.ann_min_probe)
        out, found = [], 0
        for n, cluster in enumerate(order):
            members = c["order"][c["offsets"][cluster]:c["offsets"][cluster + 1]]
            members = members[m[members]]
            out.append(members)
            found += len(members)
            if n + 1 >= want and found >= limit:
                break
        return np.concatenate(out) if out else np.zeros(0, dtype=np.int64)

    # --- full text -------------------------------------------------------------

    def _text(self, expr, seg_masks, tail_ok, limit: int) -> list[Hit]:
        seg_scores, tail_scores = self._score(expr)
        hits: list[Hit] = []
        for si, (scores, m) in enumerate(zip(seg_scores, seg_masks)):
            s = np.where(m, scores, 0.0)
            pos = np.nonzero(s > 0)[0]  # Query docs: documents with score 0 are excluded
            if len(pos) > limit:
                pos = pos[np.argpartition(-s[pos], limit - 1)[:limit]]
            hits += [Hit(float(s[p]), si, int(p)) for p in pos]
        hits += [Hit(float(sc), -1, i) for i, sc in enumerate(tail_scores) if tail_ok[i] and sc > 0]
        hits.sort(key=lambda h: -h.score)
        return hits[:limit]

    def _score(self, expr) -> tuple[list[np.ndarray], np.ndarray]:
        """Evaluate a rank_by expression to dense score arrays (one per segment, one for the tail)."""
        if not isinstance(expr, list) or not expr:
            raise BadRequest(f"invalid rank_by {expr!r}")
        head = expr[0]
        if head in ("Sum", "Max"):
            if len(expr) != 2 or not isinstance(expr[1], list) or not expr[1]:
                raise BadRequest(f'{head} takes a list: ["{head}", [clause, clause]]')
            parts = [self._score(e) for e in expr[1]]
            combine = np.add if head == "Sum" else np.maximum
            segs = [parts[0][0][i].copy() for i in range(len(self.snap.segments))]
            tail = parts[0][1].copy()
            for s, t in parts[1:]:
                segs = [combine(a, b) for a, b in zip(segs, s)]
                tail = combine(tail, t)
            return segs, tail
        if head == "Product":
            if len(expr) != 3:
                raise BadRequest('Product takes a weight and a clause: ["Product", 2, clause]')
            w, clause = (expr[1], expr[2]) if isinstance(expr[1], (int, float)) else (expr[2], expr[1])
            if not isinstance(w, (int, float)) or w < 0:
                raise BadRequest("Product weight must be a non-negative number")
            s, t = self._score(clause)
            return [a * w for a in s], t * w
        if len(expr) == 3 and expr[1] == "BM25":
            return self._bm25(expr[0], expr[2])
        if len(expr) == 3 and expr[1] in filt.LEAF_OPS:
            # Query docs: a filter used as a rank_by clause scores 1 if it matches, else 0.
            segs = [filt.mask(expr, seg).astype(np.float64) for seg in self.snap.segments]
            tail = np.asarray([1.0 if filt.matches(expr, r) else 0.0 for r in self.snap.tail_docs])
            return segs, tail
        raise BadRequest(f"unsupported rank_by expression {expr!r} (see docs/compat.md)")

    def _bm25(self, attr: str, text: str) -> tuple[list[np.ndarray], np.ndarray]:
        spec = self.schema.get(attr) or {}
        opts = spec.get("full_text_search")
        if not opts:
            raise BadRequest(f"attribute {attr!r} does not have full_text_search enabled in the schema")
        if not isinstance(text, str) or len(text) > 8192:  # Limits docs: max full-text query length 8,192
            raise BadRequest("BM25 query must be a string of at most 8192 characters")
        terms = list(dict.fromkeys(bm25.tokenize(text, opts)))  # unique, in order
        k1, b = float(opts.get("k1", 1.2)), float(opts.get("b", 0.75))

        # Per-segment inverted indexes. A segment built before full_text_search
        # was enabled has no index for attr, so build one on the fly (and keep it).
        # turbopuffer instead returns 409 until the new index is built (Schema docs).
        seg_fts = []
        for seg in self.snap.segments:
            f = seg.fts.get(attr)
            if f is None:
                texts = [bm25.text_of(a.get(attr)) if a else None for a in seg.attrs]
                postings, lengths = bm25.build_postings(texts, opts)
                f = {"postings": {t: (np.asarray(ps, dtype=np.int64), np.asarray(cs, dtype=np.int64))
                                  for t, (ps, cs) in postings.items()},
                     "lengths": np.asarray(lengths, dtype=np.int64), "opts": opts}
                seg.fts[attr] = f
            seg_fts.append(f)
        tail_tokens = [bm25.tokenize(bm25.text_of(r.get(attr)), opts) for r in self.snap.tail_docs]
        self.exhaustive = max(self.exhaustive, len(tail_tokens))

        # Collection statistics over *live* documents only (shadowed and
        # deleted versions don't count), across segments and tail.
        n_docs = sum(int(m.sum()) for m in self.snap.live) + len(tail_tokens)
        total_len = sum(int(f["lengths"][m].sum()) for f, m in zip(seg_fts, self.snap.live)) + \
            sum(len(t) for t in tail_tokens)
        avgdl = total_len / n_docs if n_docs else 0.0
        df = {}
        for t in terms:
            d = sum(int(m[f["postings"][t][0]].sum()) for f, m in zip(seg_fts, self.snap.live) if t in f["postings"])
            d += sum(1 for toks in tail_tokens if t in toks)
            df[t] = d

        seg_scores = []
        for f, seg in zip(seg_fts, self.snap.segments):
            s = np.zeros(seg.count, dtype=np.float64)
            for t in terms:
                if t not in f["postings"] or df[t] == 0:
                    continue
                pos, tf = f["postings"][t]
                dl = f["lengths"][pos]
                norm = k1 * (1 - b + b * dl / avgdl) if avgdl else k1
                s[pos] += bm25.idf(n_docs, df[t]) * tf * (k1 + 1) / (tf + norm)
            seg_scores.append(s)
        tail = np.zeros(len(tail_tokens), dtype=np.float64)
        for i, toks in enumerate(tail_tokens):
            counts: dict[str, int] = {}
            for tok in toks:
                counts[tok] = counts.get(tok, 0) + 1
            for t in terms:
                if counts.get(t):
                    tail[i] += bm25.term_score(counts[t], len(toks), avgdl, bm25.idf(n_docs, df[t]), k1, b)
        return seg_scores, tail

    # --- order by attribute -----------------------------------------------------

    @staticmethod
    def _is_order_by(rank_by) -> bool:
        if isinstance(rank_by, list) and len(rank_by) == 2 and rank_by[1] in ("asc", "desc"):
            return True
        return isinstance(rank_by, list) and bool(rank_by) and all(
            isinstance(x, list) and len(x) == 2 and x[1] in ("asc", "desc") for x in rank_by)

    def _order_by(self, rank_by, seg_masks, tail_ok, limit: int) -> list[Hit]:
        keys_ = [rank_by] if isinstance(rank_by[0], str) else rank_by
        if len(keys_) > 8:
            raise BadRequest("at most 8 order-by attributes")
        hits = [Hit(0.0, si, int(p)) for si, m in enumerate(seg_masks) for p in np.nonzero(m)[0]]
        hits += [Hit(0.0, -1, i) for i, ok in enumerate(tail_ok) if ok]
        # Stable sorts from the last key to the first give a multi-key sort.
        # Query docs: nulls sort first in asc and last in desc.
        for attr, direction in reversed(keys_):
            def key(h, attr=attr):
                v = self._value(h, attr)
                return (0,) if v is None else (1, v)
            hits.sort(key=key, reverse=(direction == "desc"))
        return hits[:limit]

    # --- aggregations --------------------------------------------------------------

    def _aggregate(self, agg: dict, seg_masks, tail_ok) -> dict:
        out = {}
        for label, spec in agg.items():
            if spec != ["Count"]:
                raise BadRequest('temupuffer supports only {"label": ["Count"]} aggregations')
            out[label] = int(sum(int(m.sum()) for m in seg_masks) + sum(tail_ok))
        return out

    # --- result rows -----------------------------------------------------------------

    def _value(self, h: Hit, attr: str):
        if h.source == -1:
            return self.snap.tail_docs[h.pos].get(attr)
        return self.snap.segments[h.source].attr_value(h.pos, attr)

    def _row(self, h: Hit, include, with_dist: bool = True) -> dict:
        if h.source == -1:
            src = self.snap.tail_docs[h.pos]
            if include is True:
                row = {k: v for k, v in src.items() if k != VECTOR_ATTR}
            elif isinstance(include, tuple):
                row = {k: v for k, v in src.items() if k != VECTOR_ATTR and k not in include[1]}
                row["id"] = src["id"]
            else:
                row = {"id": src["id"], **{a: src[a] for a in include if a in src and a != "id"}}
        else:
            seg = self.snap.segments[h.source]
            if isinstance(include, tuple):
                row = seg.row(h.pos, True)
                for a in include[1]:
                    if a != "id":
                        row.pop(a, None)
            else:
                row = seg.row(h.pos, include)
        if with_dist:
            row["$dist"] = round(h.score, 6)
        return row
