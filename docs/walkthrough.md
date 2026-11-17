# Walkthrough: what to click, what to watch, what it shows

This is how I walk through temupuffer, in about 15 minutes. Almost all of it happens in the console.
I only open a terminal for two things: triggering a 429 and killing a pod.

I open the console on my homelab at https://temupuffer.agathla.com. If you're running your own,
`./deploy/local.sh up` gives you http://localhost:3000 (API key `tpuf-dev-key`), and
`./deploy/k3s.sh install` prints its URL and key. Set the key with the key icon at the bottom of the
sidebar. On K3s you can read it with:

```bash
kubectl -n temupuffer get secret temupuffer-api -o jsonpath='{.data.API_KEY}' | base64 -d
```

## 0. Make a practice namespace (1 min)

On my homelab the only namespaces are `arxiv-a` and `arxiv-b`, which hold temupuffer-search's papers,
and I don't want test rows in there. So I open **Under the hood** and press **New practice namespace**.
It creates `walkthrough` with 1,000 practice rows (64-dim vectors and short titles made of words like
"quantum" and "puffer") and selects it.

If I ever press **Write 5,000 rows** on a namespace with more than 50,000 rows, the console asks
first, since that's probably real data.

## 1. The bucket is the database (2 min)

**Do:** open **Namespaces**, then click `walkthrough`.

**Watch:** the namespace page shows its documents, its schema, the WAL head and index cursor, and its
segments from `manifest.json`. All of that is read from object storage. A namespace is just a prefix
in the bucket, `ns/walkthrough/`, with `meta.json`, `wal/`, `index/manifest.json` and `index/seg-*/`
inside it.

