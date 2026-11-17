// Query helpers over the cached cloud datasets (data/cloud/*.json).
import type { BlockStorage, ComputeSku, Geo, NetworkPrice, ObjectStorage, PriceTier, Provider, ProviderDataset } from './schema.ts';
import { HOURS_PER_MONTH, PROVIDER_LABEL } from './schema.ts';
import type { Overrides, PricingTier } from './engine.ts';
import { GiB, MiB, GB, formatRate, formatBytes, sig, formatMoney } from './units.ts';

export type Datasets = Partial<Record<Provider, ProviderDataset>>;

let cache: Promise<Datasets> | null = null;
/** Lazy-load the cache so the first paint doesn't wait for ~3 MB of JSON. */
export function loadDatasets(): Promise<Datasets> {
  cache ??= Promise.all([
    import('../../data/cloud/aws.json').then((m) => m.default as unknown as ProviderDataset).catch(() => undefined),
    import('../../data/cloud/azure.json').then((m) => m.default as unknown as ProviderDataset).catch(() => undefined),
    import('../../data/cloud/gcp.json').then((m) => m.default as unknown as ProviderDataset).catch(() => undefined),
  ]).then(([aws, azure, gcp]) => ({ aws, azure, gcp }));
  return cache;
}

export const TIER_KEY = { monthly: 'onDemand', commit1y: 'commit1y', spot: 'spot' } as const;

export function hourly(sku: ComputeSku, tier: PricingTier): number | null {
  return sku.price[TIER_KEY[tier]];
}
export function monthly(sku: ComputeSku, tier: PricingTier): number | null {
  const h = hourly(sku, tier);
  return h == null ? null : h * HOURS_PER_MONTH;
}

export function tieredCost(tiers: PriceTier[], gb: number): number {
  const t = [...tiers].sort((a, b) => a.fromGB - b.fromGB);
  let usd = 0;
  for (let i = 0; i < t.length; i++) {
    const lo = t[i].fromGB;
    const hi = t[i + 1]?.fromGB ?? Infinity;
    if (gb <= lo) break;
    usd += (Math.min(gb, hi) - lo) * t[i].perGB;
  }
  return usd;
}
/** First non-zero tier: the marginal rate most napkin estimates want. */
export const headlineRate = (tiers: PriceTier[]) => tiers.find((t) => t.perGB > 0)?.perGB ?? tiers[0]?.perGB ?? 0;

const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

export function regionsByGeo(ds: Datasets, geo: Geo): { provider: Provider; region: string; name: string }[] {
  return (Object.values(ds).filter(Boolean) as ProviderDataset[]).flatMap((d) => d.regions.filter((r) => r.geo === geo).map((r) => ({ provider: d.provider, region: r.id, name: r.name })));
}

/** Median $/vCPU/month for a shape class in one region. */
export function perVcpuMonth(d: ProviderDataset, region: string, pred: (c: ComputeSku) => boolean, tier: PricingTier): number {
  const per = d.compute
    .filter((c) => c.region === region && c.gpus === 0 && c.vcpu >= 4 && c.vcpu <= 96 && pred(c) && monthly(c, tier) != null)
    .map((c) => monthly(c, tier)! / c.vcpu);
  return median(per);
}

const ratio = (c: ComputeSku) => c.memoryGiB / c.vcpu;
export const SHAPE_CLASS: Record<string, (c: ComputeSku) => boolean> = {
  cpu: (c) => ratio(c) >= 1.5 && ratio(c) <= 2.5 && c.localSsdGB === 0 && c.category !== 'burstable',
  general: (c) => ratio(c) >= 3.5 && ratio(c) <= 4.5 && c.localSsdGB === 0 && c.category !== 'burstable',
  'general-ssd': (c) => ratio(c) >= 3.5 && ratio(c) <= 4.5 && c.localSsdGB > 0 && c.category !== 'storage',
  memory: (c) => ratio(c) >= 7 && ratio(c) <= 9 && c.localSsdGB === 0 && c.category !== 'storage',
  'memory-ssd': (c) => ratio(c) >= 7 && ratio(c) <= 9 && c.localSsdGB > 0 && c.category !== 'storage',
  ssd: (c) => c.category === 'storage' && c.localSsdGB > 0,
};

