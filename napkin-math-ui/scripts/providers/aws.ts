// AWS: official Price List bulk offer files (no credentials needed).
//   EC2 (instances + EBS):  .../offers/v1.0/aws/AmazonEC2/current/<region>/index.csv   (~300 MB, streamed)
//   S3:                     .../offers/v1.0/aws/AmazonS3/current/<region>/index.json
//   Data transfer:          .../offers/v1.0/aws/AWSDataTransfer/current/<region>/index.json
//   Spot:                   https://website.spot.ec2.aws.a2z.com/spot.js (feed behind aws.amazon.com/ec2/spot/pricing)
import type { BlockStorage, ComputeCategory, ComputeSku, NetworkPrice, ObjectStorage, ProviderDataset, Region } from '../../src/lib/schema.ts';
import { getJson, getText, log, parseCsvLine, round, streamLines } from '../lib/http.ts';

const BASE = 'https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws';

export const AWS_REGIONS: Region[] = [
  { provider: 'aws', id: 'us-east-1', name: 'US East (N. Virginia)', geo: 'us-east' },
  { provider: 'aws', id: 'us-east-2', name: 'US East (Ohio)', geo: 'us-central' },
  { provider: 'aws', id: 'us-west-2', name: 'US West (Oregon)', geo: 'us-west' },
  { provider: 'aws', id: 'eu-west-1', name: 'EU (Ireland)', geo: 'europe' },
  { provider: 'aws', id: 'ap-southeast-1', name: 'Asia Pacific (Singapore)', geo: 'asia' },
];

// Published per-volume limits (docs.aws.amazon.com/ebs/latest/userguide/ebs-volume-types.html)
const EBS_LIMITS: Record<string, Omit<BlockStorage, 'provider' | 'region' | 'perGBMonth' | 'perIopsMonth' | 'perMiBpsMonth'>> = {
  gp3: { id: 'gp3', name: 'EBS gp3', media: 'ssd', scope: 'zonal', includedIops: 3000, includedMiBps: 125, maxIops: 80000, maxMiBps: 2000, maxSizeGB: 65536 },
  gp2: { id: 'gp2', name: 'EBS gp2', media: 'ssd', scope: 'zonal', includedIops: 3000, includedMiBps: 250, maxIops: 16000, maxMiBps: 250, maxSizeGB: 16384, notes: '3 IOPS/GB baseline' },
  io2: { id: 'io2', name: 'EBS io2 Block Express', media: 'ssd', scope: 'zonal', includedIops: 0, includedMiBps: 4000, maxIops: 256000, maxMiBps: 4000, maxSizeGB: 65536, notes: 'IOPS tiered; first tier price shown' },
  st1: { id: 'st1', name: 'EBS st1 (throughput HDD)', media: 'hdd', scope: 'zonal', includedIops: 500, includedMiBps: 500, maxIops: 500, maxMiBps: 500, maxSizeGB: 16384, notes: 'Throughput scales 40 MiB/s per TiB baseline' },
  sc1: { id: 'sc1', name: 'EBS sc1 (cold HDD)', media: 'hdd', scope: 'zonal', includedIops: 250, includedMiBps: 250, maxIops: 250, maxMiBps: 250, maxSizeGB: 16384, notes: 'Throughput scales 12 MiB/s per TiB baseline' },
};

function category(family: string, type: string): ComputeCategory {
  if (/^t\d/.test(type)) return 'burstable';
  if (/General/i.test(family)) return 'general';
  if (/Compute/i.test(family)) return 'compute';
  if (/Memory/i.test(family)) return 'memory';
  if (/Storage/i.test(family)) return 'storage';
  if (/GPU|FPGA|Machine Learning|Accelerat/i.test(family)) return 'accelerated';
  return 'other';
}

