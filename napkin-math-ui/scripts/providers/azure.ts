// Azure: Retail Prices API (https://learn.microsoft.com/rest/api/cost-management/retail-prices/azure-retail-prices)
// Public, unauthenticated, paginated, rate-limited. The API carries prices but not VM specs, so vCPU
// comes from the SKU name and memory / local disk from the published per-series ratios (marked `derived`).
import type { BlockStorage, ComputeSku, NetworkPrice, ObjectStorage, ProviderDataset, Region } from '../../src/lib/schema.ts';
import { getJson, log, round } from '../lib/http.ts';

const API = 'https://prices.azure.com/api/retail/prices';

export const AZURE_REGIONS: Region[] = [
  { provider: 'azure', id: 'eastus', name: 'East US (Virginia)', geo: 'us-east' },
  { provider: 'azure', id: 'centralus', name: 'Central US (Iowa)', geo: 'us-central' },
  { provider: 'azure', id: 'westus2', name: 'West US 2 (Washington)', geo: 'us-west' },
  { provider: 'azure', id: 'westeurope', name: 'West Europe (Netherlands)', geo: 'europe' },
  { provider: 'azure', id: 'southeastasia', name: 'Southeast Asia (Singapore)', geo: 'asia' },
];

async function query(filter: string): Promise<any[]> {
  let url: string | null = `${API}?api-version=2023-01-01-preview&$filter=${encodeURIComponent(filter)}`;
  const items: any[] = [];
  while (url) {
    const page: any = await getJson(url, 8);
    items.push(...page.Items);
    url = page.NextPageLink;
    await new Promise((r) => setTimeout(r, 250)); // be gentle; the API throttles bursts
  }
  return items;
}

interface SeriesSpec {
  memPerVcpu: number;
  category: ComputeSku['category'];
  localSsdPerVcpu?: number; // NVMe for L-series, temp disk for 'd' variants
}

/** Parse Standard_<Family><vCPU><features>_v<gen>, e.g. Standard_D8ds_v5, Standard_E16pds_v6, Standard_L8s_v3. */
export function azureSpec(arm: string): (Omit<ComputeSku, 'provider' | 'region' | 'price'>) | null {
  const m = arm.match(/^Standard_([A-Z]+)(\d+)([a-z]*)_v(\d+)$/);
  if (!m) return null;
  const [, fam, n, feat, genS] = m;
  const vcpu = Number(n);
  const gen = Number(genS);
  if (gen < 5 && !(fam === 'F' && gen === 2) && !(fam === 'L' && gen === 3)) return null;
  let spec: SeriesSpec;
  if (fam === 'D') spec = { memPerVcpu: feat.includes('l') ? 2 : 4, category: 'general' };
  else if (fam === 'E') spec = { memPerVcpu: 8, category: 'memory' };
  else if (fam === 'F') spec = { memPerVcpu: gen === 2 ? 2 : feat.includes('l') ? 2 : feat.includes('m') ? 8 : 4, category: 'compute' };
  else if (fam === 'L') spec = { memPerVcpu: 8, category: 'storage', localSsdPerVcpu: 240 };
  else return null;
  const hasTemp = feat.includes('d');
  const localSsdGB = spec.localSsdPerVcpu ? vcpu * spec.localSsdPerVcpu : hasTemp ? Math.round(vcpu * (gen >= 6 ? 55 : 37.5)) : 0;
  return {
    sku: arm.replace('Standard_', ''),
    family: `${fam}${feat}v${gen}`,
    category: spec.category,
    vcpu,
    memoryGiB: vcpu * spec.memPerVcpu,
    localSsdGB,
    localDisks: spec.localSsdPerVcpu ? Math.max(1, vcpu / 8) : hasTemp ? 1 : 0,
    localHddGB: 0,
    networkGbps: null,
    arch: feat.includes('p') ? 'arm' : 'x86',
    gpus: 0,
    derived: ['memoryGiB', 'localSsdGB'],
  };
}

