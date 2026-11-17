# Console (`db/ui`)

The console is how I watch temupuffer work. It's React 19 + Vite + TypeScript + Tailwind 4 +
TanStack Query, served by nginx. nginx also forwards `/api/*` to the query nodes, so the browser
only talks to one address and needs no CORS.

| Page | Refreshes | Shows | turbopuffer idea |
|---|---|---|---|
| Namespaces | `/v1/namespaces`, metadata per namespace | documents, size, index status | a namespace is a prefix, created by its first write |
| Namespace | metadata, documents, WAL and manifest | schema, metric, segments, **Warm cache**, **Delete namespace** | metric fixed at first write; segments + cursor |
| Query | when you run it | the request, the rows, and the `performance` block explained line by line | strong vs eventual, cold vs warm, `exhaustive_search_count` |
| Under the hood | WAL and queue every 1 s, cluster every 1.5 s | the pipeline, the WAL strip, `queue.json`, each pod's cache, S3 request counts, activity | write → WAL → indexer → query |

Under the hood also has **New practice namespace** (creates `walkthrough` with 1,000 practice rows)
and **Write 5,000 rows** (asks first if the namespace has more than 50,000 rows, since that's
probably real data).

Look: the "Reef" style I use for all three apps. JetBrains Mono everywhere (self-hosted through
@fontsource), sand in light mode and near-black in dark mode, coral for anything you can click, and
two colors that mean the same thing everywhere: **amber = in the WAL, not indexed yet** and
**teal = indexed**. The theme follows the system, with a toggle at the bottom of the sidebar.

Dev: `make run-server` and `make ui-dev`, then open http://localhost:5173. Set the API key with the
key icon in the sidebar (`tpuf-dev-key` by default). It's kept in the browser's localStorage.