function parseStorage(s: string) {
  // "1 x 200 NVMe SSD", "2 x 1900 NVMe SSD", "8 x 2000 HDD", "EBS only", "1 x 3800 GB NVMe SSD"
  const m = s.match(/(\d+)\s*x\s*([\d,.]+)/i);
  if (!m) return { ssd: 0, hdd: 0, disks: 0 };
  const n = Number(m[1]);
  const size = Number(m[2].replace(/,/g, ''));
  return /HDD/i.test(s) ? { ssd: 0, hdd: n * size, disks: n } : { ssd: n * size, hdd: 0, disks: n };
}

function parseGbps(s: string): number | null {
  const m = s.match(/([\d.]+)\s*Gigabit/i);
  if (m) return Number(m[1]);
  const mb = s.match(/([\d.]+)\s*(Megabit|Mbps)/i);
  if (mb) return Number(mb[1]) / 1000;
  if (/Moderate/i.test(s)) return 0.75;
  if (/Low/i.test(s)) return 0.3;
  if (/High/i.test(s)) return 10;
  return null;
}

async function ec2(region: Region) {
  const url = `${BASE}/AmazonEC2/current/${region.id}/index.csv`;
  let header: string[] | null = null;
  const ix: Record<string, number> = {};
  const skus = new Map<string, ComputeSku>(); // SKU code -> instance
  const prices = new Map<string, { od?: number; r1?: number; r3?: number }>();
  const ebs: Record<string, { gb?: number; iops?: number; mibps?: number }> = {};
  let n = 0;
  for await (const line of streamLines(url)) {
    if (!header) {
      if (line.startsWith('"SKU"')) {
        header = parseCsvLine(line);
        header.forEach((h, i) => (ix[h] = i));
      }
      continue;
    }
    n++;
    // fast pre-filter before full parse
    if (!line.includes('Compute Instance') && !line.includes('Storage') && !line.includes('System Operation') && !line.includes('Provisioned Throughput')) continue;
    const r = parseCsvLine(line);
    const col = (k: string) => r[ix[k]] ?? '';
    const fam = col('Product Family');
    const termType = col('TermType');
    const price = Number(col('PricePerUnit'));

    if (fam === 'Compute Instance') {
      if (col('Tenancy') !== 'Shared' || col('Operating System') !== 'Linux' || col('Pre Installed S/W') !== 'NA') continue;
      if (col('CapacityStatus') !== 'Used' || col('License Model') !== 'No License required') continue;
      if (col('Current Generation') !== 'Yes' || col('MarketOption') !== 'OnDemand') continue;
      const sku = col('SKU');
      if (!skus.has(sku)) {
        const type = col('Instance Type');
        const st = parseStorage(col('Storage'));
        const proc = col('Physical Processor');
        skus.set(sku, {
          provider: 'aws',
          region: region.id,
          sku: type,
          family: type.split('.')[0],
          category: category(col('Instance Family'), type),
          vcpu: Number(col('vCPU')),
          memoryGiB: Number(col('Memory').replace(/[^\d.]/g, '')),
          localSsdGB: st.ssd,
          localHddGB: st.hdd,
          localDisks: st.disks,
          networkGbps: parseGbps(col('Network Performance')),
          arch: /Graviton|AWS/i.test(proc) ? 'arm' : 'x86',
          gpus: Number(col('GPU')) || 0,
          price: { onDemand: null, spot: null, commit1y: null, commit3y: null },
        });
      }
      const p = prices.get(sku) ?? {};
      if (termType === 'OnDemand' && col('Unit') === 'Hrs') p.od = price;
      if (termType === 'Reserved' && col('PurchaseOption') === 'No Upfront' && col('OfferingClass') === 'standard' && col('Unit') === 'Hrs') {
        if (col('LeaseContractLength') === '1yr') p.r1 = price;
        if (col('LeaseContractLength') === '3yr') p.r3 = price;
      }
      prices.set(sku, p);
    } else if (termType === 'OnDemand') {
      const vol = col('Volume API Name');
      if (!EBS_LIMITS[vol]) continue;
      const unit = col('Unit');
      const e = (ebs[vol] ??= {});
      if (fam === 'Storage' && /GB-Mo/i.test(unit)) e.gb = price;
      else if (fam === 'System Operation' && /IOPS-Mo/i.test(unit) && (e.iops === undefined || Number(col('StartingRange')) === 0)) e.iops = price;
      else if (fam === 'Provisioned Throughput') e.mibps = /GiBps/i.test(unit) ? price / 1024 : price;
    }
  }
  const compute: ComputeSku[] = [];
  for (const [code, s] of skus) {
    const p = prices.get(code)!;
    if (!p.od) continue;
    s.price = { onDemand: p.od, spot: null, commit1y: p.r1 ?? null, commit3y: p.r3 ?? null };
    compute.push(s);
  }
  const blockStorage: BlockStorage[] = Object.entries(ebs)
    .filter(([, e]) => e.gb !== undefined)
    .map(([vol, e]) => ({
      ...EBS_LIMITS[vol],
      provider: 'aws',
      region: region.id,
      perGBMonth: e.gb!,
      perIopsMonth: e.iops ?? null,
      perMiBpsMonth: e.mibps ?? null,
    }));
  log('aws', `${region.id}: ${n.toLocaleString()} rows → ${compute.length} instance types, ${blockStorage.length} EBS types`);
  return { compute, blockStorage };
}

