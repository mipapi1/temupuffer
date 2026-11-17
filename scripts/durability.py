"""Prove that killing a query node loses no acknowledged write.

    .venv/bin/python scripts/durability.py --seconds 30 \
        --kill-after 10 --kill-cmd "kubectl -n temupuffer get pods -l app.kubernetes.io/name=temupuffer-query -o name | head -1 | xargs kubectl -n temupuffer delete --wait=false"

What it does:
  1. Many clients write small batches as fast as they can for --seconds.
     Every write that returns 200 is *acknowledged*, and its ids are recorded.
     A write that fails (connection reset, 502 from the ingress, timeout) is
     *not* acknowledged. It may or may not have landed, and either is allowed.
  2. Optionally, after --kill-after seconds, it runs --kill-cmd (or you can kill
     a pod by hand while it runs).
  3. It then reads every acknowledged id back with a strong query.

Pass = 0 acknowledged ids missing. That's turbopuffer's durability guarantee
(Guarantees docs): a write is committed to object storage before the API
returns, so the node holding it in memory can die without losing it. Unacked
writes that did land are reported too, as "landed without an ack" (the node
died after the PUT but before it could reply). That's expected, and it's why
clients should retry with the same ids: an upsert is idempotent.

Point --url at nginx (the API hostname's router, or the console's /api proxy),
not `kubectl port-forward`, which pins to one pod and dies with it. nginx sends
the run's namespace to one pod (namespace affinity), and when that pod dies it
moves on to the next. To test that failover, kill the owner: the pod whose IP
is in the X-Temupuffer-Upstream response header (`curl -si .../v1/namespaces/<ns>/metadata`,
then `kubectl -n temupuffer get pods -o wide`).
"""

from __future__ import annotations

import argparse
import itertools
import os
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import httpx


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--url", default=os.environ.get("TEMUPUFFER_URL", "http://localhost:8080"))
    p.add_argument("--key", default=os.environ.get("TEMUPUFFER_API_KEY", "tpuf-dev-key"))
    p.add_argument("--ns", default=f"durability-{int(time.time())}")
    p.add_argument("--seconds", type=float, default=30)
    p.add_argument("--clients", type=int, default=16)
    p.add_argument("--batch", type=int, default=20)
    p.add_argument("--kill-after", type=float, default=None)
    p.add_argument("--kill-cmd", default=None)
    a = p.parse_args()

    headers = {"Authorization": f"Bearer {a.key}"}
    ids = itertools.count()
    id_lock = threading.Lock()
    acked: set[int] = set()
    attempted: set[int] = set()
    failures: dict[str, int] = {}
    stop_at = time.time() + a.seconds

    def client_loop(_):
        c = httpx.Client(base_url=a.url, headers=headers, timeout=15)
        while time.time() < stop_at:
            with id_lock:
                batch = [next(ids) for _ in range(a.batch)]
                attempted.update(batch)
            try:
                r = c.post(f"/v2/namespaces/{a.ns}", json={"upsert_rows": [{"id": i, "w": "d"} for i in batch],
                                                           "disable_backpressure": True})
                if r.status_code == 200:
                    with id_lock:
                        acked.update(batch)
                    continue
                key = f"HTTP {r.status_code}"
            except httpx.HTTPError as e:
                key = type(e).__name__
            with id_lock:
                failures[key] = failures.get(key, 0) + 1
            time.sleep(0.2)

    if a.kill_after is not None and a.kill_cmd:
        def killer():
            time.sleep(a.kill_after)
            print(f"\n>>> t+{a.kill_after:.0f}s: running {a.kill_cmd}")
            subprocess.run(a.kill_cmd, shell=True, check=False)  # your own command, run through a shell
        threading.Thread(target=killer, daemon=True).start()
    else:
        print("Tip: kill ONE query pod now, e.g.\n  kubectl -n temupuffer get pods -l app.kubernetes.io/name=temupuffer-query -o name | head -1 | xargs kubectl -n temupuffer delete --wait=false")

    print(f"Writing to {a.ns} for {a.seconds:.0f}s with {a.clients} clients...")
    t0 = time.time()
    with ThreadPoolExecutor(a.clients) as pool:
        progress = threading.Thread(target=lambda: [
            (time.sleep(2), print(f"  t+{time.time() - t0:4.0f}s acked={len(acked):>6} failed requests={sum(failures.values())}"))
            for _ in range(int(a.seconds // 2))], daemon=True)
        progress.start()
        list(pool.map(client_loop, range(a.clients)))

    print(f"\nAcknowledged {len(acked)} ids; {sum(failures.values())} failed requests {failures or ''}")
    print("Reading everything back with consistency=strong ...")
    c = httpx.Client(base_url=a.url, headers=headers, timeout=60)
    found: set[int] = set()
    every = sorted(attempted)
    for i in range(0, len(every), 5000):
        chunk = every[i:i + 5000]
        for attempt in range(10):
            try:
                r = c.post(f"/v2/namespaces/{a.ns}/query", json={
                    "rank_by": ["id", "asc"], "limit": 10_000, "filters": ["id", "In", chunk]})
                r.raise_for_status()
                break
            except httpx.HTTPError:
                time.sleep(1)  # a pod may still be restarting
        found.update(row["id"] for row in r.json()["rows"])

    missing = acked - found
    extra = (found - acked)
    print(f"\n  acknowledged and present:    {len(acked & found)}")
    print(f"  acknowledged but MISSING:    {len(missing)}")
    print(f"  landed without an ack:       {len(extra)}   (allowed: the node died after the PUT, before replying)")
    if missing:
        print(f"\nFAIL: lost acknowledged writes, e.g. {sorted(missing)[:10]}")
        raise SystemExit(1)
    print("\nPASS: no acknowledged write was lost.")
    print(f"(Clean up with: curl -X DELETE -H 'Authorization: Bearer ...' {a.url}/v2/namespaces/{a.ns})")


if __name__ == "__main__":
    main()
