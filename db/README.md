# temupuffer: the database

This is how the database works, in the order a request travels through it. Each section ends with
the turbopuffer docs page it's based on and a question I want to be able to answer in an interview.

## 1. Object storage is the only state

Everything that has to survive is an object in one bucket:

```
queue.json                                    the indexer's work queue
ns/<name>/meta.json                           distance metric, dims, schema
ns/<name>/wal/00000000000000000042.json       one WAL entry (never changed after it's written)
ns/<name>/index/manifest.json                 the live segments + the index cursor
ns/<name>/index/seg-<id>/…                    one index segment (also never changed)
```

A query node only keeps a cache. I can delete every pod and lose nothing: a new pod rebuilds what it
needs from the bucket. That's also why any node can serve any namespace.

Code: `storage.py` (the S3, Azure Blob and in-memory stores, with request counting) and `keys.py`
(the layout above). At startup every process runs `selftest.py`, which checks that the store really
honours `If-None-Match: *` and `If-Match`, and refuses to start if it doesn't. SILO and Azure Blob
both pass.

*Docs:* [Architecture](https://turbopuffer.com/docs/architecture), [Guarantees](https://turbopuffer.com/docs/guarantees)
("object storage is the only stateful dependency").
**Q:** Why does the self-test exist, and what goes wrong on a store that ignores `If-Match`?

## 2. Write path: the WAL and group commit

`POST /v2/namespaces/{ns}` → `engine.write()`:

1. Check the request (ids, duplicate ids → 400, attribute names, types).
2. Make sure `meta.json` allows this write (`meta.py`). The first write creates it with
   `If-None-Match: *`, and schema changes are a compare-and-swap with `If-Match`. The first write
   also fixes the distance metric and the vector dims.
3. **Backpressure:** if too much of the namespace isn't indexed yet, return **429**.
4. Hand the batch to the namespace's `WalWriter` (`wal.py`) and wait.

`WalWriter` grew out of my study lab (`labs/c-wal/wal_cap.py`). One thread per namespace waits until
1 s has passed since the last entry started (turbopuffer: 1 WAL entry per second per namespace).
Every request that arrives in the meantime joins the same entry. Then it PUTs `wal/<seq+1>` with
`If-None-Match: *`. If another node already took that number (412/409), it finds the new head and
tries again.

The write returns **as soon as the entry is saved**, before anything is indexed.

*Docs:* [Write](https://turbopuffer.com/docs/write), [Architecture](https://turbopuffer.com/docs/architecture) (1 entry/s, batching).
**Q:** Two query nodes both get writes for the same namespace in the same second. What happens?

## 3. The indexer

A separate process (`indexer.py`). Its loop:

1. **Claim a job** in `queue.json` (`jobqueue.py`): read it, mark the job `claimed_by: me`, and PUT it
   back with `If-Match: <etag>`. A heartbeat keeps the claim alive, and if an indexer dies, another
   one takes its job after `INDEXER_LEASE_S`. This follows turbopuffer's blog post about a queue in
   one JSON file.
2. LIST the WAL after the cursor, take entries up to a row budget, and keep only the newest
   version of each id.
3. **Build a segment** (`segment.py`): documents, vectors, k-means clusters, BM25 postings and filter
   indexes. Upload it under a new random id.
4. **Commit** by swapping `manifest.json` with `If-Match`. The new manifest lists the segment and
   moves the **cursor** to the last indexed entry. That PUT is the commit point.
5. **Compact:** once there are `INDEXER_COMPACT_AT` (4) or more segments, merge the smallest ones,
   up to `INDEXER_MAX_SEGMENT_ROWS` rows, into one. The replaced segments are deleted after
   `GC_DELAY_S` (2 min), in case a query is still reading them.

The "rerun" flag in `queue.json` makes sure no work gets lost: a write that lands while its
namespace is being indexed sets `rerun`, so the job goes back in line instead of being removed.

*Docs:* [Architecture](https://turbopuffer.com/docs/architecture) (separate indexing), the queue blog post.
**Q:** The indexer dies after uploading a segment but before swapping the manifest. What state is the bucket in?

## 4. Query path: the index plus the unindexed tail

`POST /v2/namespaces/{ns}/query` → `engine.query()`:

1. Get a **view** of the namespace (`views.py`): the manifest plus the WAL entries that aren't
   indexed yet (the "tail").
   - **Strong** (the default): check again right now. That's a conditional GET of the manifest
     (usually a 304 with no body) and a LIST of the WAL after the cursor: two round trips.
   - **Eventual**: reuse the cached view if it's at most 60 s old (or `max_staleness_seconds`),
     refresh it in the background, and scan at most 128 MiB of the tail.
2. Load the segments through the node cache and build a **snapshot**: the live rows of each segment
   (newest version wins, deleted rows hidden), with the tail on top.
3. Run the query (`query.py`) on both parts and merge the results:
   - indexed segments → clustered ANN, BM25 postings, filter indexes
   - the unindexed tail → brute force. That row count is `exhaustive_search_count`.
4. Return the rows and a `performance` block.

*Docs:* [Query](https://turbopuffer.com/docs/query) (consistency, performance fields).
**Q:** Why does a growing indexing backlog show up as slower queries before it shows up as 429s?

## 5. Indexes

| Index | File | How | turbopuffer |
|---|---|---|---|
| Vector, exact | `vector.py` | compare with every vector | kNN, and the unindexed tail |
| Vector, approximate | `vector.py` | k-means (k ≈ √n), search the nearest clusters until there are enough candidates | SPFresh (centroid-based, updated incrementally) |
| Full text | `bm25.py` | inverted index, BM25 with k1=1.2, b=0.75 | same defaults ([FTS docs](https://turbopuffer.com/docs/fts)) |
| Filters | `filters.py` | exact inverted index (value → rows) + sorted values for ranges | "exact inverted index" |

`test_vector.py` checks recall@10 ≥ 0.9 against brute force (turbopuffer's Limits page quotes 90-100%).
`test_filters.py` checks that index-backed filters return exactly what brute force returns, on 400 random filters.

An honest note: at 50k vectors of 64 dims, numpy brute force (~17 ms) is as fast as my Python ANN
(~25 ms). Approximate indexes pay off at millions of vectors, which is turbopuffer's scale, not this
one. At 500k arXiv papers it does pay off: ANN 96 ms vs brute force 1,352 ms, with the same results.

## 6. Cache

`cache.py`: memory (parsed objects) → disk (`CACHE_DIR`, an emptyDir in Kubernetes) → object storage.
Only objects that never change are cached, keyed by object key + etag, so nothing ever needs to be
invalidated. Each query reports `cache_temperature` (`hot` = all from memory, `warm` = some from
disk, `cold` = some from object storage) and `cache_hit_ratio`.
`GET /v1/namespaces/{ns}/hint_cache_warm` loads a namespace in the background.

What I measured on SILO with 50k documents: a cold strong query took 800-1000 ms with 8-22 round
trips; warm, 31 ms with 2 round trips (`GET_304` + `LIST`); eventual, 0.7 ms with 0 round trips.
turbopuffer's Architecture page: cold p50 874 ms, warm p50 14 ms at 1M documents.

## Files

| File | What |
|---|---|
| `config.py` | every setting, with the real turbopuffer value next to it |
| `storage.py` | `ObjectStore`, `S3Store`, `AzureBlobStore`, `MemoryStore`, round-trip counting |
| `selftest.py` | the startup compare-and-swap check |
| `keys.py` | bucket layout |
| `schema.py` | types, type inference, id rules |
| `meta.py` | `meta.json` create and update, `MetaCache` |
| `wal.py` | `WalWriter` (group commit + retry), entry format, versions |
| `jobqueue.py` | `queue.json` claim, heartbeat, finish |
| `manifest.py` | `manifest.json` read and compare-and-swap |
| `segment.py` | build and parse segments |
| `indexer.py` | the indexing loop, compaction, cleanup, sweep |
| `views.py` | each node's namespace views, strong vs eventual, snapshots |
| `query.py` | ANN/kNN, BM25 expressions, order-by, filters, Count |
| `cache.py` | memory + disk cache |
| `engine.py` | ties it all together for the HTTP layer |