export interface Overlay {
  overrides: Overrides;
  mapped: { what: string; value: string; from: string }[];
}

const NETDISK_SSD: Record<Provider, string[]> = { aws: ['gp3'], azure: ['premium-ssd-v2'], gcp: ['hyperdisk-balanced', 'pd-balanced'] };
const NETDISK_HDD: Record<Provider, string[]> = { aws: ['st1'], azure: ['standard-hdd-s30'], gcp: ['pd-standard'] };

/** Turn one provider-region into cost-table overrides, so any scenario can be priced on it. */
export function overlayFor(d: ProviderDataset, region: string): Overlay {
  const mapped: Overlay['mapped'] = [];
  const costs: NonNullable<Overrides['costs']> = {};
  const shapes: NonNullable<Overrides['shapes']> = {};
  const blob: NonNullable<Overrides['blob']> = {};
  const net = (k: NetworkPrice['kind']) => d.network.find((n) => n.region === region && n.kind === k);
  const setCost = (id: string, v: number | undefined, label: string, from: string) => {
    if (v == null || !Number.isFinite(v)) return;
    costs[id] = { monthly: v, commit1y: null as any, spot: null as any };
    mapped.push({ what: label, value: `${formatMoney(v)}`, from });
  };
  const eg = net('internet-egress');
  if (eg) setCost('network-internet-egress', headlineRate(eg.tiers), 'Internet egress / GB', eg.name);
  const cz = net('cross-zone');
  if (cz) setCost('network-cross-zone', headlineRate(cz.tiers), 'Cross-zone / GB', cz.name);
  const ir = net('inter-region');
  if (ir) setCost('network-cross-region', headlineRate(ir.tiers), 'Cross-region / GB', ir.name);

  const obj = (t: ObjectStorage['tier']) => d.objectStorage.find((o) => o.region === region && o.tier === t);
  const std = obj('standard');
  const zonal = obj('zonal');
  if (std) {
    setCost('storage-blob-storage-regional', std.perGBMonth, 'Blob storage, regional / GB·mo', std.name);
    blob.reads = { regionalPerMillion: std.perMillionReads };
    blob['writes-lists'] = { regionalPerMillion: std.perMillionWrites };
    mapped.push({ what: 'Blob GET / PUT per 1M', value: `${formatMoney(std.perMillionReads)} / ${formatMoney(std.perMillionWrites)}`, from: std.name });
  }
  if (zonal) {
    setCost('storage-blob-storage-zonal', zonal.perGBMonth, 'Blob storage, zonal / GB·mo', zonal.name);
    blob.reads = { ...blob.reads, zonalPerMillion: zonal.perMillionReads };
    blob['writes-lists'] = { ...blob['writes-lists'], zonalPerMillion: zonal.perMillionWrites };
  }
  const disk = (ids: string[]) => ids.map((id) => d.blockStorage.find((b) => b.region === region && b.id === id)).find(Boolean) as BlockStorage | undefined;
  const ssd = disk(NETDISK_SSD[d.provider]);
  if (ssd) {
    setCost('storage-network-disk-zonal', ssd.perGBMonth, 'Network disk SSD / GB·mo', ssd.name);
    if (ssd.perIopsMonth != null) setCost('storage-network-disk-zonal-iops', ssd.perIopsMonth, 'Provisioned IOPS / mo', ssd.name);
    if (ssd.perMiBpsMonth != null) setCost('storage-network-disk-zonal-throughput', ssd.perMiBpsMonth, 'Provisioned MiB/s / mo', ssd.name);
  }
  const hdd = disk(NETDISK_HDD[d.provider]);
  if (hdd) setCost('storage-network-disk-zonal-hdd', hdd.perGBMonth, 'Network disk HDD / GB·mo', hdd.name);

  for (const [shapeId, pred] of Object.entries(SHAPE_CLASS)) {
    const od = perVcpuMonth(d, region, pred, 'monthly');
    if (!Number.isFinite(od)) continue;
    const y1 = perVcpuMonth(d, region, pred, 'commit1y');
    const sp = perVcpuMonth(d, region, pred, 'spot');
    shapes[shapeId] = { monthlyPerVcpu: od, commit1yPerVcpu: Number.isFinite(y1) ? y1 : undefined, spotPerVcpu: Number.isFinite(sp) ? sp : undefined };
    mapped.push({ what: `${shapeId} shape / vCPU·mo`, value: `${formatMoney(od)}${Number.isFinite(y1) ? ` · 1y ${formatMoney(y1)}` : ''}${Number.isFinite(sp) ? ` · spot ${formatMoney(sp)}` : ''}`, from: 'median of matching SKUs' });
  }
  const cpuShape = shapes.general;
  if (cpuShape) costs.cpu = { monthly: cpuShape.monthlyPerVcpu, commit1y: cpuShape.commit1yPerVcpu, spot: cpuShape.spotPerVcpu };
  return { overrides: { costs, shapes, blob }, mapped };
}

