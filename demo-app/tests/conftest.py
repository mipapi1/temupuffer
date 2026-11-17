"""Fakes so the tests need no model download, no database and no network."""

from __future__ import annotations

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ["SAMPLE_METADATA"] = "0"   # no background sampler thread in tests

from search import config  # noqa: E402
from search.backends import Backpressure, SearchBackend  # noqa: E402


class FakeEmbedder:
    """Deterministic 384-dim vectors from the text's hash."""

    def embed(self, texts, batch_size=32):
        out = []
        for t in texts:
            h = abs(hash(t))
            out.append([((h >> (i % 60)) & 1) * 0.1 + i * 1e-4 for i in range(384)])
        return out


class FakeBackend(SearchBackend):
    """Records calls; returns canned rows. `fail_429` makes the next N writes raise Backpressure."""

    name = "fake"

    def __init__(self, rows=None):
        self.calls = []
        self.rows = rows or [{"id": i, "$dist": 0.1 * i, "title": f"doc {i}", "abstract": "a", "authors": "x",
                              "arxiv_id": f"0{i}", "category": "cs.LG", "field": "Computer Science", "year": 2020}
                             for i in range(1, 6)]
        self.fail_429 = 0
        self.written = []
        self.deleted = []

    def write(self, ns, *, upsert_rows=None, deletes=None, schema=None, distance_metric=None):
        self.calls.append(("write", ns, len(upsert_rows or []), schema is not None))
        if self.fail_429 > 0:
            self.fail_429 -= 1
            raise Backpressure("too much unindexed data")
        self.written.extend(upsert_rows or [])
        self.deleted.extend(deletes or [])
        return {"rows_affected": len(upsert_rows or []), "client_ms": 1.0}

    def query(self, ns, body):
        self.calls.append(("query", ns, body))
        return {"rows": self.rows[: body.get("top_k", 10)], "client_ms": 2.0,
                "performance": {"server_total_ms": 1.5, "cache_temperature": "hot", "exhaustive_search_count": 0}}

    def multi_query(self, ns, queries, consistency=None):
        self.calls.append(("multi_query", ns, queries, consistency))
        # second list reversed, so fusion has something to do
        return {"results": [{"rows": self.rows[: q.get("top_k", 10)][:: 1 if i == 0 else -1]}
                            for i, q in enumerate(queries)],
                "client_ms": 3.0, "performance": {"server_total_ms": 2.5, "cache_temperature": "warm"}}

    def metadata(self, ns):
        return {"approx_row_count": len(self.written), "index": {"status": "up-to-date"}}

    def delete_namespace(self, ns):
        self.calls.append(("delete", ns))


@pytest.fixture
def settings(tmp_path):
    s = config.Settings()
    s.namespace = "arxiv-test"
    s.embeddings_uri = str(tmp_path / "emb")
    return s


@pytest.fixture
def embedder():
    return FakeEmbedder()


@pytest.fixture
def backend():
    return FakeBackend()
