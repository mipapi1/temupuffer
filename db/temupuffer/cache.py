"""The node cache: memory, then local disk, then object storage.

turbopuffer caches namespaces on NVMe SSD and in memory, and a query node
keeps a namespace cached after its first query (Architecture docs). Our
version:

    tier     what's there                          cost on a hit     turbopuffer name
    ------   -----------------------------------   ---------------   ----------------
    memory   parsed objects (Segment, WAL dicts)   ~0 ms             "hot"
    disk     raw bytes in CACHE_DIR (an emptyDir)  read + parse      "warm"
    S3       everything                            ~1 round trip     "cold"

Only *immutable* objects go through this cache: WAL entries and segment
files. Because they never change, a cached copy is never stale and there's no
invalidation logic. Cache keys include the object's etag (or a random segment
id), so even a key reused after a namespace is deleted and recreated can't
return old bytes. The two mutable objects a query needs (manifest.json and
the WAL head) are re-checked on every strong query instead.

Each query reports the slowest tier it had to touch as ``cache_temperature``
("cold" if anything came from S3), plus ``cache_hit_ratio``. Those are the
names of turbopuffer's ``performance`` fields.

Eviction is least-recently-used (LRU) in both tiers, by bytes.
"""

from __future__ import annotations

import contextvars
import hashlib
import os
import threading
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Callable

from .storage import ObjectStore


@dataclass
class CacheStats:
    memory_hits: int = 0
    disk_hits: int = 0
    misses: int = 0

    def temperature(self) -> str:
        if self.misses:
            return "cold"
        if self.disk_hits:
            return "warm"
        return "hot"

    def hit_ratio(self) -> float:
        total = self.memory_hits + self.disk_hits + self.misses
        return 1.0 if total == 0 else round((self.memory_hits + self.disk_hits) / total, 3)


current_cache_stats: contextvars.ContextVar[CacheStats | None] = contextvars.ContextVar(
    "current_cache_stats", default=None
)