async function vms(region: Region): Promise<ComputeSku[]> {
  const base = `serviceName eq 'Virtual Machines' and armRegionName eq '${region.id}'`;
  const [cons, resv] = await Promise.all([query(`${base} and priceType eq 'Consumption'`), query(`${base} and priceType eq 'Reservation'`)]);
  const map = new Map<string, ComputeSku>();
  const get = (arm: string) => {
    if (map.has(arm)) return map.get(arm)!;
    const s = azureSpec(arm);
    if (!s) return null;
    const sku: ComputeSku = { ...s, provider: 'azure', region: region.id, price: { onDemand: null, spot: null, commit1y: null, commit3y: null } };
    map.set(arm, sku);
    return sku;
  };
  for (const i of cons) {
    if (/Windows/i.test(i.productName) || /Low Priority/i.test(i.skuName) || i.unitOfMeasure !== '1 Hour') continue;
    const s = get(i.armSkuName);
    if (!s) continue;
    if (/Spot$/.test(i.skuName)) s.price.spot = i.retailPrice;
    else s.price.onDemand = i.retailPrice;
  }
  for (const i of resv) {
    const s = map.get(i.armSkuName);
    if (!s) continue;
    // Reservation retailPrice is the total for the term.
    if (i.reservationTerm === '1 Year') s.price.commit1y = round(i.retailPrice / 8760);
    if (i.reservationTerm === '3 Years') s.price.commit3y = round(i.retailPrice / 26280);
  }
  return [...map.values()].filter((s) => s.price.onDemand);
}

async function storage(region: Region): Promise<{ block: BlockStorage[]; object: ObjectStorage[] }> {
  const items = await query(
    `serviceName eq 'Storage' and armRegionName eq '${region.id}' and (productName eq 'Azure Premium SSD v2' or productName eq 'Standard HDD Managed Disks' or productName eq 'Premium SSD Managed Disks' or productName eq 'Standard SSD Managed Disks' or productName eq 'General Block Blob v2')`,
  );
  const c = items.filter((i) => i.type === 'Consumption');
  const find = (pred: (i: any) => boolean) => c.find(pred)?.retailPrice as number | undefined;
  // Tiered meters list a free included tier first; the billable rate is the highest tier price.
  const findMax = (pred: (i: any) => boolean) => {
    const xs = c.filter(pred).map((i) => i.retailPrice as number);
    return xs.length ? Math.max(...xs) : undefined;
  };
  const block: BlockStorage[] = [];
  const v2gb = find((i) => i.productName === 'Azure Premium SSD v2' && i.skuName === 'Premium LRS' && /Provisioned Capacity/.test(i.meterName));
  const v2iops = findMax((i) => i.productName === 'Azure Premium SSD v2' && i.skuName === 'Premium LRS' && /Provisioned IOPS/.test(i.meterName));
  const v2tp = findMax((i) => i.productName === 'Azure Premium SSD v2' && i.skuName === 'Premium LRS' && /Provisioned Throughput/.test(i.meterName));
  if (v2gb !== undefined)
    block.push({
      provider: 'azure', region: region.id, id: 'premium-ssd-v2', name: 'Premium SSD v2', media: 'ssd', scope: 'zonal',
      perGBMonth: round(v2gb * 730), perIopsMonth: v2iops != null ? round(v2iops * 730) : null, perMiBpsMonth: v2tp != null ? round(v2tp * 730) : null,
      includedIops: 3000, includedMiBps: 125, maxIops: 80000, maxMiBps: 1200, maxSizeGB: 65536,
    });
  // Fixed-size tiers: use the 1 TiB disk (P30/E30/S30) to derive $/GB.
  const tier = (product: string, sku: string, name: string, id: string, media: 'ssd' | 'hdd', iops: number, mibps: number, notes: string) => {
    const p = find((i) => i.productName === product && i.skuName === sku && / Disk$/.test(i.meterName));
    if (p !== undefined)
      block.push({ provider: 'azure', region: region.id, id, name, media, scope: 'zonal', perGBMonth: round(p / 1024), perIopsMonth: null, perMiBpsMonth: null, includedIops: iops, includedMiBps: mibps, maxIops: iops, maxMiBps: mibps, maxSizeGB: 1024, notes });
  };
  tier('Premium SSD Managed Disks', 'P30 LRS', 'Premium SSD (P30, 1 TiB)', 'premium-ssd-p30', 'ssd', 5000, 200, 'Fixed tiers; performance grows with size');
  tier('Standard SSD Managed Disks', 'E30 LRS', 'Standard SSD (E30, 1 TiB)', 'standard-ssd-e30', 'ssd', 500, 100, 'Plus per-transaction fees');
  tier('Standard HDD Managed Disks', 'S30 LRS', 'Standard HDD (S30, 1 TiB)', 'standard-hdd-s30', 'hdd', 500, 60, 'Plus per-transaction fees');

  const blob = (t: 'Hot' | 'Cool' | 'Cold' | 'Archive', tierId: ObjectStorage['tier']): ObjectStorage | null => {
    const stored = find((i) => i.productName === 'General Block Blob v2' && i.skuName === `${t} LRS` && i.meterName === `${t} LRS Data Stored` && i.tierMinimumUnits === 0);
    if (stored === undefined) return null;
    const reads = find((i) => i.productName === 'General Block Blob v2' && i.skuName === `${t} LRS` && /Read Operations$/.test(i.meterName) && !/Priority/.test(i.meterName)) ?? 0;
    const writes = find((i) => i.productName === 'General Block Blob v2' && i.skuName === `${t} LRS` && /Write Operations$/.test(i.meterName)) ?? 0;
    const retr = find((i) => i.productName === 'General Block Blob v2' && i.skuName === `${t} LRS` && /Data Retrieval$/.test(i.meterName)) ?? 0;
    return { provider: 'azure', region: region.id, id: `blob-${t.toLowerCase()}-lrs`, name: `Blob ${t} (LRS)`, tier: tierId, perGBMonth: stored, perMillionReads: round(reads * 100), perMillionWrites: round(writes * 100), retrievalPerGB: retr };
  };
  const object = [blob('Hot', 'standard'), blob('Cool', 'infrequent'), blob('Cold', 'infrequent'), blob('Archive', 'archive')].filter(Boolean) as ObjectStorage[];
  return { block, object };
}

