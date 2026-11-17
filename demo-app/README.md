# temupuffer-search

Once temupuffer worked, I wanted to see what it's like to build a real app on top of it, the way
turbopuffer's customers do. So I built a search engine for arXiv research papers (title + abstract):
ingest at scale, vector search, full-text search, filters, consistency and caching. It runs on
temupuffer, and it's built to switch to real turbopuffer with one setting (I haven't connected that yet).

```
browser ──► search-ui (nginx) ──/api──► search-api ──► SearchBackend ──► temupuffer (router → query pod)
                                          │                         └─► turbopuffer (SDK, demo- namespaces)
                                          └──► search-embedder (all-MiniLM-L6-v2, 384 dims, CPU)

embed Job (3 pods) ──► s3://temupuffer-search/embeddings/*.parquet ──► load Job ──► the backend
```

- **Dataset:** [`librarian-bots/arxiv-metadata-snapshot`](https://huggingface.co/datasets/librarian-bots/arxiv-metadata-snapshot)
  (CC0, ~3.2M papers). Filters: field (Computer Science, Astrophysics, …), category (`cs.LG`), year.
- **Search modes:** Words (BM25 on the title ×2 + the abstract), Meaning (vector ANN), and Hybrid
  (both in one multi-query, merged in the app with reciprocal rank fusion). In the API they're
  called `keyword`, `vector` and `hybrid`.
- **Embed once, load many times.** Embedding is the slow part (about 40-110 papers/s per machine),
  so the embed Job saves the vectors to object storage once. Loading them again, into temupuffer or
  turbopuffer, reuses the same vectors, so comparisons are fair.

## What's running on my homelab

About **500,000 papers**, at https://temupuffer-search.agathla.com. They're split into two shards,
`arxiv-a` and `arxiv-b` (paper id % 2), one per query pod, because one query pod can't hold them
all: each pod keeps its whole shard in memory, about 10 KiB per paper. I tried 1M and both query
pods were OOMKilled at their 5 GiB limit, so I went back to 500k. The search app sends every query to
both shards and merges the results (`ShardedBackend`, `TEMUPUFFER_NAMESPACES=arxiv-a,arxiv-b`).

## Pages

- **Search:** results with "meaning #n / words #n" badges, filters, strong/eventual, **Compare**
  (all modes side by side), and **How this query ran** (where the time went, cache temperature,
  object storage round trips, rows brute-forced, the request sent). Two demos: **Cold vs warm** and
  **Write then read**. `?q=…` opens the page with a search already run.
- **Scale:** a **Data** card (Embed → Load → Reset buttons, each with an (i) that explains it and
  shows the exact commands behind it), documents, unindexed rows, index status, rows over time, and
  a **load test** (concurrent clients, p50/p90/p99 per mode, queries/s, recall@10 vs exact kNN).
  The buttons create the same Jobs as `make` (templates in `search/jobs/`), through a ServiceAccount
  that can only manage Jobs in its own namespace (`deploy/search/base/rbac.yaml`). They're only on
  with `ADMIN_ACTIONS=1` (my homelab overlay), because anyone who can open the UI could press them.
  I press Embed and Load myself.

## Run it

On my homelab (namespace `temupuffer-search`):

```bash
make search-images                 # build + push (then pin the digests in deploy/overlays/agathla-search)
make search-apply                  # secrets (copied), Deployments, Ingress
make search-embed DOCS=100000      # 3 pods, resumable; ~12 min for 100k, ~2 h for 1M (or: Scale page → Embed)
make search-load  DOCS=100000      # batched upserts, backs off on 429 (or: Scale page → Load)
make search-load  DOCS=400000 SKIP=100000   # continue a load
make search-cleanup                # delete the namespace(s)
```

On my Mac, with the Compose stack (`./deploy/local.sh up` first). Embedding works in chunks of
10,000 papers, so even a small load embeds 10,000 first (about 5 min at ~37 papers/s on my Mac):

```bash
docker compose -f deploy/docker-compose.yml --profile search up -d --build    # UI on http://localhost:3001
docker compose -f deploy/docker-compose.yml --profile search run --rm search-api python -m search.ingest embed --docs 2000
docker compose -f deploy/docker-compose.yml --profile search run --rm search-api python -m search.ingest load --docs 2000
```

I last tested this on 2026-11-17: 2,000 papers loaded and indexed, and Hybrid, Meaning and Words all
returned results.

Development: `cd demo-app && python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt pytest`,
`make search-test` (25 tests), `uvicorn search.api:app --port 8090` (env `TEMUPUFFER_URL`,
`TEMUPUFFER_API_KEY`), and `cd ui && npm install && npm run dev` (http://localhost:5174).

## On real turbopuffer (next step, not tried yet)

Put `TURBOPUFFER_API_KEY=…` and `TURBOPUFFER_REGION=…` in `demo-app/.env` (gitignored) and re-run
`make search-apply`. The backend picker and **Compare → both backends** should then appear. Safety
rails I built in, because turbopuffer is a paid service:

- every namespace on turbopuffer gets the `demo-` prefix (`TURBOPUFFER_NAMESPACE_PREFIX`), so the app
  can't touch anything else in the account;
- `make search-load BACKEND=turbopuffer` refuses more than 50,000 papers without `--yes-large`;
- `make search-cleanup BACKEND=turbopuffer` deletes `demo-arxiv`.

The adapter follows the current SDK (`turbopuffer` 3.1.0): `Turbopuffer(api_key, region)`,
`namespace(...).write/query/multi_query/delete_all`, responses as dicts via `to_dict()`.
