# 5-minute demo: temupuffer-search

What I show, what I say, and which turbopuffer docs page backs each claim. Before I start, I open
two tabs: the search app (https://temupuffer-search.agathla.com) and the temupuffer console
(https://temupuffer.agathla.com, **Under the hood**, namespace `arxiv-a`).

Before the demo, I run one search so the cache is warm. On my homelab the first search after the
query pods restart takes about 21 s, because each pod loads its whole 250,000-paper shard into memory.

## 1. Three ways to search (90 s)

**Do:** type `why do galaxies rotate too fast`. Run it as **Words**, then **Meaning**, then **Hybrid**.
Then switch to **Compare** to see the three side by side.

**Watch:**
- Words (BM25) favors papers that literally contain "galaxies" and "rotate".
- Meaning (vector search) finds dark matter and rotation-curve papers even when they share few words with the question.
- Hybrid shows both badges on its top results ("meaning #2 · words #1"): the papers both methods agree on rise to the top.

**Say:** "This is one multi-query: a vector query and a BM25 query on the same snapshot. The app
merges the two ranked lists with reciprocal rank fusion. turbopuffer can do that merge on the server
with `rerank_by`; I do it in the app so it would work the same on both backends."

**Docs:** [Query](https://turbopuffer.com/docs/query) (rank_by ANN and BM25, multi-query, `rerank_by` RRF),
[Full-text search](https://turbopuffer.com/docs/fts).

## 2. What the database did (60 s)

**Do:** look at **How this query ran** on the right. Then switch **Strong → Eventual** and search again.

**Watch:**
- The time bar: embedding the question (the model runs on CPU, and repeat questions are cached) vs
  time in the database vs app overhead.
- Strong: 4 object storage round trips on my homelab. That's 2 per shard (check the manifest, list
  the WAL tail), even when nothing changed.
- Eventual: 0 round trips, faster, with "view N s old".
- Rows brute-forced: 0 when everything is indexed.

**Say:** "Strong consistency costs a round trip to object storage on every query. That's the price of
always seeing the latest write. Eventual reuses a view up to 60 seconds old, for when latency matters more."

**Docs:** [Query](https://turbopuffer.com/docs/query) (consistency), [Architecture](https://turbopuffer.com/docs/architecture) (~10 ms consistency check).

## 3. Cold vs warm (45 s)

**Do:** press **Cold vs warm**. For a real cold start, I'd restart the query pods
(`kubectl -n temupuffer rollout restart statefulset/temupuffer-query`), but on my homelab that
makes the next search take ~21 s, so I usually just describe it.

**Watch:** the first run is `cold` (segment files fetched from object storage), the repeat is `hot` (memory).

**Say:** "Object storage is the source of truth; memory and local disk are caches. A cold query pays
for round trips to the bucket, a warm one doesn't. turbopuffer documents p50 874 ms cold vs 14 ms
warm at 1M documents, and you can pre-warm a namespace."

**Docs:** [Architecture](https://turbopuffer.com/docs/architecture), [Warm cache](https://turbopuffer.com/docs/warm-cache).

## 4. Write then read (45 s)

**Do:** press **Write then read**.

**Watch:** the write is acknowledged, then the strong query finds it; eventual may or may not. The
app deletes the test document afterwards.

**Say:** "A write returns once it's saved in object storage, in the write-ahead log, before it's
indexed. Strong queries scan that unindexed tail, so they always see it."

**Docs:** [Guarantees](https://turbopuffer.com/docs/guarantees), [Write](https://turbopuffer.com/docs/write).

## 5. Scale (60 s)

**Do:** open **Scale**. Point at the documents, the index status and the rows-over-time chart.
Run a **30 s load test** with 8 clients.

**Watch:** queries/s, p50/p90/p99 per search mode, and **recall@10**: how many of the true 10
nearest papers the fast ANN index found, compared with an exact search.

**Say:** "During a big ingest, the amber band is data that's written but not indexed yet. It's
searchable but brute-forced. If too much piles up, the database pushes back with 429s and the
loader backs off. turbopuffer does the same above 2 GB or 1M unindexed rows. Recall is the
accuracy you trade for speed; turbopuffer targets 90-100% recall@10."

Then the story I like to tell: "I tried 1M papers on my homelab and both query pods were OOMKilled,
because each one keeps its whole shard in memory. Napkin math (~10 KiB per paper × 500k per pod)
would have told me that up front. turbopuffer keeps data in object storage and caches only what's
hot, which is exactly what my version doesn't do yet."

**Docs:** [Write](https://turbopuffer.com/docs/write) (backpressure), [Limits](https://turbopuffer.com/docs/limits).

## If they ask

- **Is this turbopuffer?** No. temupuffer is a small database I built to learn the architecture
  (object storage as the storage layer, a WAL, a separate indexer). The app talks to it through one
  `SearchBackend` interface, and it's built to run on real turbopuffer with `BACKEND=turbopuffer`
  and an API key. That's my next test.
- **What's different from turbopuffer?** Fusion happens in the app here. The ANN index is simple
  k-means clustering, not SPFresh. Each query pod loads its whole namespace into memory. Routing by
  namespace uses an nginx consistent-hash ring; turbopuffer routes a namespace to the same node for
  cache locality, but its docs don't say how. See `docs/compat.md` and `docs/concept-map.md`.
- **Where does the time go during ingest?** Embedding. The model runs at roughly 40-110 papers/s per
  machine, far below what the database accepts, so the app embeds once and keeps the vectors.
