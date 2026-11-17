// Google Cloud. Two modes:
//   live      GCP_API_KEY set → Cloud Billing Catalog API (cloudbilling.googleapis.com/v1/services/*/skus).
//             Per-family vCPU / RAM unit prices are read per region and multiplied into machine shapes.
//   snapshot  no key → curated list prices (us-central1 base, published regional multipliers), every row
//             marked `estimated`. Run `GCP_API_KEY=… npm run fetch:gcp` to replace them.
// Anything the live catalog doesn't yield falls back to the snapshot value and stays `estimated`.
import type { BlockStorage, ComputeSku, NetworkPrice, ObjectStorage, ProviderDataset, Region } from '../../src/lib/schema.ts';
import { getJson, log, round } from '../lib/http.ts';

export const GCP_REGIONS: Region[] = [
  { provider: 'gcp', id: 'us-east4', name: 'N. Virginia (us-east4)', geo: 'us-east' },
  { provider: 'gcp', id: 'us-central1', name: 'Iowa (us-central1)', geo: 'us-central' },
  { provider: 'gcp', id: 'us-west1', name: 'Oregon (us-west1)', geo: 'us-west' },
  { provider: 'gcp', id: 'europe-west1', name: 'Belgium (europe-west1)', geo: 'europe' },
  { provider: 'gcp', id: 'asia-southeast1', name: 'Singapore (asia-southeast1)', geo: 'asia' },
];

/** Approximate list-price multipliers vs us-central1 (on-demand compute). */
const REGION_MULT: Record<string, number> = { 'us-central1': 1, 'us-west1': 1, 'us-east4': 1.126, 'europe-west1': 1.1, 'asia-southeast1': 1.233 };
const CONTINENT: Record<string, 'Americas' | 'EMEA' | 'APAC'> = { 'us-central1': 'Americas', 'us-west1': 'Americas', 'us-east4': 'Americas', 'europe-west1': 'EMEA', 'asia-southeast1': 'APAC' };

interface Family {
  /** catalog family token as it appears in SKU descriptions ("N2", "C4A", "N2D") */
  token: string;
  arch: 'x86' | 'arm';
  category: ComputeSku['category'];
  core: number; // $/vCPU-hour, us-central1, on-demand
  ram: number; // $/GiB-hour
  spotFactor: number; // spot / on-demand (typical)
  shapes: { suffix: string; memPerVcpu: number; sizes: number[]; category?: ComputeSku['category'] }[];
  localSsd?: { perVcpu: number; disks: (v: number) => number; suffix: string };
  networkGbps: (vcpu: number) => number;
}

const net = (perVcpu: number, cap: number) => (v: number) => Math.min(cap, Math.max(10, v * perVcpu));
const STD = [2, 4, 8, 16, 32, 48, 64, 80, 96, 128];

