"""Concurrent misses on one segment must parse it once (each parse of a big segment costs hundreds of MiB)."""

import threading
import time
from concurrent.futures import ThreadPoolExecutor

from temupuffer.cache import NodeCache
from temupuffer.storage import MemoryStore


def test_concurrent_misses_parse_once(tmp_path):
    store = MemoryStore()
    store.put("seg/a", b"x" * 100)
    cache = NodeCache(store, str(tmp_path), 10_000_000, 10_000_000)
    parses = []
    lock = threading.Lock()

    def parse(files):
        with lock:
            parses.append(1)
        time.sleep(0.2)  # a slow parse, so the other callers arrive while it runs
        return object()

    with ThreadPoolExecutor(8) as pool:
        objs = list(pool.map(lambda _: cache.load_many("seg:a", ["seg/a"], parse), range(8)))
    assert len(parses) == 1
    assert all(o is objs[0] for o in objs)


def test_a_failed_load_lets_the_next_caller_retry(tmp_path):
    store = MemoryStore()
    store.put("seg/b", b"y")
    cache = NodeCache(store, str(tmp_path), 10_000_000, 10_000_000)
    calls = []

    def flaky(files):
        calls.append(1)
        if len(calls) == 1:
            raise RuntimeError("boom")
        return "ok"

    try:
        cache.load_many("seg:b", ["seg/b"], flaky)
    except RuntimeError:
        pass
    assert cache.load_many("seg:b", ["seg/b"], flaky) == "ok"
