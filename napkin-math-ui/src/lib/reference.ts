// The napkin-math reference tables (synced from upstream/README.md) plus the enrichment the
// engine needs: what each operation costs to run, whether it changes the data size, etc.
import opsJson from '../../data/reference/operations.json' with { type: 'json' };
import costsJson from '../../data/reference/costs.json' with { type: 'json' };
import blobJson from '../../data/reference/blob-requests.json' with { type: 'json' };
import shapesJson from '../../data/reference/shapes.json' with { type: 'json' };
import compressionJson from '../../data/reference/compression.json' with { type: 'json' };
import encodingsJson from '../../data/reference/encodings.json' with { type: 'json' };
import techniquesJson from '../../data/reference/techniques.json' with { type: 'json' };
import readCostJson from '../../data/reference/read-cost.json' with { type: 'json' };
import metaJson from '../../data/reference/meta.json' with { type: 'json' };
import { MiB, GiB } from './units.ts';

export type Category = 'gpu' | 'cache' | 'memory' | 'cpu' | 'os' | 'ssd' | 'hdd' | 'network-disk' | 'network' | 'blob' | 'service' | 'egress';

export interface Operation {
  id: string;
  name: string;
  category: Category;
  latencyNs: number | null;
  throughputBps: number | null;
  blockBytes: number | null;
  unitLabel: string | null;
  scope: string | null;
  perThread: boolean;
  scalesWithThreads: boolean;
  plusRtt: boolean;
  footnotes: string[];
  synthetic?: boolean;
}

export interface CostRow {
  id: string;
  group: string | null;
  name: string;
  amount: string;
  monthly: number | null;
  commit1y: number | null;
  spot: number | null;
}
export interface BlobRequestRow {
  id: string;
  name: string;
  regionalPerMillion: number;
  zonalPerMillion: number;
}
export interface Shape {
  id: string;
  name: string;
  vcpu: number;
  memoryGiB: number;
  vramGB: number;
  ssdGB: number;
  hddGB: number;
  networkGBps: number;
  monthlyPerVcpu: number;
  commit1yPerVcpu: number;
  spotPerVcpu: number;
  maxVcpu: number;
}

export const CATEGORY_LABEL: Record<Category, string> = {
  gpu: 'GPU', cache: 'CPU cache', memory: 'Memory', cpu: 'CPU work', os: 'OS & sync', ssd: 'Local SSD', hdd: 'Local HDD',
  'network-disk': 'Network disk', network: 'Network', blob: 'Blob storage', service: 'Services', egress: 'Egress & delivery',
};

/** Operations the README prices but doesn't benchmark, so you can put them in a pipeline. */
const SYNTHETIC: Operation[] = [
  { id: 'internet-egress', name: 'Network Internet Egress (1 MiB)', category: 'egress', latencyNs: 50e6, throughputBps: 3 * GiB, blockBytes: MiB, unitLabel: null, scope: null, perThread: false, scalesWithThreads: false, plusRtt: false, footnotes: [], synthetic: true },
  { id: 'cdn-egress', name: 'CDN Egress (128 KiB)', category: 'egress', latencyNs: 20e6, throughputBps: 100 * GiB, blockBytes: 128 * 1024, unitLabel: null, scope: null, perThread: false, scalesWithThreads: false, plusRtt: false, footnotes: [], synthetic: true },
  { id: 'logs-ingest', name: 'Logs / Traces Ingest (1 KiB line)', category: 'egress', latencyNs: 10e6, throughputBps: GiB, blockBytes: 1024, unitLabel: null, scope: null, perThread: false, scalesWithThreads: false, plusRtt: false, footnotes: [], synthetic: true },
  { id: 'l4-load-balancer', name: 'L4 Load Balancer (32 KiB)', category: 'egress', latencyNs: 50e3, throughputBps: 3 * GiB, blockBytes: 32 * 1024, unitLabel: null, scope: null, perThread: false, scalesWithThreads: false, plusRtt: false, footnotes: [], synthetic: true },
];

export const OPERATIONS: Operation[] = [...(opsJson as Operation[]), ...SYNTHETIC];
export const OPS_BY_ID = new Map(OPERATIONS.map((o) => [o.id, o]));
export const COSTS = costsJson as CostRow[];
export const BLOB_REQUESTS = blobJson as BlobRequestRow[];
export const SHAPES = shapesJson as Shape[];
export const COMPRESSION = compressionJson as { id: string; name: string; low: number; high: number }[];
export const ENCODINGS = encodingsJson as { id: string; name: string; encoding: string; ratio: string }[];
export const TECHNIQUES = techniquesJson as { title: string; body: string }[];
export const READ_COST = readCostJson as { name: string; perTiB: number; commit1y: number; spot: number }[];
export const REFERENCE_META = metaJson as { source: string; measured: string | null; syncedAt: string };

export const STORE_CLASSES = COSTS.filter((c) => c.group === 'Storage' && /^1 GB$/.test(c.amount));

/** Short label for chips: drop the parenthesised size and ", 1 thread" suffix. */
export function shortName(op: Operation): string {
  return op.name
    .replace(/\s*\(\+1 RTT\)/, '')
    .replace(/\s*\(([^()]*)\)/g, (_, inner: string) => {
      const kept = inner.replace(/,?\s*\d[\d.]*\s*(B|KiB|MiB|GiB)( page)?$/, '').replace(/^\d+ keys$/, '').trim();
      return kept ? ` (${kept})` : '';
    })
    .replace(/,\s*1 thread$/, '')
    .trim();
}

