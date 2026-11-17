# Napkin Math UI

An interactive workbench for back-of-the-envelope systems estimates, built on
[sirupsen/napkin-math](https://github.com/sirupsen/napkin-math)’s reference numbers and
current list prices from AWS, Azure and Google Cloud.

I built it to sanity-check temupuffer's numbers: why a cold query costs ~100 ms per round trip, why a
WAL entry per second per namespace is cheap, and whether my homelab can hold 1M papers (it can't).

Chain steps like *read 1 GiB from SSD → compress → send cross-zone → keep in blob storage*,
and see the time, the bottleneck, the cost and every line of the math. Change any number and
everything updates. Re-price the same scenario on a real provider and region, find the cheapest VM
for a workload across three clouds, or find the cheapest way to sustain 10 GiB/s of reads.

## Quick start

```sh
npm start          # installs dependencies if needed, then opens http://localhost:5178
```

It needs Node 23.6 or newer (`brew install node`); the scripts run TypeScript directly with no build step.
Everything else, including the cloud price cache, is already in the repo, so the app works offline.

| Command | What it does |
| --- | --- |
| `npm start` | Install and run the app |
| `npm run dev` | Run the app (skip install) |
| `npm run build` | Typecheck and build a static site into `dist/` |
| `npm test` | Engine tests, including reproducing the README’s “$ / TiB read” table |
| `npm run fetch:prices` | Refresh all cloud prices into `data/cloud/` (about a minute) |
| `npm run fetch:aws` / `fetch:azure` / `fetch:gcp` | Refresh one provider |
| `npm run sync:reference` | Re-parse the reference tables from `upstream/README.md` |

## Deploy

`deploy.sh` builds the production image (a static build served by unprivileged nginx on port 8080):

| Command | What it does |
| --- | --- |
| `./deploy.sh local` | Build the image and run it at http://localhost:8080 (`PORT=…` to change) |
| `./deploy.sh local-down` | Stop the local container |
| `./deploy.sh k3s` | Build for amd64 + arm64, push to `git.agathla.com/papi/napkin-math-ui`, apply `deploy/k8s/` to the current kubectl context and wait for the rollout |
| `./deploy.sh status` | Pods, service and ingress |
| `./deploy.sh k3s-down` | Delete the `napkin-math` namespace |

`./deploy.sh k3s` pins the image by digest, so each run rolls out exactly what it built. Override
`REGISTRY`, `HOST` (default `napkinmath.agathla.com`) or `KUBE_CONTEXT` to deploy somewhere else. It needs
`docker login git.agathla.com` once. On my homelab the hostname also needs an OPNsense Unbound
override `napkinmath.agathla.com → 10.0.20.10`. I run it at https://napkinmath.agathla.com.

## What’s in the app

**Estimates.** Each scenario is a list of steps in one of two modes:

- **Batch**: process N bytes once. Each step takes `max(bytes ÷ throughput, requests × latency ÷ in flight)`
  and is marked throughput- or latency-bound. You get total time with the steps run one after another,
  time with them overlapped (the bottleneck sets the pace), and the cost.
- **Stream**: R requests/s of S bytes. You get latency per request, cores or devices busy (demand ÷
  throughput, plus Little’s law for in-flight requests), and the monthly cost.

Steps come from the full reference table (⌘K opens a searchable picker), plus *keep at rest* steps
for retention. Each step has its own knobs: threads or requests in flight, IO size, compression ratio,
latency/throughput overrides, +RTT, share of traffic (for cache hit ratios) and host size. Click a step’s name
to see its math. In any number field, ↑/↓ doubles or halves the value (shift: 10×), and fields accept text like `1.5 GiB`,
`100us` or `10k`.

Costs follow the README’s own method: transfer and request fees from the cost table, plus the rent of
the machine running the step for as long as it runs (vCPUs × shape $/vCPU/month ÷ 2.6M s).
`npm test` checks that the engine reproduces the README’s “$ / TiB read” table.

**Prices: Napkin defaults or a real region.** The *Prices* menu swaps the README’s round numbers for one provider-region’s
list prices: egress, cross-zone, cross-region, blob storage and requests, network disks, and $/vCPU for
each instance shape (median of matching SKUs). The *Assumptions* panel lists every value that was swapped in.

**Reference numbers.** Every latency, throughput, cost, blob-request price and instance-shape price
from the upstream README, editable. Edits persist in the browser and apply to every scenario.
Compression ratios and the README’s techniques are here too.

**Cloud prices.**

- *Find a VM*: the cheapest instances meeting vCPU, memory, local SSD and architecture requirements across the three clouds,
  on-demand, 1-year or spot, optionally as N × a smaller instance.
- *Throughput solver*: the cheapest way to sustain X GiB/s over a Y TB dataset, comparing network disks (sized for both capacity and
  throughput), local-NVMe instances and object storage, with a cost breakdown and assumptions per option.
- *Storage & network*: egress (with your monthly volume run through each provider’s tiers), cross-zone,
  inter-region, block and object storage, side by side for one geography.
- *Data sources*: when each dataset was fetched, whether it is live or a snapshot, and what was inferred.

Rows marked **est.** are estimates or were inferred, not read from a price list.

**My homelab** (`#homelab`). The hardware temupuffer runs on (three mini PCs: an Intel N100 and two
N150s, each running one 4-vCPU, 9.64 GiB K3s VM), a **Will it fit in RAM?** calculator for
temupuffer-search's query pods (papers × KiB per paper ÷ shards vs the pod's memory limit, starting
from my measured ~10 KiB per paper), and napkin estimates next to what I measured. Its headline:
500k papers fit (2.38 GiB per pod), 1M doesn't (4.77 GiB, 95% of the 5 GiB limit, and both pods were
OOMKilled). No cost comparison yet; I haven't added the hardware prices.

