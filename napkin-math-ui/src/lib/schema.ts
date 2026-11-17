// Shared data schema. Used by the fetch scripts (Node, type-stripped) and the UI.
// Keep this file free of runtime code other than constants so Node can strip it.

export type Provider = 'aws' | 'azure' | 'gcp';
export type Geo = 'us-east' | 'us-central' | 'us-west' | 'europe' | 'asia';

export const PROVIDERS: Provider[] = ['aws', 'azure', 'gcp'];
export const PROVIDER_LABEL: Record<Provider, string> = { aws: 'AWS', azure: 'Azure', gcp: 'Google Cloud' };
export const GEO_LABEL: Record<Geo, string> = {
  'us-east': 'US East',
  'us-central': 'US Central',
  'us-west': 'US West',
  europe: 'Europe',
  asia: 'Asia (Singapore)',
};

export interface Region {
  provider: Provider;
  id: string; // provider region code, e.g. us-east-1, eastus, us-central1
  name: string; // human name
  geo: Geo;
}

/** All prices are USD per hour unless noted. null = not offered / unknown. */
export interface ComputePrice {
  onDemand: number | null;
  spot: number | null;
  commit1y: number | null; // 1-year, no upfront (AWS RI standard / Azure reservation / GCP CUD)
  commit3y: number | null;
}

export type ComputeCategory = 'general' | 'compute' | 'memory' | 'storage' | 'accelerated' | 'burstable' | 'other';

export interface ComputeSku {
  provider: Provider;
  region: string;
  sku: string;
  family: string;
  category: ComputeCategory;
  vcpu: number;
  memoryGiB: number;
  localSsdGB: number;
  localDisks: number;
  localHddGB: number;
  networkGbps: number | null;
  arch: 'x86' | 'arm';
  gpus: number;
  gpuModel?: string;
  price: ComputePrice;
  /** Fields that were inferred rather than read from the provider (e.g. Azure memory from series ratio). */
  derived?: string[];
  estimated?: boolean;
}

export interface BlockStorage {
  provider: Provider;
  region: string;
  id: string; // gp3, pd-balanced, premium-ssd-v2
  name: string;
  media: 'ssd' | 'hdd';
  scope: 'zonal' | 'regional';
  perGBMonth: number;
  perIopsMonth: number | null; // above included
  perMiBpsMonth: number | null; // above included
  includedIops: number;
  includedMiBps: number;
  maxIops: number;
  maxMiBps: number;
  maxSizeGB: number;
  notes?: string;
  estimated?: boolean;
}

export interface ObjectStorage {
  provider: Provider;
  region: string;
  id: string;
  name: string;
  tier: 'standard' | 'infrequent' | 'archive' | 'zonal';
  perGBMonth: number;
  perMillionReads: number;
  perMillionWrites: number;
  retrievalPerGB: number;
  estimated?: boolean;
}

export interface PriceTier {
  fromGB: number;
  perGB: number;
}

export type NetworkKind = 'internet-egress' | 'inter-region' | 'cross-zone';

export interface NetworkPrice {
  provider: Provider;
  region: string;
  kind: NetworkKind;
  name: string;
  tiers: PriceTier[];
  estimated?: boolean;
}

export interface ProviderDataset {
  provider: Provider;
  fetchedAt: string;
  /** "live" = pulled from official APIs, "snapshot" = curated list prices shipped with the repo. */
  mode: 'live' | 'snapshot';
  sources: { name: string; url: string }[];
  notes: string[];
  regions: Region[];
  compute: ComputeSku[];
  blockStorage: BlockStorage[];
  objectStorage: ObjectStorage[];
  network: NetworkPrice[];
}

export const HOURS_PER_MONTH = 730;