// ── Enrichment ────────────────────────────────────────────────────────────────

export type Transform = { kind: 'compress' | 'decompress'; defaultRatio: number } | null;

export function transformOf(op: Operation): Transform {
  if (/^CPU Compress/.test(op.name)) return { kind: 'compress', defaultRatio: 3 };
  if (/^CPU Decompress/.test(op.name)) return { kind: 'decompress', defaultRatio: 3 };
  if (/^CPU Encode Parquet/.test(op.name)) return { kind: 'compress', defaultRatio: 10 };
  if (/^CPU Decode Parquet/.test(op.name)) return { kind: 'decompress', defaultRatio: 10 };
  if (/^CPU Encode Bitpacked/.test(op.name)) return { kind: 'compress', defaultRatio: 3 };
  if (/^CPU Decode Bitpacked/.test(op.name)) return { kind: 'decompress', defaultRatio: 3 };
  return null;
}

export type Fee =
  | { kind: 'perGB'; costId: string; label: string }
  | { kind: 'perGBConst'; usd: number; label: string }
  | { kind: 'blobRequest'; row: 'reads' | 'writes-lists'; scope: 'regional' | 'zonal'; label: string }
  | { kind: 'perMillionConst'; usd: number; label: string };

/** Transfer / request fees that an operation incurs, mapped to the cost table. */
export function feesOf(op: Operation): Fee[] {
  const n = op.name;
  if (op.id === 'internet-egress') return [{ kind: 'perGB', costId: 'network-internet-egress', label: 'Internet egress' }];
  if (op.id === 'cdn-egress') return [{ kind: 'perGB', costId: 'cdn-egress', label: 'CDN egress' }, { kind: 'perMillionConst', usd: 1, label: 'CDN requests' }];
  if (op.id === 'logs-ingest') return [{ kind: 'perGB', costId: 'logs-traces', label: 'Logs/traces ingest + index' }];
  if (op.id === 'l4-load-balancer') return [{ kind: 'perGB', costId: 'network-l4-load-balancer', label: 'L4 load balancer' }];
  if (/^Network Cross-Zone/.test(n)) return [{ kind: 'perGB', costId: 'network-cross-zone', label: 'Cross-zone transfer' }];
  if (/^Network Cross-Region/.test(n)) return [{ kind: 'perGB', costId: 'network-cross-region', label: 'Cross-region transfer' }];
  if (/^Blob Storage/.test(n)) {
    const zonal = /Zonal/.test(n);
    const scope = zonal ? 'zonal' : 'regional';
    if (/Read/.test(n)) {
      const f: Fee[] = [{ kind: 'blobRequest', row: 'reads', scope, label: `Blob GET (${scope})` }];
      if (zonal) f.push({ kind: 'perGBConst', usd: 0.0006, label: 'Zonal per-GB read' });
      return f;
    }
    if (/Write|List/.test(n)) {
      const f: Fee[] = [{ kind: 'blobRequest', row: 'writes-lists', scope, label: `Blob PUT/LIST (${scope})` }];
      if (zonal && /Write/.test(n)) f.push({ kind: 'perGBConst', usd: 0.003, label: 'Zonal per-GB write' });
      return f;
    }
  }
  return [];
}

/** The machine you rent while a step runs (the README's "$ / TiB read" methodology). */
export interface HostDefault {
  shapeId: string;
  vcpus: number | 'parallelism' | 'auto';
  why: string;
}
export function hostOf(op: Operation): HostDefault {
  switch (op.category) {
    case 'gpu':
      return { shapeId: 'gpu-b200', vcpus: 25, why: 'One B200 comes with 25 vCPU' };
    case 'cache':
    case 'cpu':
    case 'os':
    case 'service':
      return { shapeId: 'general', vcpus: 'parallelism', why: 'One vCPU per thread' };
    case 'memory':
      return op.perThread ? { shapeId: 'general', vcpus: 'parallelism', why: 'One vCPU per thread' } : { shapeId: 'general', vcpus: 48, why: 'All cores of a 48 vCPU VM' };
    case 'ssd':
      return { shapeId: 'general-ssd', vcpus: 48, why: '48 vCPU General, SSD (local disks pay their rent in the shape)' };
    case 'hdd':
      return { shapeId: 'hdd', vcpus: 2, why: '2 vCPU of the HDD shape per 14 TB drive' };
    case 'network-disk':
      return { shapeId: 'general', vcpus: 'auto', why: 'Just enough General to reach the disk, ~40 MB/s per vCPU' };
    case 'network':
    case 'blob':
      return { shapeId: 'general', vcpus: 48, why: '48 vCPU General fills the ~30 Gbit/s NIC' };
    case 'egress':
      return { shapeId: 'general', vcpus: 0, why: 'Fees only; the sender is priced in its own step' };
  }
}

export const DISK_MB_PER_VCPU = 40e6;

/**
 * I/O rows wait on a device or the network, so many requests in flight hide latency (the README
 * benchmarks keep 32 in flight). CPU / memory rows' throughput already includes the hardware's own
 * parallelism, so only their throughput bounds time; their knob is threads.
 */
export const isIoBound = (op: Operation) => !['cpu', 'memory', 'cache', 'gpu'].includes(op.category) || !op.throughputBps;
export const defaultParallelism = (op: Operation) => (isIoBound(op) && op.throughputBps ? 32 : 1);
export const parallelismLabel = (op: Operation) => (isIoBound(op) ? 'in flight' : 'threads');
