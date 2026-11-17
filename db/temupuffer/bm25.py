"""Full-text search: a tokenizer, an inverted index and BM25 scoring.

An inverted index maps each term to the documents that contain it:

    "puffer" -> [(doc 3, tf=2), (doc 9, tf=1)]
    "fish"   -> [(doc 3, tf=1)]

To answer "puffer fish" we read only those two posting lists, never the
documents that contain neither term. That's what makes text search fast.

BM25 scores a document d for a query q as a sum over the query terms:

    score(d, q) = sum over t in q of  idf(t) * tf * (k1 + 1) / (tf + k1 * (1 - b + b * |d| / avgdl))

    idf(t) = ln(1 + (N - df + 0.5) / (df + 0.5))

where tf is how often t appears in d, |d| is d's length in tokens, avgdl is
the average length, N is the number of docs and df is how many docs contain t.
k1 (default 1.2) caps how much repeating a term helps. b (default 0.75) sets
how much long documents are penalised. Those defaults come from turbopuffer's
Full-text search docs. turbopuffer also has k3 for repeated query terms;
we count a repeated query term once.

The docs don't say whether a multi-term query is OR or AND. We use OR (any
term contributes), which is standard BM25. ``ContainsAllTokens`` is the AND
filter.

The tokenizer is much simpler than turbopuffer's word_v4 (Unicode UAX #29):
lowercase, split on runs of letters and digits, and drop tokens longer than
max_token_length (default 39). There's no stemming, and stopword removal is
optional.
"""

from __future__ import annotations

import math
import re

_WORD = re.compile(r"\w+", re.UNICODE)

STOPWORDS = frozenset(
    "a an and are as at be but by for if in into is it no not of on or such that the their "
    "then there these they this to was will with".split()
)


def tokenize(text: str, opts: dict | None = None) -> list[str]:
    opts = opts or {}
    if not isinstance(text, str):
        return []
    if not opts.get("case_sensitive", False):
        text = text.lower()
    max_len = opts.get("max_token_length", 39)
    tokens = [t for t in _WORD.findall(text) if len(t) <= max_len]
    if opts.get("remove_stopwords", False):
        tokens = [t for t in tokens if t not in STOPWORDS]
    return tokens


def text_of(value) -> str:
    """[]string attributes are indexed as if their elements were one text."""
    if isinstance(value, list):
        return " ".join(v for v in value if isinstance(v, str))
    return value if isinstance(value, str) else ""


def idf(n_docs: int, df: int) -> float:
    return math.log(1 + (n_docs - df + 0.5) / (df + 0.5))


def term_score(tf: int, doc_len: int, avgdl: float, idf_t: float, k1: float, b: float) -> float:
    norm = k1 * (1 - b + b * doc_len / avgdl) if avgdl > 0 else k1
    return idf_t * tf * (k1 + 1) / (tf + norm)


def build_postings(texts: list[str | None], opts: dict) -> tuple[dict[str, tuple[list[int], list[int]]], list[int]]:
    """Inverted index for one attribute over one segment.

    Returns (postings, doc_lengths): postings[term] = ([positions], [tfs]).
    Two flat lists per term, not a list of [position, tf] pairs: a pair is its
    own Python list (~72 bytes), which made a 100k-abstract compaction run out
    of memory. Flat lists cost ~16 bytes per posting.
    """
    postings: dict[str, tuple[list[int], list[int]]] = {}
    lengths: list[int] = []
    for pos, text in enumerate(texts):
        toks = tokenize(text or "", opts)
        lengths.append(len(toks))
        counts: dict[str, int] = {}
        for t in toks:
            counts[t] = counts.get(t, 0) + 1
        for t, c in counts.items():
            pl = postings.get(t)
            if pl is None:
                pl = postings[t] = ([], [])
            pl[0].append(pos)
            pl[1].append(c)
    return postings, lengths