function priceDims(offer: any, sku: string) {
  const out: { begin: number; end: number; unit: string; usd: number }[] = [];
  for (const t of Object.values<any>(offer.terms.OnDemand[sku] ?? {}))
    for (const d of Object.values<any>(t.priceDimensions))
      out.push({ begin: Number(d.beginRange), end: d.endRange === 'Inf' ? Infinity : Number(d.endRange), unit: d.unit, usd: Number(d.pricePerUnit.USD) });
  return out.sort((a, b) => a.begin - b.begin);
}

async function s3(region: Region): Promise<ObjectStorage[]> {
  const offer = await getJson(`${BASE}/AmazonS3/current/${region.id}/index.json`);
  const byUsage = new Map<string, number>();
  for (const [sku, p] of Object.entries<any>(offer.products)) {
    const u: string = p.attributes.usagetype ?? '';
    const base = u.replace(/^[A-Z]{2,4}\d?-/, ''); // strip region prefix like USW2-
    const dims = priceDims(offer, sku);
    if (dims.length) byUsage.set(base, dims[0].usd);
  }
  const g = (k: string) => byUsage.get(k) ?? NaN;
  const mk = (id: string, name: string, tier: ObjectStorage['tier'], stor: string, rd: string, wr: string, retr = 0): ObjectStorage => ({
    provider: 'aws',
    region: region.id,
    id,
    name,
    tier,
    perGBMonth: g(stor),
    perMillionReads: round(g(rd) * 1e6, 4),
    perMillionWrites: round(g(wr) * 1e6, 4),
    retrievalPerGB: retr,
  });
  const list = [
    mk('s3-standard', 'S3 Standard', 'standard', 'TimedStorage-ByteHrs', 'Requests-Tier2', 'Requests-Tier1'),
    mk('s3-ia', 'S3 Standard-IA', 'infrequent', 'TimedStorage-SIA-ByteHrs', 'Requests-SIA-Tier2', 'Requests-SIA-Tier1', byUsage.get('Retrieval-SIA') ?? 0.01),
    mk('s3-glacier-ir', 'S3 Glacier Instant Retrieval', 'archive', 'TimedStorage-GIR-ByteHrs', 'Requests-GIR-Tier2', 'Requests-GIR-Tier1', byUsage.get('Retrieval-GIR') ?? 0.03),
    mk('s3-express', 'S3 Express One Zone', 'zonal', 'TimedStorage-XZ-ByteHrs', 'Requests-XZ-Tier2', 'Requests-XZ-Tier1', byUsage.get('Retrieval-XZ') ?? 0),
  ];
  return list.filter((o) => Number.isFinite(o.perGBMonth));
}

