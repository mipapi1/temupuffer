"""Ingest arXiv into a search backend, in two stages: embed once, load many times.

    python -m search.ingest embed   --docs 100000 [--worker I --workers N]
        Reads the dataset shard by shard, embeds title + abstract, and writes
        chunk parquet files to EMBEDDINGS_URI. Resumable (existing chunks are
        skipped) and parallel: worker I of N takes every Nth chunk. In a K8s
        Indexed Job, I comes from JOB_COMPLETION_INDEX.

    python -m search.ingest load    --docs 100000 [--backend temupuffer|turbopuffer]
        Reads the chunks in order and upserts them in large batches, the way
        turbopuffer recommends. A 429 (backpressure) means "the indexer is
        behind": wait and retry the same batch. Reports progress to the API.

    python -m search.ingest cleanup [--backend ...]
        Deletes the search namespace (on turbopuffer: only the demo- prefixed one).

Embedding is the slow stage (~50-110 docs/s per CPU node), which is why it runs
once and its output is kept: the same vectors then go to temupuffer, to the Azure
stack, or to turbopuffer, so comparisons are fair.
"""

from __future__ import annotations

import argparse
import math
import os
import struct
import sys
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import httpx
import pyarrow as pa
import pyarrow.parquet as pq

from . import backends as B
from . import config, dataset

TURBOPUFFER_WARN_DOCS = 50_000


# --- stage 1: embed --------------------------------------------------------------------------


def shard_rows(shard: int) -> int:
    """Row count from the parquet footer, via two HTTP range requests (no full download)."""
    url = dataset.shard_url(shard)
    tail = _range(url, "bytes=-8")
    footer_len = struct.unpack("<I", tail[:4])[0]
    footer = _range(url, f"bytes=-{footer_len + 8}")   # footer + its length + "PAR1"
    # read_metadata wants a whole file; a leading "PAR1" + the footer block is enough for the metadata.
    return pq.read_metadata(pa.BufferReader(b"PAR1" + footer)).num_rows


def _range(url: str, rng: str) -> bytes:
    req = urllib.request.Request(url, headers={"Range": rng})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def plan_chunks(docs: int) -> list[tuple[int, int, int, int]]:
    """[(shard, k, start_row, end_row)] covering `docs` rows, interleaved across shards.

    The snapshot is ordered by recent activity, so shard 0 alone is mostly
    2025-2026 papers. Taking chunk 0 of every shard, then chunk 1 of every shard,
    and so on gives a realistic mix of years and fields at any size.
    """
    rows = [shard_rows(sh) for sh in range(dataset.SHARDS)]
    out, have, k = [], 0, 0
    while have < docs and any(k * dataset.CHUNK_ROWS < n for n in rows):
        for sh, n in enumerate(rows):
            start = k * dataset.CHUNK_ROWS
            if start >= n:
                continue
            end = min(n, start + dataset.CHUNK_ROWS)
            out.append((sh, k, start, end))
            have += end - start
            if have >= docs:
                break
        k += 1
    return out


def read_rows(path: str, start: int, end: int) -> list[dict]:
    """Rows [start, end) of a local shard, reading only the row groups that cover them."""
    pf = pq.ParquetFile(path)
    tables, offset = [], 0
    for g in range(pf.num_row_groups):
        n = pf.metadata.row_group(g).num_rows
        if offset + n > start and offset < end:
            t = pf.read_row_group(g, columns=dataset.SOURCE_COLUMNS)
            lo, hi = max(start - offset, 0), min(end - offset, n)
            tables.append(t.slice(lo, hi - lo))
        offset += n
    return pa.concat_tables(tables).to_pylist() if tables else []


