# temupuffer ↔ turbopuffer concept map

Every row: what temupuffer does, where in the code, what turbopuffer does, and which docs page says so.
"My choice" means the turbopuffer docs don't say how it works, so I picked something reasonable.

| Concept | temupuffer | Code | turbopuffer (docs) |
|---|---|---|---|
| Durable state | One S3 bucket. Nodes hold only a cache | `storage.py` | "Object storage is the only stateful dependency" ([Guarantees](https://turbopuffer.com/docs/guarantees)) |
| Concurrency control | Conditional PUTs: `If-None-Match: *` (WAL), `If-Match` (queue, manifest, meta) | `storage.py`, `wal.py`, `jobqueue.py`, `manifest.py` | "all concurrency control is delegated to object storage" ([Guarantees](https://turbopuffer.com/docs/guarantees)) |
| Namespace | Prefix `ns/<name>/`, created on first write | `keys.py`, `meta.py` | prefix per namespace, implicit creation ([Write](https://turbopuffer.com/docs/write), [Architecture](https://turbopuffer.com/docs/architecture)). turbopuffer's diagram keys data by a namespace *id*. I use the name, which makes delete + recreate trickier (I key caches by etag to make up for it) |
| WAL rate | ≤ 1 entry/s per namespace, across all nodes (a lost CAS race makes the loser wait a full gap) | `wal.py` | "Each namespace can currently write 1 WAL entry per second" ([Architecture](https://turbopuffer.com/docs/architecture)) |
| Group commit | Concurrent writes share an entry | `wal.py` | concurrent writes are batched into one entry ([Architecture](https://turbopuffer.com/docs/architecture)) |
| Write durability | Return after the WAL PUT succeeds | `engine.write` | "committed to object storage before the API returns" ([Guarantees](https://turbopuffer.com/docs/guarantees)) |
| Write routing | nginx sends each namespace to one query pod by consistent hash (console + `temupuffer-router`). Affinity is a preference: any node still accepts any write, and CAS resolves races | `db/ui/backends.sh`, `wal.py` | Queries are routed to the same node for cache locality, and any node can serve any namespace ([Architecture](https://turbopuffer.com/docs/architecture)). The router isn't documented. Don't claim "single writer per namespace" |
| Finding the WAL head | `LIST wal/ StartAfter=<cursor>` | `wal.py`, `views.py` | "cheap metadata check" with a ~10 ms floor on consistent reads. The mechanism isn't documented (my choice) |
| Indexing | Separate Deployment, finds work via `queue.json` | `indexer.py`, `jobqueue.py` | separate indexing nodes, queue on object storage ([Architecture](https://turbopuffer.com/docs/architecture), queue blog post, Feb 2026) |
| Index cursor | `manifest.json.cursor`. Entries above it are the tail | `manifest.py` | unindexed data, `index.status: updating` ([Metadata](https://turbopuffer.com/docs/metadata)) |
| Unindexed scan | Brute force over the tail on every query | `query.py` | `exhaustive_search_count` ([Query](https://turbopuffer.com/docs/query)) |
| Strong consistency | Re-check manifest + WAL on every query | `views.py` | default. "searches all unindexed writes" ([Query](https://turbopuffer.com/docs/query)) |
| Eventual consistency | Cached view ≤ 60 s, background refresh, ≤ 128 MiB of tail | `views.py` | same numbers ([Query](https://turbopuffer.com/docs/query)). `max_staleness_seconds` ≤ 3600 |
| Backpressure | 429 above N rows / bytes unindexed (default 20k rows / 64 MiB) | `engine.write` | 429 above **2 GB or 1M rows** ([Write](https://turbopuffer.com/docs/write): `disable_backpressure`) |
| `disable_backpressure` | Skips the 429; strong queries error at 2× the limit | `engine.py` | strong queries error above the thresholds. The factor is my choice |
| Upsert/delete conflicts | Newest version (seq, position) wins across segments + tail | `wal.py`, `views.py` | last write wins (implied by the WAL ordering) |
| Segments + compaction | Immutable segments, size-tiered merges (the smallest segments, up to `INDEXER_MAX_SEGMENT_ROWS` rows, once there are 4+), delayed GC (≥ `GC_DELAY_S`; the sweep also collects it on idle namespaces) | `segment.py`, `indexer.py` | LSM-style storage ([Architecture](https://turbopuffer.com/docs/architecture)). Exact compaction policy not documented |
| ANN index | k-means centroids, probe nearest clusters (filter-aware) | `vector.py`, `query.py` | SPFresh-based centroid index ([Architecture](https://turbopuffer.com/docs/architecture)) |
| Recall | recall@10 ≥ 0.9 in tests | `test_vector.py` | 90-100% recall@10 ([Limits](https://turbopuffer.com/docs/limits)) |
| Distance metrics | `cosine_distance`, `euclidean_squared`, fixed at first write | `meta.py`, `vector.py` | same ([Write](https://turbopuffer.com/docs/write)) |
| BM25 | k1 = 1.2, b = 0.75, OR across terms, `Sum`/`Max`/`Product` | `bm25.py`, `query.py` | same defaults and operators ([FTS](https://turbopuffer.com/docs/fts)). OR vs AND isn't stated |
| Filters | Exact inverted index + sorted values, brute force on the tail | `filters.py` | "exact inverted index" ([Architecture](https://turbopuffer.com/docs/architecture)) |
| Cache | memory → disk (emptyDir) → S3, `cache_temperature` hot/warm/cold | `cache.py` | memory + NVMe SSD, same field names ([Architecture](https://turbopuffer.com/docs/architecture), [Query](https://turbopuffer.com/docs/query)) |
| Warm cache | `GET /v1/namespaces/{ns}/hint_cache_warm` | `engine.warm` | same path ([Warm cache](https://turbopuffer.com/docs/warm-cache)) |
| Cold vs warm latency | ~0.8-1 s cold / ~31 ms warm strong / <1 ms eventual (SILO, 50k docs) | `scripts/load.py` | p50 874 ms cold / 14 ms warm at 1M docs ([Architecture](https://turbopuffer.com/docs/architecture)) |
| Node failure | Kill a query pod: 0 acknowledged writes lost | `scripts/durability.py` | durable writes; any node can serve any namespace ([Guarantees](https://turbopuffer.com/docs/guarantees)) |