// ── VM finder ─────────────────────────────────────────────────────────────────

export interface VmQuery {
  vcpu: number;
  memoryGiB: number;
  localSsdGB: number;
  arch: 'any' | 'x86' | 'arm';
  tier: PricingTier;
  geo: Geo;
  providers: Provider[];
  allowFleet: boolean;
  includeBurstable: boolean;
}
export interface VmMatch {
  sku: ComputeSku;
  count: number;
  monthly: number;
  perVcpu: number;
  waste: number; // over-provisioning vs request, in the binding dimension's terms
  regionName: string;
}

export function findVms(ds: Datasets, q: VmQuery, limit = 40): VmMatch[] {
  const out: VmMatch[] = [];
  for (const p of q.providers) {
    const d = ds[p];
    if (!d) continue;
    const regions = new Map(d.regions.filter((r) => r.geo === q.geo).map((r) => [r.id, r.name]));
    for (const c of d.compute) {
      if (!regions.has(c.region) || c.gpus > 0) continue;
      if (q.arch !== 'any' && c.arch !== q.arch) continue;
      if (!q.includeBurstable && c.category === 'burstable') continue;
      const m = monthly(c, q.tier);
      if (m == null) continue;
      const need = Math.max(q.vcpu / c.vcpu, q.memoryGiB / c.memoryGiB, q.localSsdGB > 0 ? (c.localSsdGB ? q.localSsdGB / c.localSsdGB : Infinity) : 0);
      const count = q.allowFleet ? Math.max(1, Math.ceil(need - 1e-9)) : need <= 1 ? 1 : Infinity;
      if (!Number.isFinite(count) || count > 1000) continue;
      const total = count * m;
      const waste = (count * c.vcpu) / Math.max(1, q.vcpu) - 1;
      out.push({ sku: c, count, monthly: total, perVcpu: m / c.vcpu, waste, regionName: regions.get(c.region)! });
    }
  }
  out.sort((a, b) => a.monthly - b.monthly);
  return out.slice(0, limit);
}

// ── Throughput solver ─────────────────────────────────────────────────────────

export interface ThroughputQuery {
  targetBps: number;
  datasetGB: number;
  hoursPerMonth: number; // how long you actually read at that rate
  objectRequestBytes: number;
  tier: PricingTier;
  geo: Geo;
  providers: Provider[];
}
export interface ThroughputOption {
  provider: Provider;
  region: string;
  regionName: string;
  kind: 'Network disk' | 'Local NVMe' | 'Object storage';
  name: string;
  units: string;
  monthly: number;
  lines: { label: string; usd: number }[];
  assumptions: string[];
  estimated: boolean;
}

const PER_DISK_LOCAL_BPS = (p: Provider, c: ComputeSku) => {
  const perDisk = c.localDisks ? c.localSsdGB / c.localDisks : c.localSsdGB;
  if (p === 'gcp') return perDisk >= 3000 ? 1.5 * GiB : 0.65 * GiB;
  return perDisk >= 1500 ? 2 * GiB : 1 * GiB;
};