**Look.** The same "Reef" style as the temupuffer console and temupuffer-search: JetBrains Mono,
sand (light) or near-black (dark) with a toggle next to the name, coral for anything you can click.
Blue still means time, teal data, and amber money.

### Presets

Read, compress, ship, store · Logging at 100k RPS (blob vs. hosted vendor) · Scan 1 TiB of Parquet
from S3 · API request path · Rebuild an index from a network disk · Serve images through a CDN ·
Cross-region replication · In-memory analytics · temupuffer: cold start one shard (952 MB from
object storage; napkin says ~356 ms of reads, my homelab measured 21 s, because decoding on 4 small
cores dominates).

Presets are ordinary scenarios; edit them, or use *Reset preset* to restore the original. Duplicate one (⧉) or start a new estimate (+) in the sidebar.
Everything is saved in `localStorage`. Each scenario has its own URL: `#s/<id>`.

## Data

```
upstream/                  sirupsen/napkin-math as a git submodule (README, Rust benchmarks)
data/reference/*.json      parsed from upstream/README.md by scripts/sync-reference.ts
data/cloud/{aws,azure,gcp}.json   normalized price cache (schema: src/lib/schema.ts)
data/cloud/meta.json       fetch time and row counts per provider
```

All three providers share one schema: `regions`, `compute` (vCPU, memory, local SSD/HDD, network,
arch, and on-demand / spot / 1-year / 3-year $/hour), `blockStorage` ($/GB, $/IOPS, $/MiB/s, included
and max performance), `objectStorage` ($/GB, per-1M GET/PUT, retrieval) and `network` (tiered $/GB
for internet egress, inter-region and cross-zone). It’s plain JSON, so `jq` works, e.g.:

```sh
jq '[.compute[] | select(.region=="us-east-1" and .vcpu==16)] | sort_by(.price.onDemand) | .[0:5] | map({sku, onDemand: .price.onDemand})' data/cloud/aws.json
```

Regions (grouped by geography so the clouds line up): US East, US Central, US West, Europe and
Singapore. To add more, edit the region lists at the top of `scripts/providers/*.ts`.

### Where the prices come from

| Provider | Source | Notes |
| --- | --- | --- |
| AWS | [Price List bulk API](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/using-ppslong.html) offer files for EC2 (incl. EBS), S3 and Data Transfer; no credentials needed. Spot from the public feed behind aws.amazon.com/ec2/spot/pricing. | Linux, shared tenancy, current generation. 1-year/3-year are Standard RIs, no upfront. EC2 files are ~300 MB per region and are streamed, not stored. |
| Azure | [Retail Prices API](https://learn.microsoft.com/rest/api/cost-management/retail-prices/azure-retail-prices), no credentials needed. | D/E/F/L series v5+, Fsv2, Lsv3. The API doesn’t include VM specs: vCPU comes from the SKU name, and memory and local disk from per-series ratios (marked est.). |
| Google Cloud | [Cloud Billing Catalog API](https://cloud.google.com/billing/docs/how-to/get-pricing-information-api) when `GCP_API_KEY` is set. | Without a key, a curated snapshot of list prices is used, with **every row marked est.** Machine price = vCPU × core rate + GiB × RAM rate, as GCP bills predefined shapes. |

For live Google Cloud data, create an API key in any GCP project with the Cloud Billing API enabled, then run:

```sh
GCP_API_KEY=… npm run fetch:gcp
```

The live GCP fetcher hasn’t been run against the real API yet (no key was available while building this).
It falls back to snapshot values for anything it can’t match, and marks those rows est.

## Project layout

```
src/lib/engine.ts      the napkin engine: workload + steps + reference → results and math lines
src/lib/reference.ts   reference tables plus enrichment (fees, compression, host machine per op)
src/lib/cloud.ts       price-cache queries: overlay, VM finder, throughput solver, tiered egress
src/lib/units.ts       parsing and formatting of bytes, durations, counts and money
src/lib/presets.ts     preset scenarios
src/views/             Scenario, Reference, Cloud, Homelab
scripts/               reference sync, price fetchers, engine tests
upstream/              the original project (benchmarks in Rust; see upstream/BENCHMARKING.md)
```

## Caveats

- These are napkin numbers: the goal is the right order of magnitude. The reference numbers are rounded on purpose.
- Cloud prices are list prices, before negotiated discounts, savings plans, taxes and support. Spot prices are a
  point-in-time snapshot.
- Throughput solver per-disk and per-instance throughput figures are estimates from provider documentation, and
  it doesn’t model replication.