const FAMILIES: Family[] = [
  { token: 'E2', arch: 'x86', category: 'general', core: 0.021811, ram: 0.002923, spotFactor: 0.31, networkGbps: net(2, 16),
    shapes: [{ suffix: 'standard', memPerVcpu: 4, sizes: [2, 4, 8, 16, 32] }, { suffix: 'highmem', memPerVcpu: 8, sizes: [2, 4, 8, 16], category: 'memory' }, { suffix: 'highcpu', memPerVcpu: 1, sizes: [2, 4, 8, 16, 32], category: 'compute' }] },
  { token: 'N2', arch: 'x86', category: 'general', core: 0.031611, ram: 0.004237, spotFactor: 0.27, networkGbps: net(2, 32),
    shapes: [{ suffix: 'standard', memPerVcpu: 4, sizes: STD }, { suffix: 'highmem', memPerVcpu: 8, sizes: STD, category: 'memory' }, { suffix: 'highcpu', memPerVcpu: 1, sizes: STD, category: 'compute' }] },
  { token: 'N2D', arch: 'x86', category: 'general', core: 0.027502, ram: 0.003686, spotFactor: 0.25, networkGbps: net(2, 32),
    shapes: [{ suffix: 'standard', memPerVcpu: 4, sizes: [...STD, 224] }, { suffix: 'highmem', memPerVcpu: 8, sizes: STD, category: 'memory' }, { suffix: 'highcpu', memPerVcpu: 1, sizes: STD, category: 'compute' }] },
  { token: 'N4', arch: 'x86', category: 'general', core: 0.030756, ram: 0.003581, spotFactor: 0.3, networkGbps: net(2, 50),
    shapes: [{ suffix: 'standard', memPerVcpu: 4, sizes: [2, 4, 8, 16, 32, 48, 64, 80] }, { suffix: 'highmem', memPerVcpu: 8, sizes: [2, 4, 8, 16, 32, 48, 64, 80], category: 'memory' }, { suffix: 'highcpu', memPerVcpu: 2, sizes: [2, 4, 8, 16, 32, 48, 64, 80], category: 'compute' }] },
  { token: 'C3', arch: 'x86', category: 'general', core: 0.03398, ram: 0.00455, spotFactor: 0.3, networkGbps: net(2, 100),
    shapes: [{ suffix: 'standard', memPerVcpu: 4, sizes: [4, 8, 22, 44, 88, 176] }, { suffix: 'highmem', memPerVcpu: 8, sizes: [4, 8, 22, 44, 88, 176], category: 'memory' }, { suffix: 'highcpu', memPerVcpu: 2, sizes: [4, 8, 22, 44, 88, 176], category: 'compute' }],
    localSsd: { perVcpu: 17.05, disks: (v) => Math.max(1, Math.round((v * 17.05) / 375)), suffix: 'lssd' } },
  { token: 'C3D', arch: 'x86', category: 'general', core: 0.029563, ram: 0.003959, spotFactor: 0.3, networkGbps: net(2, 100),
    shapes: [{ suffix: 'standard', memPerVcpu: 4, sizes: [4, 8, 16, 30, 60, 90, 180, 360] }, { suffix: 'highmem', memPerVcpu: 8, sizes: [4, 8, 16, 30, 60, 90, 180, 360], category: 'memory' }, { suffix: 'highcpu', memPerVcpu: 2, sizes: [4, 8, 16, 30, 60, 90, 180, 360], category: 'compute' }] },
  { token: 'C4', arch: 'x86', category: 'general', core: 0.03465, ram: 0.003938, spotFactor: 0.3, networkGbps: net(2, 100),
    shapes: [{ suffix: 'standard', memPerVcpu: 3.75, sizes: [2, 4, 8, 16, 24, 32, 48, 96, 144, 192, 288] }, { suffix: 'highmem', memPerVcpu: 7.75, sizes: [2, 4, 8, 16, 24, 32, 48, 96, 144, 192, 288], category: 'memory' }, { suffix: 'highcpu', memPerVcpu: 2, sizes: [2, 4, 8, 16, 24, 32, 48, 96, 144, 192, 288], category: 'compute' }],
    localSsd: { perVcpu: 46.875, disks: (v) => Math.max(1, Math.round((v * 46.875) / 375)), suffix: 'lssd' } },
  { token: 'C4D', arch: 'x86', category: 'general', core: 0.0306, ram: 0.00347, spotFactor: 0.3, networkGbps: net(2, 100),
    shapes: [{ suffix: 'standard', memPerVcpu: 3.875, sizes: [2, 4, 8, 16, 32, 48, 64, 96, 192, 384] }, { suffix: 'highmem', memPerVcpu: 7.875, sizes: [2, 4, 8, 16, 32, 48, 64, 96, 192, 384], category: 'memory' }, { suffix: 'highcpu', memPerVcpu: 1.875, sizes: [2, 4, 8, 16, 32, 48, 64, 96, 192, 384], category: 'compute' }] },
  { token: 'C4A', arch: 'arm', category: 'general', core: 0.03082, ram: 0.00351, spotFactor: 0.3, networkGbps: net(2, 100),
    shapes: [{ suffix: 'standard', memPerVcpu: 4, sizes: [1, 2, 4, 8, 16, 32, 48, 64, 72] }, { suffix: 'highmem', memPerVcpu: 8, sizes: [1, 2, 4, 8, 16, 32, 48, 64, 72], category: 'memory' }, { suffix: 'highcpu', memPerVcpu: 2, sizes: [1, 2, 4, 8, 16, 32, 48, 64, 72], category: 'compute' }],
    localSsd: { perVcpu: 46.875, disks: (v) => Math.max(1, Math.round((v * 46.875) / 375)), suffix: 'lssd' } },
  { token: 'T2D', arch: 'x86', category: 'compute', core: 0.027502, ram: 0.003686, spotFactor: 0.25, networkGbps: net(2, 32),
    shapes: [{ suffix: 'standard', memPerVcpu: 4, sizes: [1, 2, 4, 8, 16, 32, 48, 60] }] },
  { token: 'Z3', arch: 'x86', category: 'storage', core: 0.0425, ram: 0.0057, spotFactor: 0.4, networkGbps: net(1.1, 100),
    shapes: [{ suffix: 'highmem', memPerVcpu: 8, sizes: [8, 14, 22, 44, 88, 176], category: 'storage' }],
    localSsd: { perVcpu: 409, disks: (v) => Math.max(1, Math.round((v * 409) / 3000)), suffix: 'lssd' } },
];