**Optional:** to see the raw files, I open the SILO console with
`kubectl -n turbopuffer port-forward svc/silo 19001:9001` and browse the `temupuffer` bucket.
(Locally: http://localhost:19001, minioadmin/minioadmin.)

**What it shows:** object storage is the only place data is kept
([Guarantees](https://turbopuffer.com/docs/guarantees), [Architecture](https://turbopuffer.com/docs/architecture)).
There's no database server holding state. I can delete every pod and nothing is lost.

## 2. Group commit and the WAL (3 min)

**Do:** open **Under the hood**, pick `walkthrough`, and press **Write 5,000 rows**. It sends 5
requests at once.

**Watch:**
- New amber blocks drop into the WAL strip, to the right of the cursor line.
- The activity feed shows `committed WAL entry N: … rows from K requests`.
- Usually that's **1 or 2 entries, all from the same query pod**. The first request goes out alone,
  and the requests that arrive while its PUT is in flight share the next entry.

**Why always the same pod:** the console and the API router send every request for a namespace to the
same query pod, by a consistent hash of the namespace name. A different namespace may land on the
other pod. That keeps one pod's cache warm and its writes batched.

**What it shows:** at most 1 WAL entry per second per namespace, concurrent writes batched together,
and every write durable before the API says OK
([Architecture](https://turbopuffer.com/docs/architecture), [Write](https://turbopuffer.com/docs/write)).
turbopuffer documents the 1-per-second cap and routing a namespace to the same node. It doesn't say
how either works, so the CAS race and the hash ring here are my own choices.

**Optional, break the routing on purpose (terminal):** routing is a preference, not a lock, so any
pod still accepts any write. If I send writes for one namespace to both pods at once, the feed shows
commits from both pods and a `lost (412)`, and entries stay at least 1 s apart: the loser of the race
waits a full gap and goes first next round.

```bash
K=$(kubectl -n temupuffer get secret temupuffer-api -o jsonpath='{.data.API_KEY}' | base64 -d)
kubectl -n temupuffer port-forward pod/temupuffer-query-1 18080:8080 &   # skips the router
.venv/bin/python scripts/load.py --url http://localhost:18080 --key "$K" --ns race --docs 3000 --no-watch &
.venv/bin/python scripts/load.py --url https://temupuffer.agathla.com/api --key "$K" --ns race --docs 3000 --no-watch
```

This only races if `race` normally lands on `query-0`. The `x-temupuffer-upstream` response header
shows which pod answered.

## 3. The indexer catches up, then compacts (2 min)

**Watch (same page, a few seconds later):** the indexer goes *Busy: building → uploading → committing
manifest*, the queue shows `claimed by indexer-…`, the amber blocks turn teal from left to right, and
the cursor line slides right.

**Then compaction:** press **Write 5,000 rows** a few more times. Once the namespace has 4 or more
segments, the indexer merges the smallest ones into one new segment, up to 25,000 rows
(`INDEXER_MAX_SEGMENT_ROWS`), and the segment count drops. On the namespace page, each segment's
`level` counts how many times its rows have been rewritten. That's the price of having fewer
segments to search.

The replaced segments aren't deleted right away. They stay in the bucket for 2 minutes
(`GC_DELAY_S`), because a query that read the old manifest a moment ago may still be reading them.

**What it shows:** separate indexing nodes, a job queue in one JSON file updated with
compare-and-swap, and an LSM-style merge ([Architecture](https://turbopuffer.com/docs/architecture)).
The manifest swap is the commit point: before it, queries scan those rows in the WAL; after it, they
use the index. turbopuffer doesn't document its compaction or cleanup policy, so those numbers are mine.

## 4. Backpressure: trigger a 429 and watch it clear (3 min, terminal)

The **Write 5,000 rows** button can't write fast enough to get ahead of the indexer, so I use the
load script (`make venv` creates `.venv`). It needs big batches and lots of parallel requests, or a
fast indexer keeps up and nothing gets rejected:

```bash
K=$(kubectl -n temupuffer get secret temupuffer-api -o jsonpath='{.data.API_KEY}' | base64 -d)
.venv/bin/python scripts/load.py --url https://temupuffer.agathla.com/api --key "$K" --ns walkthrough \
    --start-id 100000 --docs 100000 --batch 2000 --concurrency 16
# locally: --url http://localhost:3000/api, no --key
```

**Watch:** on **Under the hood**, *unindexed rows* climbs past 20,000 and the WAL strip goes amber.
The script prints `429 backpressure … backing off`, and the activity feed shows `rejected a write
with 429`. Then the indexer catches up, and *unindexed rows* falls back to 0.

**What it shows:** turbopuffer answers 429 when a namespace has more than 2 GB or 1M unindexed rows
([Write](https://turbopuffer.com/docs/write)). I set the limit to 20,000 rows so it's easy to trigger.
A big backlog hurts queries first (more brute force) and then writes. The fixes are bigger batches,
waiting, or `disable_backpressure` plus eventual reads.

## 5. Strong vs eventual (2 min)

**Do:** open **Query**, pick `walkthrough`, choose Full text, type `quantum puffer` (the load script
uses those words), keep it on strong, and run it twice. Then switch to eventual and run it again.

**Watch** the *How this query ran* panel:
- Strong, second run: usually 2 object storage round trips (one `GET` of the manifest answered 304,
  one `LIST` of the WAL) and a few to tens of ms. Sometimes it's 3: when the indexer has just changed
  the manifest, the query reads the new one.
- Eventual: 0 round trips, a few ms, and "Reused this node's view from N s ago".
- During step 4's load, a strong query brute-forces a lot of rows, and an eventual one may skip the
  newest WAL entries.

**What it shows:** a strong query checks object storage every time, which sets the floor on its
latency. An eventual query reuses a view up to 60 s old and scans at most 128 MiB of the WAL
([Query](https://turbopuffer.com/docs/query)).

## 6. Cold vs warm cache (2 min)

**Do:** restart the query pods, then run any query twice:

```bash
kubectl -n temupuffer rollout restart statefulset/temupuffer-query
# locally: docker compose -f deploy/docker-compose.yml up -d --force-recreate query
#   (a plain "restart" keeps the container's disk cache, so the first query is warm, not cold)
```

On my homelab this also empties the cache for temupuffer-search, so its next search takes about
21 s while each pod reloads its 500k-paper shard.

**Watch:** the first run is `cold`: a second or two and many round trips. The second is `hot`:
2 round trips and tens of ms. On **Under the hood**, the cache bar shows misses (red), then memory hits
(teal). Pressing **Warm cache** on the namespace page before the first query makes that query warm instead.

Distance to the store matters too. On my homelab, for the same small namespace: SILO in the cluster
took ~130 ms cold and ~7 ms warm; Azure Blob over the internet took ~630 ms cold and ~50 ms warm.

**What it shows:** memory and disk caches in front of object storage. turbopuffer's docs show a cold
p50 of 874 ms vs 14 ms warm at 1M documents
([Architecture](https://turbopuffer.com/docs/architecture), [Warm cache](https://turbopuffer.com/docs/warm-cache)).

## 7. Kill a node, lose nothing (3 min, terminal)

```bash
# locally: a hard kill (SIGKILL) halfway through a load
TEMUPUFFER_URL=http://localhost:3000/api .venv/bin/python scripts/durability.py \
  --seconds 20 --kill-after 8 --kill-cmd "docker kill temupuffer-query-1"
# K3s: delete one query pod during a load, run from inside the cluster (deploy/README.md, "Durability test")
```

**Watch:** the script's last lines. What I measured (both before 0.1.6, when requests were spread
over both pods):
- Local, `docker kill`: 6,220 acknowledged writes, **0 missing**, 11 failed requests (errors from the
  dead pod, never acknowledged).
- K3s, `kubectl delete pod`: 9,640 acknowledged writes, **0 missing**, **0** failed requests. The pod
  got time to finish its in-flight writes while Kubernetes took it out of the Service.

**What it shows:** a write is saved to object storage before the API returns, and any pod can serve
any namespace ([Guarantees](https://turbopuffer.com/docs/guarantees)). When a pod dies, its namespaces
move to the other pod. The router only retries when a connection fails, never after a write was sent.
A failed request isn't lost data: it was never acknowledged, and retrying an upsert is safe.

## Cleaning up

When I'm done, I open the `walkthrough` namespace (and `race` or `durability-…`, if I made them) and
press **Delete namespace**. Deleting objects under `ns/` by hand in the SILO console is safe too: the
namespace disappears, and the indexer recreates `queue.json` if it's missing.

If you delete the whole **bucket** (or Azure container), restart the pods afterwards, since they only
create it at startup:
`kubectl -n temupuffer rollout restart statefulset/temupuffer-query deploy/temupuffer-indexer`.

## Questions to be ready for

1. Why does the startup self-test check `If-Match` separately from `If-None-Match`?
2. Two query nodes write to one namespace in the same second. What happens, and what does the console show?
3. Where does an acknowledged write live before the indexer runs, and what reads it?
4. Why does strong consistency cost two round trips even when nothing changed?
5. What would break if segments were mutable?
6. Why can't you just delete WAL entries below the cursor? (`wal.py`, Retention)
7. Why route by namespace instead of by client IP (Traefik's sticky option)?
8. Why does the indexer's `/readyz` turn 503 when object storage disappears, while `/healthz` stays 200?

My short answers:
1. A store can support one conditional header and silently ignore the other. The WAL relies on
   `If-None-Match: *`, and the queue and manifest rely on `If-Match`, so both have to really work.
2. Both try to PUT `wal/N` with `If-None-Match: *`. One wins; the other gets a 412, waits a full gap
   and takes N+1. The feed shows `lost (412)`. With routing, this only happens when something skips
   the router.
3. In a WAL file in object storage, above the manifest's cursor. Every strong query LISTs and scans it.
4. One conditional GET of `manifest.json` (304 when it hasn't changed) and one LIST of `wal/` after
   the cursor. Skipping either one risks missing a write.
5. Readers could see half-written files, caches keyed by key + etag would go stale, and there'd be no
   single atomic commit point: a segment is five files, and only one object write is atomic.
6. `If-None-Match: *` only protects a key that exists. Delete `wal/5`, and a writer that still thinks
   the head is 4 can PUT `wal/5` successfully: an acknowledged write below the cursor that no indexer
   will ever read. Trimming needs a fence first (writers checking the cursor).
7. Many clients write one namespace, and one client writes many namespaces. The cache and the group
   commit belong to the namespace, so that's the key that keeps one pod's cache warm and its writes batched.
8. Restarting the indexer can't bring the store back, so liveness stays green. Readiness tells
   Kubernetes (and me) the truth: the loop hasn't finished a step in 30 s (`INDEXER_READY_STALE_S`).
