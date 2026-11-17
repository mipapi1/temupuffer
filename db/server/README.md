# Query node (`server/main.py`)

The HTTP front end. All the logic lives in `temupuffer/engine.py`; this file maps routes to it,
checks the API key, runs the storage self-test at startup, and gathers cluster stats for the console.

| Route | Engine call | turbopuffer docs |
|---|---|---|
| `POST /v2/namespaces/{ns}` | `write` | Write |
| `POST /v2/namespaces/{ns}/query` | `query` | Query |
| `DELETE /v2/namespaces/{ns}` | `delete_namespace` | Delete namespace |
| `GET /v1/namespaces` | `list_namespaces` | Namespaces |
| `GET /v1/namespaces/{ns}/metadata` | `metadata` | Metadata |
| `GET /v1/namespaces/{ns}/hint_cache_warm` | `warm` | Warm cache |
| `GET /debug/node`, `/debug/cluster`, `/debug/namespaces/{ns}/wal`, `/debug/queue` | for the console only | none |
| `GET /healthz`, `/readyz` | health checks; `/readyz` waits for the self-test | none |

**Why handlers run in a thread pool:** boto3 is synchronous, and a write deliberately waits up to
about 1 s for its group commit. Each request runs in a worker thread (`run_in_threadpool`), and I
raised the pool to 256 threads so a burst of writes can't starve queries.

**Nothing to lose:** the process holds a cache, one `WalWriter` thread per namespace, and cached
views. All of them can be rebuilt from the bucket, so a pod can be killed at any time.
`scripts/durability.py` proves it: 6,080 acknowledged writes, 0 missing, in my latest local run.

**Cluster view:** `/debug/cluster` looks up `PEER_DNS` (a headless Service: one DNS record per pod)
and `INDEXER_DNS`, then calls `/debug/node` on each. That's how the console shows each pod's cache.

Run it on its own: `cd db && STORE=memory ../.venv/bin/python -m server.main` (port 8080, key `tpuf-dev-key`).

**Q:** A write is acknowledged, then the pod is killed before the indexer runs. Where is the data, and what indexes it?