const LOCAL_SSD_GB_MONTH = 0.08;
const CUD_1Y = 0.63;
const CUD_3Y = 0.45;

interface Units {
  core: Record<string, Record<string, { od?: number; spot?: number; c1?: number; c3?: number }>>; // family -> region -> prices
  ram: Record<string, Record<string, { od?: number; spot?: number; c1?: number; c3?: number }>>;
  live: Set<string>; // "family|region" pairs read from the catalog
  pd: Record<string, Partial<Record<string, number>>>; // region -> key -> price
  gcs: Record<string, Partial<Record<string, number>>>;
  net: Record<string, Partial<Record<string, number>>>;
}

function build(units: Units | null, regions: Region[]): Omit<ProviderDataset, 'fetchedAt' | 'mode' | 'sources' | 'notes'> {
  const compute: ComputeSku[] = [];
  for (const r of regions) {
    const mult = REGION_MULT[r.id] ?? 1.1;
    for (const f of FAMILIES) {
      const lc = units?.core[f.token]?.[r.id];
      const lr = units?.ram[f.token]?.[r.id];
      const live = !!(lc?.od && lr?.od);
      const core = { od: lc?.od ?? f.core * mult, spot: lc?.spot ?? f.core * mult * f.spotFactor, c1: lc?.c1 ?? f.core * mult * CUD_1Y, c3: lc?.c3 ?? f.core * mult * CUD_3Y };
      const ram = { od: lr?.od ?? f.ram * mult, spot: lr?.spot ?? f.ram * mult * f.spotFactor, c1: lr?.c1 ?? f.ram * mult * CUD_1Y, c3: lr?.c3 ?? f.ram * mult * CUD_3Y };
      for (const s of f.shapes)
        for (const v of s.sizes) {
          const mem = round(v * s.memPerVcpu, 2);
          const p = (k: 'od' | 'spot' | 'c1' | 'c3') => round(v * core[k] + mem * ram[k]);
          const base: ComputeSku = {
            provider: 'gcp', region: r.id, sku: `${f.token.toLowerCase()}-${s.suffix}-${v}`, family: f.token.toLowerCase(),
            category: s.category ?? f.category, vcpu: v, memoryGiB: mem, localSsdGB: 0, localDisks: 0, localHddGB: 0,
            networkGbps: f.networkGbps(v), arch: f.arch, gpus: 0,
            price: { onDemand: p('od'), spot: p('spot'), commit1y: p('c1'), commit3y: p('c3') },
            estimated: !live,
          };
          compute.push(base);
          if (f.localSsd && (f.token === 'Z3' || v >= 4)) {
            const gb = Math.round(v * f.localSsd.perVcpu);
            const ssdHr = (gb * LOCAL_SSD_GB_MONTH) / 730;
            compute.push({
              ...base,
              sku: f.token === 'Z3' ? base.sku : `${base.sku}-${f.localSsd.suffix}`,
              category: f.token === 'Z3' ? 'storage' : base.category,
              localSsdGB: gb,
              localDisks: f.localSsd.disks(v),
              price: {
                onDemand: round(base.price.onDemand! + ssdHr),
                spot: round(base.price.spot! + ssdHr * 0.5),
                commit1y: base.price.commit1y != null ? round(base.price.commit1y + ssdHr * CUD_1Y) : null,
                commit3y: round(base.price.commit3y! + ssdHr * CUD_3Y),
              },
            });
            if (f.token === 'Z3') compute.splice(compute.indexOf(base), 1);
          }
        }
    }
  }

  const blockStorage: BlockStorage[] = [];
  const objectStorage: ObjectStorage[] = [];
  const network: NetworkPrice[] = [];
  for (const r of regions) {
    const mult = r.id.startsWith('us-') && r.id !== 'us-east4' ? 1 : 1.1;
    const pd = units?.pd[r.id] ?? {};
    const live = (k: string) => pd[k] !== undefined;
    const v = (k: string, d: number) => pd[k] ?? round(d * mult);
    blockStorage.push(
      { provider: 'gcp', region: r.id, id: 'hyperdisk-balanced', name: 'Hyperdisk Balanced', media: 'ssd', scope: 'zonal', perGBMonth: v('hdb-gb', 0.08), perIopsMonth: v('hdb-iops', 0.005), perMiBpsMonth: v('hdb-tp', 0.04), includedIops: 3000, includedMiBps: 140, maxIops: 160000, maxMiBps: 2400, maxSizeGB: 65536, estimated: !live('hdb-gb') },
      { provider: 'gcp', region: r.id, id: 'hyperdisk-throughput', name: 'Hyperdisk Throughput', media: 'hdd', scope: 'zonal', perGBMonth: v('hdt-gb', 0.0125), perIopsMonth: null, perMiBpsMonth: v('hdt-tp', 0.0625), includedIops: 0, includedMiBps: 0, maxIops: 9600, maxMiBps: 600, maxSizeGB: 32768, notes: '10–90 MiB/s per TiB', estimated: !live('hdt-gb') },
      { provider: 'gcp', region: r.id, id: 'pd-balanced', name: 'PD Balanced', media: 'ssd', scope: 'zonal', perGBMonth: v('pdb-gb', 0.1), perIopsMonth: null, perMiBpsMonth: null, includedIops: 3000, includedMiBps: 140, maxIops: 80000, maxMiBps: 1200, maxSizeGB: 65536, notes: '6 IOPS & 0.28 MiB/s per GB', estimated: !live('pdb-gb') },
      { provider: 'gcp', region: r.id, id: 'pd-ssd', name: 'PD SSD', media: 'ssd', scope: 'zonal', perGBMonth: v('pds-gb', 0.17), perIopsMonth: null, perMiBpsMonth: null, includedIops: 6000, includedMiBps: 240, maxIops: 100000, maxMiBps: 1200, maxSizeGB: 65536, notes: '30 IOPS & 0.48 MiB/s per GB', estimated: !live('pds-gb') },
      { provider: 'gcp', region: r.id, id: 'pd-standard', name: 'PD Standard (HDD)', media: 'hdd', scope: 'zonal', perGBMonth: v('pdstd-gb', 0.04), perIopsMonth: null, perMiBpsMonth: null, includedIops: 750, includedMiBps: 120, maxIops: 7500, maxMiBps: 1200, maxSizeGB: 65536, notes: '0.75 IOPS & 0.12 MiB/s per GB', estimated: !live('pdstd-gb') },
    );
    const g = units?.gcs[r.id] ?? {};
    const gv = (k: string, d: number) => g[k] ?? d;
    const eu = r.geo === 'europe' || r.geo === 'asia' ? 1.15 : 1;
    objectStorage.push(
      { provider: 'gcp', region: r.id, id: 'gcs-standard', name: 'Cloud Storage Standard (regional)', tier: 'standard', perGBMonth: gv('std', round(0.02 * eu)), perMillionReads: gv('classB', 0.4), perMillionWrites: gv('classA', 5), retrievalPerGB: 0, estimated: g.std === undefined },
      { provider: 'gcp', region: r.id, id: 'gcs-nearline', name: 'Cloud Storage Nearline', tier: 'infrequent', perGBMonth: gv('nearline', round(0.01 * eu)), perMillionReads: 1, perMillionWrites: 10, retrievalPerGB: 0.01, estimated: g.nearline === undefined },
      { provider: 'gcp', region: r.id, id: 'gcs-archive', name: 'Cloud Storage Archive', tier: 'archive', perGBMonth: gv('archive', 0.0012), perMillionReads: 50, perMillionWrites: 50, retrievalPerGB: 0.05, estimated: g.archive === undefined },
      { provider: 'gcp', region: r.id, id: 'gcs-rapid', name: 'Cloud Storage Rapid (zonal)', tier: 'zonal', perGBMonth: 0.1, perMillionReads: 0.1, perMillionWrites: 1, retrievalPerGB: 0, estimated: true },
    );
    const n = units?.net[r.id] ?? {};
    const apac = CONTINENT[r.id] === 'APAC';
    network.push(
      { provider: 'gcp', region: r.id, kind: 'internet-egress', name: 'Internet egress (Premium tier, to same continent)', tiers: n.egress !== undefined ? [{ fromGB: 0, perGB: n.egress }] : [{ fromGB: 0, perGB: apac ? 0.12 : 0.12 }, { fromGB: 1024, perGB: apac ? 0.11 : 0.11 }, { fromGB: 10240, perGB: apac ? 0.09 : 0.08 }], estimated: n.egress === undefined },
      { provider: 'gcp', region: r.id, kind: 'inter-region', name: 'Inter-region (same continent)', tiers: [{ fromGB: 0, perGB: n.interRegion ?? (apac ? 0.05 : 0.02) }], estimated: n.interRegion === undefined },
      { provider: 'gcp', region: r.id, kind: 'cross-zone', name: 'Cross-zone', tiers: [{ fromGB: 0, perGB: n.crossZone ?? 0.01 }], estimated: n.crossZone === undefined },
    );
  }
  return { provider: 'gcp', regions, compute, blockStorage, objectStorage, network };
}