async function bandwidth(region: Region): Promise<NetworkPrice[]> {
  const items = (await query(`serviceName eq 'Bandwidth' and armRegionName eq '${region.id}'`)).filter((i) => i.type === 'Consumption');
  const mgn = items.filter((i) => /^Rtn Preference: MGN/.test(i.productName) || i.productName === 'Bandwidth');
  const out: NetworkPrice[] = [];
  const egress = mgn.filter((i) => i.meterName === 'Standard Data Transfer Out').sort((a, b) => a.tierMinimumUnits - b.tierMinimumUnits);
  if (egress.length) out.push({ provider: 'azure', region: region.id, kind: 'internet-egress', name: 'Internet egress (Microsoft network)', tiers: egress.map((i) => ({ fromGB: i.tierMinimumUnits, perGB: i.retailPrice })) });
  const ir = mgn.find((i) => /Inter-Region Data Transfer/.test(i.meterName));
  if (ir) out.push({ provider: 'azure', region: region.id, kind: 'inter-region', name: 'Inter-region', tiers: [{ fromGB: 0, perGB: ir.retailPrice }] });
  const az = mgn.find((i) => /Inter-Availability Zone Data Transfer Out/.test(i.meterName));
  if (az) out.push({ provider: 'azure', region: region.id, kind: 'cross-zone', name: 'Cross-zone', tiers: [{ fromGB: 0, perGB: az.retailPrice }] });
  return out;
}

export async function fetchAzure(regions = AZURE_REGIONS): Promise<ProviderDataset> {
  const compute: ComputeSku[] = [];
  const blockStorage: BlockStorage[] = [];
  const objectStorage: ObjectStorage[] = [];
  const network: NetworkPrice[] = [];
  // Sequential per region: the Retail API rate-limits parallel bursts.
  for (const r of regions) {
    const v = await vms(r);
    const s = await storage(r);
    const b = await bandwidth(r);
    compute.push(...v);
    blockStorage.push(...s.block);
    objectStorage.push(...s.object);
    network.push(...b);
    log('azure', `${r.id}: ${v.length} VM sizes, ${s.block.length} disk types, ${s.object.length} blob tiers, ${b.length} network prices`);
  }
  return {
    provider: 'azure',
    fetchedAt: new Date().toISOString(),
    mode: 'live',
    sources: [{ name: 'Azure Retail Prices API', url: API }],
    notes: [
      'Linux pay-as-you-go; D/E/F/L series v5+ (plus Fsv2, Lsv3).',
      'vCPU is parsed from the SKU name; memory and local disk are derived from per-series ratios (not in the API).',
      '1-year / 3-year = reserved instance total ÷ term hours.',
      'Premium SSD/Standard HDD $/GB derived from the 1 TiB tier (P30/S30).',
    ],
    regions,
    compute,
    blockStorage,
    objectStorage,
    network,
  };
}