class NodeCache:
    def __init__(self, store: ObjectStore, cache_dir: str, disk_bytes: int, memory_bytes: int):
        self.store = store
        self.dir = cache_dir
        self.disk_cap = disk_bytes
        self.mem_cap = memory_bytes
        self.mem: OrderedDict[str, tuple[object, int]] = OrderedDict()
        self.mem_used = 0
        self.disk: OrderedDict[str, int] = OrderedDict()  # cache file name -> size
        self.disk_used = 0
        self.lock = threading.Lock()
        self.loading: dict[str, threading.Event] = {}  # load_many single-flight: key -> done
        self.totals = CacheStats()  # lifetime, for the console
        self.io = ThreadPoolExecutor(max_workers=32, thread_name_prefix="cache-io")
        os.makedirs(self.dir, exist_ok=True)
        # The disk tier survives a container restart (an emptyDir outlives the
        # container, though not the pod), so pick up whatever is already there.
        for name in sorted(os.listdir(self.dir), key=lambda n: os.path.getatime(os.path.join(self.dir, n))):
            size = os.path.getsize(os.path.join(self.dir, name))
            self.disk[name] = size
            self.disk_used += size

    def _record(self, tier: str) -> None:
        stats = current_cache_stats.get()
        with self.lock:
            for s in (self.totals, stats):
                if s is None:
                    continue
                if tier == "memory":
                    s.memory_hits += 1
                elif tier == "disk":
                    s.disk_hits += 1
                else:
                    s.misses += 1

    # --- memory tier ---

    def mem_get(self, key: str):
        with self.lock:
            hit = self.mem.get(key)
            if hit is None:
                return None
            self.mem.move_to_end(key)
            return hit[0]

    def mem_put(self, key: str, obj: object, nbytes: int) -> None:
        with self.lock:
            if key in self.mem:
                self.mem_used -= self.mem.pop(key)[1]
            self.mem[key] = (obj, nbytes)
            self.mem_used += nbytes
            while self.mem_used > self.mem_cap and len(self.mem) > 1:
                _, (_, size) = self.mem.popitem(last=False)
                self.mem_used -= size

    # --- disk tier + S3 ---

    @staticmethod
    def _fname(key: str) -> str:
        return hashlib.sha1(key.encode()).hexdigest()

    def get_bytes(self, key: str, etag: str = "") -> tuple[bytes, str]:
        """Raw bytes of an immutable object, from disk or S3. Returns (bytes, tier)."""
        name = self._fname(key + "@" + etag)
        path = os.path.join(self.dir, name)
        with self.lock:
            on_disk = name in self.disk
            if on_disk:
                self.disk.move_to_end(name)
        if on_disk:
            try:
                with open(path, "rb") as f:
                    return f.read(), "disk"
            except FileNotFoundError:
                pass
        body, _ = self.store.get(key)
        self._disk_put(name, path, body)
        return body, "s3"

    def _disk_put(self, name: str, path: str, body: bytes) -> None:
        tmp = f"{path}.{threading.get_ident()}.tmp"
        with open(tmp, "wb") as f:
            f.write(body)
        os.replace(tmp, path)  # atomic: a reader never sees a half-written file
        evict = []
        with self.lock:
            if name not in self.disk:
                self.disk[name] = len(body)
                self.disk_used += len(body)
            while self.disk_used > self.disk_cap and len(self.disk) > 1:
                old, size = self.disk.popitem(last=False)
                self.disk_used -= size
                evict.append(old)
        for old in evict:
            try:
                os.remove(os.path.join(self.dir, old))
            except FileNotFoundError:
                pass

    def load(self, key: str, parse: Callable[[bytes], object], etag: str = "") -> object:
        """One immutable object, parsed. Memory -> disk -> S3."""
        mem_key = key + "@" + etag
        obj = self.mem_get(mem_key)
        if obj is not None:
            self._record("memory")
            return obj
        body, tier = self.get_bytes(key, etag)
        self._record("disk" if tier == "disk" else "miss")
        obj = parse(body)
        self.mem_put(mem_key, obj, len(body))
        return obj

    def load_many(self, mem_key: str, keys_: list[str], parse_all: Callable[[dict[str, bytes]], object],
                  remember: bool = True) -> object:
        """Several files parsed into one object (a segment). Files are fetched in parallel.

        This uses the cache's own thread pool. Callers already run inside the
        engine's pool, and a task that waits on work submitted to its *own*
        bounded pool can deadlock when the pool is full.
        """
        # Single-flight: concurrent misses on the same segment parse it once. Without
        # this, 8 concurrent cold queries on a 100k-row namespace parsed 8 copies of
        # every segment and OOMKilled the query pod.
        while True:
            obj = self.mem_get(mem_key)
            if obj is not None:
                self._record("memory")
                return obj
            with self.lock:
                waiting = self.loading.get(mem_key)
                if waiting is None:
                    done = self.loading[mem_key] = threading.Event()
                    break
            waiting.wait()
            if not remember:
                break  # the loader didn't keep it in memory either; load our own
        try:
            ctx = contextvars.copy_context()
            results = list(self.io.map(lambda k: ctx.copy().run(self.get_bytes, k), keys_))
            for _, tier in results:
                self._record("disk" if tier == "disk" else "miss")
            files = {k: body for k, (body, _) in zip(keys_, results)}
            obj = parse_all(files)
            if remember:
                self.mem_put(mem_key, obj, sum(len(b) for b in files.values()))
            return obj
        finally:
            if waiting is None:
                with self.lock:
                    self.loading.pop(mem_key, None)
                done.set()

    def drop_prefix(self, prefix: str) -> None:
        """Forget in-memory objects for a deleted namespace. Disk files age out by LRU."""
        with self.lock:
            for k in [k for k in self.mem if k.startswith(prefix)]:
                self.mem_used -= self.mem.pop(k)[1]

    def snapshot(self) -> dict:
        with self.lock:
            return {
                "memory_bytes": self.mem_used, "memory_entries": len(self.mem), "memory_cap": self.mem_cap,
                "disk_bytes": self.disk_used, "disk_entries": len(self.disk), "disk_cap": self.disk_cap,
                "memory_hits": self.totals.memory_hits, "disk_hits": self.totals.disk_hits,
                "misses": self.totals.misses,
            }