const COMPUTE_SERVICE = '6F81-5844-456A';
const STORAGE_SERVICE = '95FF-2EF5-5EA1';

async function catalog(service: string, key: string): Promise<any[]> {
  const out: any[] = [];
  let token = '';
  do {
    const page: any = await getJson(`https://cloudbilling.googleapis.com/v1/services/${service}/skus?key=${encodeURIComponent(key)}&currencyCode=USD&pageSize=5000${token ? `&pageToken=${token}` : ''}`);
    out.push(...(page.skus ?? []));
    token = page.nextPageToken ?? '';
  } while (token);
  return out;
}

function unitPrice(sku: any): number | undefined {
  const rates = sku.pricingInfo?.[0]?.pricingExpression?.tieredRates ?? [];
  const r = rates.find((x: any) => Number(x.unitPrice?.units ?? 0) > 0 || Number(x.unitPrice?.nanos ?? 0) > 0) ?? rates[0];
  if (!r) return undefined;
  return Number(r.unitPrice.units ?? 0) + Number(r.unitPrice.nanos ?? 0) / 1e9;
}

async function liveUnits(key: string, regions: Region[]): Promise<Units> {
  const units: Units = { core: {}, ram: {}, live: new Set(), pd: {}, gcs: {}, net: {} };
  const ids = new Set(regions.map((r) => r.id));
  const tokens = FAMILIES.map((f) => f.token).sort((a, b) => b.length - a.length);
  const skus = await catalog(COMPUTE_SERVICE, key);
  log('gcp', `compute catalog: ${skus.length} SKUs`);
  for (const s of skus) {
    const d: string = s.description ?? '';
    const price = unitPrice(s);
    if (price === undefined) continue;
    const inRegions = (s.serviceRegions ?? []).filter((r: string) => ids.has(r));
    if (!inRegions.length) continue;
    // e.g. "N2 Instance Core running in Americas", "Spot Preemptible C4 Instance Ram running in Belgium",
    //      "Commitment v1: N2 Cpu in Americas for 1 Year", "C4A Arm Instance Core running in …"
    const spot = /^Spot Preemptible |^Preemptible /.test(d);
    const commit = d.match(/^Commitment v\d: (\S+)(?: AMD| Arm)? (Cpu|Ram) in .* for (\d) Year/);
    const inst = d.replace(/^Spot Preemptible |^Preemptible /, '').match(/^(\S+)(?: AMD| Arm)? Instance (Core|Ram) running in/);
    const fam = (commit?.[1] ?? inst?.[1])?.toUpperCase();
    if (fam && tokens.includes(fam)) {
      const kind = (commit?.[2] ?? inst?.[2]) === 'Ram' ? 'ram' : 'core';
      const slot = commit ? (commit[3] === '1' ? 'c1' : 'c3') : spot ? 'spot' : 'od';
      for (const r of inRegions) {
        const t = ((units[kind][fam] ??= {})[r] ??= {});
        if (slot === 'od' && s.category?.usageType !== 'OnDemand') continue;
        (t as any)[slot] = price;
        units.live.add(`${fam}|${r}`);
      }
      continue;
    }
    const usd = (k: string, p: number) => inRegions.forEach((r: string) => ((units.pd[r] ??= {})[k] = p));
    const isMonthGB = /GiBy\.mo|GiBy\.h/.test(s.pricingInfo?.[0]?.pricingExpression?.usageUnit ?? '');
    const perMonth = (p: number) => (/GiBy\.h/.test(s.pricingInfo?.[0]?.pricingExpression?.usageUnit ?? '') ? p * 730 : p);
    if (/^Storage PD Capacity/.test(d) && isMonthGB) usd('pdstd-gb', perMonth(price));
    else if (/^Balanced PD Capacity/.test(d) && isMonthGB) usd('pdb-gb', perMonth(price));
    else if (/^SSD backed PD Capacity/.test(d) && isMonthGB) usd('pds-gb', perMonth(price));
    else if (/^Hyperdisk Balanced Capacity/.test(d)) usd('hdb-gb', perMonth(price));
    else if (/^Hyperdisk Balanced IOPS/.test(d)) usd('hdb-iops', perMonth(price));
    else if (/^Hyperdisk Balanced Throughput/.test(d)) usd('hdb-tp', perMonth(price));
    else if (/^Hyperdisk Throughput Capacity/.test(d)) usd('hdt-gb', perMonth(price));
    else if (/^Hyperdisk Throughput Throughput/.test(d)) usd('hdt-tp', perMonth(price));
    else if (/Network Inter Zone (Egress|Data Transfer)/i.test(d)) inRegions.forEach((r: string) => ((units.net[r] ??= {}).crossZone = price));
  }
  try {
    const gcs = await catalog(STORAGE_SERVICE, key);
    log('gcp', `storage catalog: ${gcs.length} SKUs`);
    for (const s of gcs) {
      const d: string = s.description ?? '';
      const price = unitPrice(s);
      if (price === undefined) continue;
      for (const r of (s.serviceRegions ?? []).filter((x: string) => ids.has(x))) {
        const t = (units.gcs[r] ??= {});
        if (/^Standard Storage/.test(d) && !/Multi-region|Dual-region/i.test(d)) t.std = price;
        else if (/^Nearline Storage/.test(d) && !/Multi-region|Dual-region/i.test(d)) t.nearline = price;
        else if (/^Archive Storage/.test(d) && !/Multi-region|Dual-region/i.test(d)) t.archive = price;
      }
    }
  } catch (e: any) {
    log('gcp', 'storage catalog failed:', e.message);
  }
  return units;
}

