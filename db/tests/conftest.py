"""Shared fixtures. Every test runs against MemoryStore, so no server is needed.

Settings are scaled down so tests are fast: a 20 ms WAL gap instead of 1 s,
small backpressure limits, and a tiny ANN threshold.
"""

from __future__ import annotations

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from temupuffer import config, jobqueue  # noqa: E402
from temupuffer.engine import Engine  # noqa: E402
from temupuffer.indexer import Indexer  # noqa: E402
from temupuffer.storage import MemoryStore  # noqa: E402


@pytest.fixture
def settings(tmp_path):
    s = config.Settings()
    s.store = "memory"
    s.selftest = False
    s.wal_min_gap_s = 0.02
    s.cache_dir = str(tmp_path / "cache")
    s.backpressure_max_unindexed_rows = 1_000
    s.indexer_max_rows_per_pass = 500
    s.indexer_compact_at = 3
    s.gc_delay_s = 0
    s.ann_min_rows = 200
    s.eventual_max_staleness_s = 60
    return s


@pytest.fixture
def store():
    return MemoryStore()


@pytest.fixture
def engine(settings, store):
    return Engine(settings, store)


@pytest.fixture
def indexer(settings, store, tmp_path):
    import copy

    s = copy.copy(settings)
    s.cache_dir = str(tmp_path / "indexer-cache")  # its own cache, like its own pod
    return Indexer(s, store, worker_id="indexer-test")


def drain(indexer: Indexer, max_steps: int = 200) -> int:
    """Run the indexer until queue.json is empty. Returns the number of passes."""
    steps = 0
    while steps < max_steps:
        if not indexer.step():
            if not jobqueue.read(indexer.store)[0]["jobs"]:
                return steps
        steps += 1
    raise AssertionError("indexer did not drain")
