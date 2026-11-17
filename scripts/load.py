"""Write N synthetic documents, then watch the indexing backlog drain.

    .venv/bin/python scripts/load.py --docs 50000
    .venv/bin/python scripts/load.py --docs 50000 --concurrency 8 --batch 2000   # push harder -> 429s

Each document has a vector (clustered, so ANN recall is meaningful), a short
text for BM25, and a few filterable attributes:

    {"id": 123, "vector": [...], "title": "quantum puffer harbor ...", "category": "tech",
     "year": 2019, "price": 42.5, "tags": ["red", "new"]}

What to watch while it runs:
  * the console's "Under the hood" page: WAL blocks appear (orange = unindexed)
    and turn green as the indexer folds them into segments.
  * this script's output: unindexed rows climb during the load, then fall to 0.
  * 429s, when the backlog passes the backpressure limit. The script backs off
    and retries, which is what a well-behaved turbopuffer client does.

Defaults point at a local query node: TEMUPUFFER_URL=http://localhost:8080,
TEMUPUFFER_API_KEY=tpuf-dev-key.
"""

from __future__ import annotations

import argparse
import os
import random
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import httpx
import numpy as np

WORDS = ("puffer fish ocean harbor quantum vector search index object storage cache latency "
         "river mountain forest desert city music science history sport travel recipe garden "
         "engine rocket planet galaxy coffee bread cheese market winter summer storm island").split()
CATEGORIES = ["news", "sport", "tech", "science", "travel", "food"]
TAGS = ["red", "green", "blue", "new", "popular", "archived"]


def make_docs(start: int, n: int, dims: int, centers: np.ndarray, rng: random.Random) -> list[dict]:
    nprng = np.random.default_rng(start)
    which = nprng.integers(0, len(centers), n)
    vecs = centers[which] + nprng.normal(size=(n, dims)) * 0.6
    docs = []
    for i in range(n):
        c = int(which[i])
        words = [WORDS[(c * 3 + j) % len(WORDS)] for j in range(3)] + rng.sample(WORDS, 5)
        docs.append({
            "id": start + i,
            "vector": [round(float(x), 4) for x in vecs[i]],
            "title": " ".join(words),
            "category": CATEGORIES[c % len(CATEGORIES)],
            "year": 2000 + (start + i) % 25,
            "price": round(rng.uniform(1, 500), 2),
            "tags": rng.sample(TAGS, rng.randint(0, 3)),
        })
    return docs


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--url", default=os.environ.get("TEMUPUFFER_URL", "http://localhost:8080"))
    p.add_argument("--key", default=os.environ.get("TEMUPUFFER_API_KEY", "tpuf-dev-key"))
    p.add_argument("--ns", default="load-test")
    p.add_argument("--docs", type=int, default=50_000)
    p.add_argument("--batch", type=int, default=1_000, help="rows per write request")
    p.add_argument("--concurrency", type=int, default=4, help="parallel write requests")
    p.add_argument("--dims", type=int, default=64)
    p.add_argument("--start-id", type=int, default=0)
    p.add_argument("--no-watch", action="store_true", help="don't wait for the backlog to drain")
    a = p.parse_args()

    client = httpx.Client(base_url=a.url, headers={"Authorization": f"Bearer {a.key}"}, timeout=120)
    centers = np.random.default_rng(42).normal(size=(40, a.dims)) * 3
    rng = random.Random(1)
    stats = {"ok": 0, "429": 0, "errors": 0}
    lock = threading.Lock()
    batches = [(s, min(a.batch, a.docs - (s - a.start_id))) for s in range(a.start_id, a.start_id + a.docs, a.batch)]

    def send(b):
        start, n = b
        body = {"upsert_rows": make_docs(start, n, a.dims, centers, rng), "distance_metric": "cosine_distance",
                "schema": {"title": {"type": "string", "full_text_search": True}}}
        delay = 0.5
        net_errors = 0
        while True:
            try:
                r = client.post(f"/v2/namespaces/{a.ns}", json=body)
            except httpx.HTTPError as e:
                with lock:
                    stats["errors"] += 1
                net_errors += 1
                if net_errors >= 5:  # not a blip: bad URL, TLS problem, server down
                    raise SystemExit(f"giving up after 5 network errors talking to {a.url}: {e!r}")
                print(f"  network error ({e!r}); retrying in {delay:.1f}s")
                time.sleep(delay)
                continue
            if r.status_code == 429:
                with lock:
                    stats["429"] += 1
                print(f"  429 backpressure on ids {start}..{start + n - 1}: backing off {delay:.1f}s")
                time.sleep(delay)
                delay = min(delay * 2, 8)
                continue
            r.raise_for_status()
            j = r.json()
            with lock:
                stats["ok"] += n
                done = stats["ok"]
            print(f"  wrote {done:>6}/{a.docs}  -> WAL entry {j['temupuffer']['wal_seq']:<5} "
                  f"({j['performance']['server_total_ms']} ms, waited {j['temupuffer']['commit_wait_ms']} ms "
                  f"for group commit)")
            return

    t0 = time.time()
    print(f"Writing {a.docs} docs to {a.url}/v2/namespaces/{a.ns} in batches of {a.batch}, "
          f"{a.concurrency} at a time")
    with ThreadPoolExecutor(a.concurrency) as pool:
        list(pool.map(send, batches))
    elapsed = time.time() - t0
    print(f"\nDone in {elapsed:.1f}s: {stats['ok']} rows acknowledged, {stats['429']} x 429, "
          f"{stats['errors']} network errors ({stats['ok'] / elapsed:.0f} rows/s)")

    if a.no_watch:
        return
    print("\nWatching the backlog drain (GET /v1/namespaces/{ns}/metadata every second):")
    t1 = time.time()
    while True:
        m = client.get(f"/v1/namespaces/{a.ns}/metadata").json()
        idx = m["index"]
        print(f"  t+{time.time() - t1:5.1f}s  status={idx['status']:<10} unindexed_rows={idx.get('unindexed_rows', 0):>6} "
              f"unindexed_bytes={idx.get('unindexed_bytes', 0):>10}  cursor={m['temupuffer']['index_cursor']} "
              f"head={m['temupuffer']['wal_head']} segments={m['temupuffer']['segments']}")
        if idx["status"] == "up-to-date":
            break
        time.sleep(1)
    q = client.post(f"/v2/namespaces/{a.ns}/query", json={"rank_by": ["title", "BM25", "quantum puffer"], "limit": 3,
                                                          "include_attributes": ["title"]}).json()
    print(f"\nSample BM25 query: {[r['title'] for r in q['rows']]}")
    print(f"performance: {q['performance']}")


if __name__ == "__main__":
    main()