export async function fetchGcp(regions = GCP_REGIONS): Promise<ProviderDataset> {
  const key = process.env.GCP_API_KEY;
  const units = key ? await liveUnits(key, regions) : null;
  const ds = build(units, regions);
  const liveCount = ds.compute.filter((c) => !c.estimated).length;
  if (!key) log('gcp', 'GCP_API_KEY not set → writing curated snapshot (all rows marked estimated)');
  else log('gcp', `${liveCount}/${ds.compute.length} machine shapes priced from the live catalog`);
  return {
    ...ds,
    fetchedAt: new Date().toISOString(),
    mode: key ? 'live' : 'snapshot',
    sources: [
      { name: 'Cloud Billing Catalog API', url: 'https://cloud.google.com/billing/docs/how-to/get-pricing-information-api' },
      { name: 'Compute Engine pricing', url: 'https://cloud.google.com/compute/vm-instance-pricing' },
    ],
    notes: [
      key ? 'Per-family vCPU and RAM prices from the Billing Catalog, multiplied into machine shapes.' : 'Curated list prices (no GCP_API_KEY). Every row is an estimate; set GCP_API_KEY and run npm run fetch:gcp for live data.',
      'Machine price = vCPU × core rate + GiB × RAM rate (how GCP bills predefined shapes).',
      '1-year / 3-year = resource-based committed use discount (~37% / ~55%).',
      'Spot prices vary per region and change up to once a day.',
    ],
  };
}