def cmd_embed(a, s):
    from .embed import LocalEmbedder

    worker = a.worker if a.worker is not None else int(os.environ.get("JOB_COMPLETION_INDEX", "0"))
    store = dataset.ChunkStore(s.embeddings_uri, s.s3_endpoint)
    chunks = plan_chunks(a.docs)
    # Whole shards per worker, so each pod downloads only the shard files it needs.
    mine = [c for c in chunks if c[0] % a.workers == worker]
    todo = [c for c in mine if not store.exists(dataset.chunk_name(c[0], c[1]))]
    print(f"[embed {worker}/{a.workers}] {len(chunks)} chunks for {a.docs:,} docs; mine {len(mine)}, "
          f"to do {len(todo)} → {store.uri}", flush=True)
    if not todo:
        return
    model = LocalEmbedder(s.embed_model, s.embed_max_tokens, threads=s.embed_threads)
    os.makedirs(a.tmp, exist_ok=True)
    t_all, done = time.time(), 0
    for shard, k, start, end in todo:
        path = dataset.download_shard(shard, a.tmp)
        docs = [d for i, rec in enumerate(read_rows(path, start, end))
                if (d := dataset.to_doc(shard, start + i, rec)) is not None]
        t0 = time.time()
        vecs = model.embed([dataset.embed_text(d["title"], d["abstract"]) for d in docs], batch_size=32)
        cols = {name: [d[name] for d in docs] for name in dataset.CHUNK_SCHEMA.names if name != "vector"}
        cols["vector"] = vecs
        store.write(dataset.chunk_name(shard, k), pa.Table.from_pydict(cols, schema=dataset.CHUNK_SCHEMA))
        done += len(docs)
        rate = len(docs) / (time.time() - t0)
        print(f"[embed {worker}] chunk {shard:02d}-{k:03d}: {len(docs):,} docs, {rate:.0f} docs/s "
              f"(total {done:,} in {time.time() - t_all:.0f}s)", flush=True)
        # Free the shard file once no remaining chunk of mine needs it.
        if not any(c[0] == shard for c in todo[todo.index((shard, k, start, end)) + 1:]):
            try:
                os.remove(path)
            except OSError:
                pass


# --- stage 2: load ---------------------------------------------------------------------------


class Progress:
    def __init__(self, s, backend: str, target: int):
        self.url = s.search_api_url
        self.state = {"backend": backend, "target": target, "sent": 0, "acked": 0, "retries_429": 0,
                      "errors": 0, "started_at": time.time(), "done": False, "rows_per_s": 0.0}
        self.lock = threading.Lock()
        self._last = 0.0

    def add(self, **inc):
        with self.lock:
            for k, v in inc.items():
                self.state[k] += v
            el = time.time() - self.state["started_at"]
            self.state["rows_per_s"] = round(self.state["acked"] / el, 1) if el > 0 else 0.0

    def report(self, force: bool = False):
        now = time.time()
        if not force and now - self._last < 2:
            return
        self._last = now
        st = dict(self.state)
        print(f"[load] acked {st['acked']:,}/{st['target']:,}  {st['rows_per_s']:.0f} rows/s  "
              f"429s {st['retries_429']}  errors {st['errors']}", flush=True)
        if self.url:
            try:
                httpx.post(f"{self.url}/api/ingest/progress", json=st, timeout=5)
            except httpx.HTTPError:
                pass


def iter_rows(store: dataset.ChunkStore, docs: int, skip: int):
    """Rows as upsert dicts: the first `docs` rows of the chunks, in order, after skipping `skip`."""
    sent, seen = 0, 0
    for name in store.names():
        t = store.read(name)
        rows = t.to_pylist()
        for r in rows:
            seen += 1
            if seen <= skip:
                continue
            r["vector"] = [round(x, 5) for x in r["vector"]]   # 5 decimals: ~half the JSON, same ranking
            yield r
            sent += 1
            if sent >= docs:
                return