async function transfer(region: Region): Promise<NetworkPrice[]> {
  const offer = await getJson(`${BASE}/AWSDataTransfer/current/${region.id}/index.json`);
  const out: NetworkPrice[] = [];
  let interRegion: number[] = [];
  for (const [sku, p] of Object.entries<any>(offer.products)) {
    const a = p.attributes;
    if (a.fromRegionCode !== region.id) continue;
    const dims = priceDims(offer, sku);
    if (!dims.length) continue;
    if (a.transferType === 'AWS Outbound' && a.toLocation === 'External') {
      out.push({ provider: 'aws', region: region.id, kind: 'internet-egress', name: 'Internet egress', tiers: dims.map((d) => ({ fromGB: d.begin, perGB: d.usd })) });
    } else if (a.transferType === 'InterRegion Outbound') {
      interRegion.push(dims[0].usd);
    } else if (a.transferType === 'IntraRegion' && dims[0].usd > 0) {
      out.push({ provider: 'aws', region: region.id, kind: 'cross-zone', name: 'Cross-AZ (each direction)', tiers: [{ fromGB: 0, perGB: dims[0].usd }] });
    }
  }
  // Many destinations (incl. free Local Zones); the typical region-to-region price is the most common non-zero one.
  const paid = interRegion.filter((x) => x > 0);
  if (paid.length) {
    const freq = new Map<number, number>();
    for (const x of paid) freq.set(x, (freq.get(x) ?? 0) + 1);
    const typical = [...freq].sort((a, b) => b[1] - a[1])[0][0];
    out.push({ provider: 'aws', region: region.id, kind: 'inter-region', name: `Inter-region (typical; $${Math.min(...paid)}–$${Math.max(...paid)}/GB by destination)`, tiers: [{ fromGB: 0, perGB: typical }] });
  }
  // AWS bills cross-AZ as $0.01 out + $0.01 in; keep both directions visible.
  return out;
}

async function spot(): Promise<Map<string, number>> {
  const txt = await getText('https://website.spot.ec2.aws.a2z.com/spot.js');
  const json = JSON.parse(txt.replace(/^\s*callback\(/, '').replace(/\);?\s*$/, ''));
  const m = new Map<string, number>();
  for (const r of json.config.regions)
    for (const it of r.instanceTypes)
      for (const s of it.sizes) {
        const v = s.valueColumns.find((c: any) => c.name === 'linux')?.prices?.USD;
        if (v && !Number.isNaN(Number(v))) m.set(`${r.region}|${s.size}`, Number(v));
      }
  return m;
}

export async function fetchAws(regions = AWS_REGIONS): Promise<ProviderDataset> {
  log('aws', `fetching ${regions.length} regions (EC2 offer files are ~300 MB each, streamed)…`);
  const spotP = spot().catch((e) => (log('aws', 'spot feed failed:', e.message), new Map<string, number>()));
  const per = await Promise.all(regions.map(async (r) => ({ r, e: await ec2(r), s: await s3(r), t: await transfer(r) })));
  const spots = await spotP;
  const compute = per.flatMap((p) => p.e.compute);
  for (const c of compute) c.price.spot = spots.get(`${c.region}|${c.sku}`) ?? null;
  return {
    provider: 'aws',
    fetchedAt: new Date().toISOString(),
    mode: 'live',
    sources: [
      { name: 'AWS Price List bulk API (EC2, S3, Data Transfer)', url: `${BASE}/index.json` },
      { name: 'EC2 Spot price feed', url: 'https://aws.amazon.com/ec2/spot/pricing/' },
    ],
    notes: [
      'Linux, shared tenancy, current generation only.',
      '1-year / 3-year = Standard Reserved Instance, no upfront (effective hourly).',
      'Spot prices are a point-in-time snapshot and change continuously.',
      'Cross-AZ transfer is billed in each direction.',
    ],
    regions,
    compute,
    blockStorage: per.flatMap((p) => p.e.blockStorage),
    objectStorage: per.flatMap((p) => p.s),
    network: per.flatMap((p) => p.t),
  };
}