export function solveThroughput(ds: Datasets, q: ThroughputQuery): ThroughputOption[] {
  const out: ThroughputOption[] = [];
  const frac = q.hoursPerMonth / HOURS_PER_MONTH;
  for (const p of q.providers) {
    const d = ds[p];
    if (!d) continue;
    for (const r of d.regions.filter((x) => x.geo === q.geo)) {
      const vcpuMonth = perVcpuMonth(d, r.id, SHAPE_CLASS.general, q.tier);
      // 1. Network block storage
      for (const b of d.blockStorage.filter((x) => x.region === r.id)) {
        const perVolBps = b.maxMiBps * MiB;
        const vols = Math.max(1, Math.ceil(q.targetBps / perVolBps), Math.ceil(q.datasetGB / b.maxSizeGB));
        // Disks whose throughput scales with size must be big enough to deliver their share.
        const perGB = THROUGHPUT_PER_GB[b.id];
        const sizeForTp = perGB ? q.targetBps / vols / MiB / perGB : 0;
        const sizeGB = Math.min(b.maxSizeGB, Math.max(q.datasetGB / vols, sizeForTp));
        if (perGB && sizeGB * perGB * vols * MiB < q.targetBps * 0.999) continue; // can't reach target within max size
        const tpPerVol = q.targetBps / vols / MiB;
        const extraTp = b.perMiBpsMonth != null ? Math.max(0, tpPerVol - b.includedMiBps) : 0;
        const iopsPerVol = (tpPerVol * MiB) / (256 * 1024);
        const extraIops = b.perIopsMonth != null ? Math.max(0, iopsPerVol - b.includedIops) : 0;
        if (b.perMiBpsMonth == null && tpPerVol > b.includedMiBps + 1e-6) {
          // fixed-performance tiers: need more volumes
          const v2 = Math.ceil(q.targetBps / (b.includedMiBps * MiB));
          if (v2 > 2000) continue;
          const sz = Math.max(q.datasetGB / v2, b.maxSizeGB);
          const lines = [
            { label: `${v2} × ${b.name} (${formatBytes(sz * GB)} each)`, usd: v2 * sz * b.perGBMonth },
            { label: `${sig(q.targetBps / DISK_BPS_PER_VCPU)} vCPU to drive it (${sig(frac * 100)}% of month)`, usd: (q.targetBps / DISK_BPS_PER_VCPU) * vcpuMonth * frac },
          ];
          out.push({ provider: p, region: r.id, regionName: r.name, kind: 'Network disk', name: b.name, units: `${v2} volumes`, monthly: sum(lines), lines, estimated: !!b.estimated,
            assumptions: [`Fixed ${b.includedMiBps} MiB/s per volume at this tier`, b.notes ?? ''].filter(Boolean) });
          continue;
        }
        const lines = [
          { label: `${vols} × ${b.name}, ${formatBytes(sizeGB * GB)} each`, usd: vols * sizeGB * b.perGBMonth },
          ...(extraTp > 0 ? [{ label: `+${sig(extraTp)} MiB/s provisioned per volume`, usd: vols * extraTp * b.perMiBpsMonth! }] : []),
          ...(extraIops > 0 ? [{ label: `+${sig(extraIops)} IOPS per volume (256 KiB IOs)`, usd: vols * extraIops * b.perIopsMonth! }] : []),
          { label: `${sig(q.targetBps / DISK_BPS_PER_VCPU)} vCPU to drive it (~40 MB/s per vCPU)`, usd: (q.targetBps / DISK_BPS_PER_VCPU) * vcpuMonth * frac },
        ];
        out.push({ provider: p, region: r.id, regionName: r.name, kind: 'Network disk', name: b.name, units: `${vols} volume${vols > 1 ? 's' : ''}`, monthly: sum(lines), lines, estimated: !!b.estimated,
          assumptions: [
            `Max ${b.maxMiBps} MiB/s per volume; ${b.includedMiBps} MiB/s included`,
            ...(perGB ? [`Throughput scales ~${sig(perGB * 1024)} MiB/s per TiB, so volumes are sized for throughput, not just data`] : []),
            'Instance EBS/disk bandwidth limits also apply',
            b.notes ?? '',
          ].filter(Boolean) });
      }
      // 2. Local NVMe (best 3 SKUs per region)
      const local = d.compute
        .filter((c) => c.region === r.id && c.localSsdGB > 0 && c.gpus === 0 && monthly(c, q.tier) != null)
        .map((c) => {
          const perInst = Math.min(PER_DISK_LOCAL_BPS(p, c) * Math.max(1, c.localDisks), (c.networkGbps ?? 1e9) * 1e9 * 10); // local reads aren't NIC-bound
          const n = Math.max(1, Math.ceil(q.targetBps / perInst), Math.ceil(q.datasetGB / c.localSsdGB));
          return { c, n, perInst, usd: n * monthly(c, q.tier)! };
        })
        .filter((x) => x.n <= 500)
        .sort((a, b) => a.usd - b.usd)
        .slice(0, 3);
      for (const x of local)
        out.push({
          provider: p, region: r.id, regionName: r.name, kind: 'Local NVMe', name: x.c.sku, units: `${x.n} instance${x.n > 1 ? 's' : ''}`, monthly: x.usd,
          lines: [{ label: `${x.n} × ${x.c.sku} (${x.c.vcpu} vCPU, ${formatBytes(x.c.localSsdGB * GB)} NVMe) all month`, usd: x.usd }],
          estimated: !!x.c.estimated || !!x.c.derived?.includes('localSsdGB'),
          assumptions: [`~${formatRate(x.perInst)} per instance (${x.c.localDisks || 1} disk${(x.c.localDisks || 1) > 1 ? 's' : ''}, estimated)`, 'Instances run all month to keep the data; no replication', 'Data is lost if the instance stops'],
        });
      // 3. Object storage
      for (const o of d.objectStorage.filter((x) => x.region === r.id && x.tier !== 'archive')) {
        const bytes = q.targetBps * q.hoursPerMonth * 3600;
        const reqs = bytes / q.objectRequestBytes;
        const vcpus = (q.targetBps / (3 * GiB)) * 48;
        const lines = [
          { label: `Store ${formatBytes(q.datasetGB * GB)}`, usd: q.datasetGB * o.perGBMonth },
          { label: `${sig(reqs / 1e6)}M GETs of ${formatBytes(q.objectRequestBytes)}`, usd: (reqs / 1e6) * o.perMillionReads },
          ...(o.retrievalPerGB ? [{ label: `Retrieval ${sig(bytes / GB)} GB`, usd: (bytes / GB) * o.retrievalPerGB }] : []),
          { label: `${sig(vcpus)} vCPU of readers (48 vCPU per 3 GiB/s)`, usd: vcpus * vcpuMonth * frac },
        ];
        out.push({ provider: p, region: r.id, regionName: r.name, kind: 'Object storage', name: o.name, units: `${sig(q.targetBps / (100 * MiB))} connections`, monthly: sum(lines), lines, estimated: !!o.estimated,
          assumptions: ['~100 MiB/s per connection, scales out horizontally', 'p99 first byte ~100 ms (regional)', 'Same-region transfer is free'] });
      }
    }
  }
  return out.filter((o) => Number.isFinite(o.monthly)).sort((a, b) => a.monthly - b.monthly);
}
const DISK_BPS_PER_VCPU = 40e6;
/** Baseline MiB/s per provisioned GB for disks whose throughput grows with size (provider docs). */
const THROUGHPUT_PER_GB: Record<string, number> = {
  st1: 40 / 1024,
  sc1: 12 / 1024,
  'pd-standard': 0.12,
  'pd-balanced': 0.28,
  'pd-ssd': 0.48,
  'hyperdisk-throughput': 90 / 1024,
};
const sum = (xs: { usd: number }[]) => xs.reduce((a, x) => a + (Number.isFinite(x.usd) ? x.usd : 0), 0);

export const providerName = (p: Provider) => PROVIDER_LABEL[p];
