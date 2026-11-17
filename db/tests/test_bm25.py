"""BM25: the formula, and that the engine ranks text sensibly."""

import math

import pytest

from temupuffer import bm25


def test_tokenizer():
    assert bm25.tokenize("Hello, World! hello-42") == ["hello", "world", "hello", "42"]
    assert bm25.tokenize("The cat", {"remove_stopwords": True}) == ["cat"]
    assert bm25.tokenize("Case", {"case_sensitive": True}) == ["Case"]
    assert bm25.tokenize("x" * 40 + " ok") == ["ok"]  # longer than max_token_length (39) is dropped


def test_term_score_matches_the_formula():
    # Hand-computed: N=10, df=2, tf=3, |d|=8, avgdl=10, k1=1.2, b=0.75
    idf = math.log(1 + (10 - 2 + 0.5) / (2 + 0.5))
    expected = idf * 3 * 2.2 / (3 + 1.2 * (1 - 0.75 + 0.75 * 8 / 10))
    assert bm25.term_score(3, 8, 10, bm25.idf(10, 2), 1.2, 0.75) == pytest.approx(expected)


def test_rare_terms_outweigh_common_ones():
    assert bm25.idf(1000, 1) > bm25.idf(1000, 500)


def test_engine_bm25_ranking(engine, indexer):
    from conftest import drain

    docs = [
        {"id": 1, "text": "the puffer fish is a fish"},
        {"id": 2, "text": "a fish"},
        {"id": 3, "text": "puffer puffer puffer"},
        {"id": 4, "text": "nothing relevant here at all"},
    ]
    engine.write("fts", {"upsert_rows": docs[:2], "schema": {"text": {"type": "string", "full_text_search": True}}})
    drain(indexer)
    engine.write("fts", {"upsert_rows": docs[2:]})  # half indexed, half in the WAL tail
    r = engine.query("fts", {"rank_by": ["text", "BM25", "puffer fish"], "limit": 10})
    ids = [row["id"] for row in r["rows"]]
    assert 4 not in ids  # score 0 is excluded
    assert set(ids) == {1, 2, 3}
    assert ids[0] == 1  # the only doc with both terms
    assert r["performance"]["exhaustive_search_count"] == 2

    # Sum and Product combine clauses
    r2 = engine.query("fts", {"rank_by": ["Sum", [["Product", 3, ["text", "BM25", "puffer"]],
                                                  ["text", "BM25", "fish"]]], "limit": 3})
    assert r2["rows"][0]["id"] == 3
