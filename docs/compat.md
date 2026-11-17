# API compatibility with turbopuffer

temupuffer copies the shape of turbopuffer's HTTP API so that Phase 2's adapter stays thin. It is
**not** a drop-in replacement. Checked against the docs on 2026-11-09.

## Endpoints

| Endpoint | turbopuffer | temupuffer |
|---|---|---|
| `POST /v2/namespaces/:ns` | write | ✅ subset (below) |
| `POST /v2/namespaces/:ns/query` | query | ✅ subset (below) |
| `DELETE /v2/namespaces/:ns` | delete namespace | ✅ returns `{"status": "ok"}` (turbopuffer's body isn't documented) |
| `GET /v1/namespaces` | list (`prefix`, `cursor`, `page_size`) | ✅ same params, `{namespaces: [{id}], next_cursor?}` |
| `GET /v1/namespaces/:ns/metadata` | metadata | ✅ plus extras: `distance_metric`, `dims`, `temupuffer{}` |
| `GET /v1/namespaces/:ns/hint_cache_warm` | warm hint | ✅ `{"status": "ACCEPTED", "message": …}` (field names inferred from the SDK's repr) |
| `PATCH /v1/namespaces/:ns/metadata` (pinning, read_only) | ✅ | ❌ |
| schema endpoints, `explain_query`, `recall`, export | ✅ | ❌ |
| Auth `Authorization: Bearer <key>` | ✅ | ✅ |

## Write body

| Field | temupuffer |
|---|---|
| `upsert_rows`, `upsert_columns`, `deletes` | ✅ |
| `distance_metric` (`cosine_distance`, `euclidean_squared`) | ✅ required on the first write with vectors, fixed after |
| `schema` (types, `filterable`, `full_text_search` with k1/b/case_sensitive/remove_stopwords/max_token_length) | ✅ subset. No stemming, no other tokenizers or languages |
| `disable_backpressure` | ✅ |
| `patch_rows`, `patch_columns`, `patch_by_filter`, `delete_by_filter`, `*_condition`, `copy_from_namespace`, `branch_from_namespace`, `encryption`, `sharding`, `return_affected_ids` | ❌ 400 "not supported by temupuffer" |
| Response `rows_affected`, `rows_upserted`, `rows_deleted`, `billing`, `performance.server_total_ms` | ✅ plus a `temupuffer{wal_seq, commit_wait_ms, node}` extra |

Types: `string`, `int`, `float`, `bool`, `[]string`, `[]int`, `[]float`, and one vector column named
`vector` (`[N]f32`). No `uint`/`uuid`/`datetime`/`bytes`, f16/i8 vectors, sparse vectors, or multiple
vector columns. Ids: u64 or strings ≤ 64 bytes (UUIDs as strings).

## Query body

| Field | temupuffer |
|---|---|
| `rank_by`: `["vector","ANN",v]`, `["vector","kNN",v]`, `[attr,"BM25",text]`, `Sum`, `Max`, `Product`, filter-as-clause, `[attr,"asc"/"desc"]`, multi-attribute order | ✅ |
| `rank_by`: `Saturate`, `Decay`, `Attribute`, `Dist`, `SparseKNN`, native embeddings, BM25 `last_as_prefix` | ❌ |
| `limit` (number or `{total}`), `top_k` | ✅ (`limit.per` ❌) |
| `filters`: `And Or Not Eq NotEq In NotIn Lt Lte Gt Gte Contains NotContains ContainsAny NotContainsAny ContainsAllTokens` | ✅ |
| `filters`: `Any*`, `Glob`, `IGlob`, `Regex`, `Fuzzy`, `ContainsTokenSequence`, `ContainsAnyToken` | ❌ |
| `include_attributes` (list or `true`), `exclude_attributes` | ✅ |
| `consistency` `{level, max_staleness_seconds}` | ✅ |
| `queries` (multi-query, one shared snapshot, ≤ 16) | ✅ (`rerank_by` incl. RRF ❌: Phase 2 fuses results client-side) |
| `aggregate_by` | ✅ `Count` only. `group_by` ❌ |
| `offset`, `compute_attributes`, highlighting, `vector_encoding: base64` | ❌ |
| Response `performance` | ✅ `cache_hit_ratio`, `cache_temperature`, `server_total_ms`, `query_execution_ms`, `exhaustive_search_count`, `approx_namespace_size`. Extras: `object_storage_round_trips` and friends. ❌ `last_included_write_at`, `billing` |

## Behaviour differences worth knowing

- **Enabling full-text search on existing data:** turbopuffer returns 409 until the index is built.
  temupuffer builds a BM25 index on the fly for segments that lack one.
- **Filters on non-filterable attributes:** temupuffer evaluates them by brute force instead of rejecting them.
- **Errors:** `{"status": "error", "error": "..."}`. turbopuffer's error body isn't documented.
- **Routing:** nginx (the console's `/api` and `/b/<id>/api`, plus `temupuffer-router` behind the
  API hostname) sends each namespace to one query pod by a consistent hash of its name
  (`db/ui/backends.sh`). turbopuffer has said in interviews and its blog that it routes a namespace
  to the same query node by consistent hash for cache locality, and that any node can serve any
  namespace. Its router itself isn't documented. The pieces here are temupuffer's choices: the
  query pods are a StatefulSet only so the ring has stable names (turbopuffer's deployment isn't
  public), the ring lists pods by hand (`QUERY_RING`), and the hash key is the namespace in the
  URL path.
- **Write routing:** affinity is a preference, not a lock. Any node still accepts any write (when
  the owner is down, or through a path that skips nginx), so two nodes can write one namespace.
  The 1 WAL entry/s/namespace cap still holds across nodes: a node that loses the CAS race for a
  seq waits a full gap from the winner's commit, and the loser goes first next round (`wal.py`,
  `_flusher`).
- **WAL retention:** temupuffer never deletes WAL entries (see `wal.py`). turbopuffer's retention isn't documented.