def cmd_load(a, s):
    if a.backend == "turbopuffer" and a.docs > TURBOPUFFER_WARN_DOCS and not a.yes_large:
        print(f"Refusing to write {a.docs:,} docs to turbopuffer (paid) without --yes-large. "
              f"The default limit is {TURBOPUFFER_WARN_DOCS:,}.", file=sys.stderr)
        sys.exit(2)
    store = dataset.ChunkStore(s.embeddings_uri, s.s3_endpoint)
    if not store.names():
        print(f"No embedding chunks in {store.uri}. Run `embed` first.", file=sys.stderr)
        sys.exit(1)
    backend = B.make(a.backend, s)
    prog = Progress(s, a.backend, a.docs)

    # The first write sets the schema and the distance metric.
    first = True
    pending: list[dict] = []
    pool = ThreadPoolExecutor(max_workers=a.concurrency)
    futures = []
    sem = threading.Semaphore(a.concurrency * 2)

    def send(rows: list[dict], with_schema: bool):
        delay = 1.0
        while True:
            try:
                kw = {"schema": dataset.SCHEMA, "distance_metric": "cosine_distance"} if with_schema else {}
                backend.write(s.namespace, upsert_rows=rows, **kw)
                prog.add(acked=len(rows))
                break
            except B.Backpressure:
                prog.add(retries_429=1)
                time.sleep(delay)
                delay = min(delay * 2, 30)
            except (B.BackendError, httpx.HTTPError) as e:
                prog.add(errors=1)
                print(f"[load] write failed ({e}); retrying in {delay:.0f}s", flush=True)
                time.sleep(delay)
                delay = min(delay * 2, 30)
        prog.report()
        sem.release()

    for row in iter_rows(store, a.docs, a.skip):
        pending.append(row)
        if len(pending) >= a.batch:
            if first:   # the schema write goes alone, so later batches don't race it
                sem.acquire()
                send(pending, True)
                first = False
            else:
                sem.acquire()
                futures.append(pool.submit(send, pending, False))
            prog.add(sent=len(pending))
            pending = []
    if pending:
        sem.acquire()
        if first:
            send(pending, True)
        else:
            futures.append(pool.submit(send, pending, False))
        prog.add(sent=len(pending))
    for f in futures:
        f.result()
    pool.shutdown()
    prog.state["done"] = True
    prog.report(force=True)

    print("[load] waiting for the indexer to catch up…", flush=True)
    t0 = time.time()
    while time.time() - t0 < a.wait_index:
        m = backend.metadata(s.namespace) or {}
        idx = m.get("index") or {}
        print(f"[load]   status={idx.get('status')} unindexed_rows={idx.get('unindexed_rows', 0):,} "
              f"rows={m.get('approx_row_count', 0):,}", flush=True)
        if idx.get("status") == "up-to-date":
            break
        time.sleep(5)


def cmd_cleanup(a, s):
    b = B.make(a.backend, s)
    where = f"{s.turbopuffer_prefix}{s.namespace}" if a.backend == "turbopuffer" else s.namespace
    b.delete_namespace(s.namespace)
    print(f"Deleted namespace {where!r} on {a.backend}.")


def main(argv=None):
    s = config.load()
    p = argparse.ArgumentParser(prog="python -m search.ingest", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    e = sub.add_parser("embed")
    e.add_argument("--docs", type=int, default=100_000)
    e.add_argument("--worker", type=int, default=None)
    e.add_argument("--workers", type=int, default=1)
    e.add_argument("--tmp", default=os.environ.get("SHARD_DIR", "/tmp/arxiv"))
    ld = sub.add_parser("load")
    ld.add_argument("--docs", "--limit", type=int, default=100_000, dest="docs")
    ld.add_argument("--backend", default=s.backend)
    ld.add_argument("--batch", type=int, default=2_000)
    ld.add_argument("--concurrency", type=int, default=4)
    ld.add_argument("--skip", type=int, default=0, help="skip the first N docs (resume a load)")
    ld.add_argument("--wait-index", type=int, default=1800, help="seconds to wait for indexing afterwards")
    ld.add_argument("--yes-large", action="store_true", help=f"allow > {TURBOPUFFER_WARN_DOCS:,} docs on turbopuffer")
    c = sub.add_parser("cleanup")
    c.add_argument("--backend", default=s.backend)
    a = p.parse_args(argv)
    {"embed": cmd_embed, "load": cmd_load, "cleanup": cmd_cleanup}[a.cmd](a, s)


if __name__ == "__main__":
    main()
