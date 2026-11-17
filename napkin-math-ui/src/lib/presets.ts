import type { Step, Workload } from './engine.ts';
import { GiB, KiB, MiB, TiB } from './units.ts';

export interface Scenario {
  id: string;
  name: string;
  description: string;
  workload: Workload;
  steps: Step[];
  preset?: boolean;
}

const batch = (totalBytes: number): Workload => ({ mode: 'batch', totalBytes, rps: 1000, requestBytes: 4 * KiB, tier: 'monthly' });
const stream = (rps: number, requestBytes: number): Workload => ({ mode: 'stream', totalBytes: GiB, rps, requestBytes, tier: 'monthly' });
let n = 0;
const op = (opId: string, parallelism: number, extra: Partial<Extract<Step, { kind: 'op' }>> = {}): Step => ({ id: `p${n++}`, kind: 'op', opId, parallelism, ...extra });
const store = (costId: string, months: number, replicas = 1): Step => ({ id: `p${n++}`, kind: 'store', costId, months, replicas });

export const PRESETS: Scenario[] = [
  {
    id: 'ssd-compress-ship',
    name: 'Read, compress, ship, store',
    description: 'Read 1 GiB from local SSD, compress it, send it to another zone and keep it in blob storage for a year.',
    workload: batch(GiB),
    steps: [
      op('ssd-sequential-read-8-kib-1-thread', 32),
      op('cpu-compress-lz4-zstd-1-4-kib-1-thread', 8, { ratio: 3 }),
      op('network-cross-zone-64-kib', 32),
      op('blob-storage-regional-write-128-kib', 64, { ioBytes: 8 * MiB }),
      store('storage-blob-storage-regional', 12),
    ],
  },
  {
    id: 'logging-100k',
    name: 'Logging at 100k RPS',
    description: 'The README’s opening question: what does it cost to keep logs for an app doing 100,000 requests per second? One 1 KiB line per request, kept 30 days.',
    workload: stream(100_000, KiB),
    steps: [
      op('cpu-serialize-json-protobuf-256-b-1-thread', 1),
      op('cpu-compress-lz4-zstd-1-4-kib-1-thread', 1, { ratio: 10 }),
      op('network-cross-zone-64-kib', 32),
      store('storage-blob-storage-regional', 1),
    ],
  },
  {
    id: 'logging-saas',
    name: 'Logging at 100k RPS, hosted vendor',
    description: 'Same log volume shipped uncompressed to a Datadog-style vendor at ~$0.5/GB ingested and indexed. Compare with the blob version.',
    workload: stream(100_000, KiB),
    steps: [op('cpu-serialize-json-protobuf-256-b-1-thread', 1), op('internet-egress', 32), op('logs-ingest', 32)],
  },
  {
    id: 'scan-blob',
    name: 'Scan 1 TiB of Parquet from S3',
    description: 'A warehouse-style full scan: fetch 8 MiB ranges from regional blob storage and decode Parquet on 48 threads.',
    workload: batch(TiB),
    steps: [
      op('blob-storage-regional-read-128-kib', 512, { ioBytes: 8 * MiB }),
      op('cpu-decode-parquet-dictionary-zstd-4-kib-page-1-thread', 48, { ratio: 10 }),
      op('cpu-hash-not-crypto-safe-xxh3-64-b-1-thread', 48),
    ],
  },
  {
    id: 'api-request',
    name: 'API request path',
    description: 'One request through a proxy, a cache lookup, a primary-key query and back out to the internet, at 5,000 RPS with 4 KiB responses.',
    workload: stream(5000, 4 * KiB),
    steps: [
      op('proxy-request-haproxy-nginx-1-rtt', 1, { rttNs: 100e3 }),
      op('cpu-deserialize-json-protobuf-256-b-1-thread', 1),
      op('cache-get-memcached-redis-1-rtt', 1, { rttNs: 100e3 }),
      op('database-query-primary-key-mysql-postgres-1-rtt', 1, { rttNs: 100e3 }),
      op('cpu-serialize-json-protobuf-256-b-1-thread', 1),
      op('internet-egress', 32),
    ],
  },
  {
    id: 'reindex-netdisk',
    name: 'Rebuild an index from a network disk',
    description: 'Read 500 GiB off an EBS/Hyperdisk-style volume, sort it and write the result to local SSD. Where does the time go?',
    workload: batch(500 * GiB),
    steps: [
      op('network-disk-zonal-sequential-read-8-kib-1-thread', 32, { ioBytes: 256 * KiB }),
      op('cpu-sort-64-bit-integers-4-kib-1-thread', 16),
      op('ssd-sequential-write-8-kib-1-thread', 32),
    ],
  },
  {
    id: 'media-cdn',
    name: 'Serve images through a CDN',
    description: '20,000 image requests per second at 500 KiB. The CDN does the egress; 5% of requests miss and go to blob storage.',
    workload: stream(20_000, 500 * KiB),
    steps: [op('cdn-egress', 32), op('blob-storage-regional-read-128-kib', 32, { share: 0.05 })],
  },
  {
    id: 'cross-region-replication',
    name: 'Cross-region replication',
    description: '2,000 writes/s of 64 KiB, compressed 3x, replicated to another region and kept on network SSD for a year.',
    workload: stream(2000, 64 * KiB),
    steps: [
      op('cpu-compress-lz4-zstd-1-4-kib-1-thread', 1, { ratio: 3 }),
      op('network-cross-region-same-continent-1-mib', 32),
      op('network-disk-zonal-sequential-durable-write-8-kib-1-thread', 32),
      store('storage-network-disk-zonal', 12),
    ],
  },
  {
    id: 'memory-analytics',
    name: 'In-memory analytics',
    description: 'Hash-aggregate 100 GiB already in RAM: one pass of memory bandwidth plus decoding bitpacked integers on 48 threads.',
    workload: batch(100 * GiB),
    steps: [op('memory-sequential-read-64-b-all-cores', 1), op('cpu-decode-bitpacked-integers-512-b-1-thread', 48, { ratio: 3 }), op('cpu-hash-not-crypto-safe-xxh3-64-b-1-thread', 48)],
  },
  {
    id: 'temupuffer-cold-shard',
    name: 'temupuffer: cold start one shard',
    description: 'A temupuffer-search query pod restarts and loads its whole shard (arxiv-a, 952 MB of segment files) from object storage: 32 reads in flight, 8 MiB each. Measured on the homelab: the first search took 21 s. Napkin counts only the reads; see My homelab for the gap.',
    workload: batch(952e6),
    steps: [op('blob-storage-regional-read-128-kib', 32, { ioBytes: 8 * MiB })],
  },
];
PRESETS.forEach((p) => (p.preset = true));
