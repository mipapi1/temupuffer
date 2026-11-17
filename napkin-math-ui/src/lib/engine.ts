// The napkin engine. Pure functions: (workload, steps, reference) → results with the math spelled out.
//
// Time for one step moving B bytes in requests of size s, with p threads / requests in flight:
//   throughput bound  B / (throughput × (p if the row scales with threads else 1))
//   latency bound     (B / s) × (latency + RTT) / p
//   time            = max(throughput bound, latency bound)
// Cost = fees (per GB, per request) + rent of the machine running the step for that long
//        (vCPUs × shape $/vCPU/month ÷ 2.6M s), as in the README's "$ / TiB read" table.
import {
  OPS_BY_ID, COSTS, BLOB_REQUESTS, SHAPES, feesOf, hostOf, transformOf, DISK_MB_PER_VCPU, isIoBound,
  type Operation, type CostRow, type Shape, type BlobRequestRow, type Fee,
} from './reference.ts';
import { SECONDS_PER_MONTH, GB, formatBytes, formatDuration, formatRate, formatMoney, sig, formatCount } from './units.ts';

export type PricingTier = 'monthly' | 'commit1y' | 'spot';
export const TIER_LABEL: Record<PricingTier, string> = { monthly: 'On-demand', commit1y: '1-year', spot: 'Spot' };

export interface Workload {
  mode: 'batch' | 'stream';
  /** batch: total bytes processed once */
  totalBytes: number;
  /** stream: requests per second and bytes per request */
  rps: number;
  requestBytes: number;
  tier: PricingTier;
}

export interface OpStep {
  id: string;
  kind: 'op';
  opId: string;
  parallelism: number;
  ioBytes?: number | null; // request size override (default: row's natural size)
  ratio?: number | null; // compression ratio for compress / decompress rows
  latencyNs?: number | null; // per-step override
  throughputBps?: number | null; // per-step override
  rttNs?: number | null; // for "+1 RTT" rows
  hostVcpus?: number | null; // override machine size
  shapeId?: string | null;
  /** Fraction of traffic that reaches this step (e.g. 0.05 for a 95% cache hit ratio). Downstream bytes are unchanged. */
  share?: number | null;
  note?: string;
}
export interface StoreStep {
  id: string;
  kind: 'store';
  costId: string; // storage row from the cost table
  months: number; // retention
  replicas: number;
  note?: string;
}
export type Step = OpStep | StoreStep;

export interface Reference {
  ops: Map<string, Operation>;
  costs: Map<string, CostRow>;
  shapes: Map<string, Shape>;
  blob: Map<string, BlobRequestRow>;
}

export interface Overrides {
  ops?: Record<string, { latencyNs?: number | null; throughputBps?: number | null }>;
  costs?: Record<string, Partial<Pick<CostRow, 'monthly' | 'commit1y' | 'spot'>>>;
  shapes?: Record<string, Partial<Pick<Shape, 'monthlyPerVcpu' | 'commit1yPerVcpu' | 'spotPerVcpu'>>>;
  blob?: Record<string, Partial<Pick<BlobRequestRow, 'regionalPerMillion' | 'zonalPerMillion'>>>;
}

/** Layer overrides (cloud overlay first, then the user's edits) on top of the README numbers. */
export function resolveReference(...layers: (Overrides | undefined)[]): Reference {
  const ops = new Map([...OPS_BY_ID].map(([k, v]) => [k, { ...v }]));
  const costs = new Map(COSTS.map((c) => [c.id, { ...c }]));
  const shapes = new Map(SHAPES.map((s) => [s.id, { ...s }]));
  const blob = new Map(BLOB_REQUESTS.map((b) => [b.id, { ...b }]));
  const apply = <T extends object>(m: Map<string, T>, o?: Record<string, Partial<T>>) => {
    for (const [k, v] of Object.entries(o ?? {})) {
      const cur = m.get(k);
      if (!cur) continue;
      const clean = Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined && x !== null));
      m.set(k, { ...cur, ...clean });
    }
  };
  for (const l of layers) {
    if (!l) continue;
    apply(ops, l.ops as any);
    apply(costs, l.costs as any);
    apply(shapes, l.shapes as any);
    apply(blob, l.blob as any);
  }
  return { ops, costs, shapes, blob };
}

export function costValue(row: CostRow | undefined, tier: PricingTier): number {
  if (!row) return 0;
  return (tier === 'monthly' ? row.monthly : row[tier] ?? row.monthly) ?? 0;
}
export function shapeVcpuMonth(s: Shape | undefined, tier: PricingTier): number {
  if (!s) return 0;
  return tier === 'monthly' ? s.monthlyPerVcpu : tier === 'commit1y' ? s.commit1yPerVcpu || s.monthlyPerVcpu : s.spotPerVcpu || s.monthlyPerVcpu;
}

export interface CostLine {
  label: string;
  usd: number;
  formula: string;
  kind: 'fee' | 'compute' | 'storage';
}

export interface StepResult {
  id: string;
  title: string;
  kind: Step['kind'];
  op?: Operation;
  inBytes: number;
  outBytes: number;
  ioBytes: number;
  /** latency of one request / IO through this step */
  requestLatencyNs: number;
  /** batch: wall time; stream: n/a */
  timeNs: number;
  bound: 'throughput' | 'latency' | 'none';
  effectiveThroughputBps: number | null;
  requests: number;
  /** stream: fraction of one unit of capacity (thread / machine / disk) needed */
  unitsNeeded: number;
  unitLabel: string;
  inFlight: number;
  share: number;
  /** vCPUs rented for this step (batch: while it runs; stream: continuously) */
  vcpus: number;
  costs: CostLine[];
  costUsd: number;
  math: string[];
  warnings: string[];
}

export interface Totals {
  serialNs: number;
  pipelinedNs: number;
  bottleneckId: string | null;
  requestLatencyNs: number;
  costUsd: number;
  feeUsd: number;
  computeUsd: number;
  storageUsd: number;
  outBytes: number;
}

export interface Result {
  steps: StepResult[];
  totals: Totals;
}

function stepRequestSize(op: Operation, step: OpStep, flowBytes: number, w: Workload) {
  if (step.ioBytes) return step.ioBytes;
  if (w.mode === 'stream') return Math.max(1, flowBytes); // one request carries the payload
  return op.blockBytes ?? 1024;
}

export function evaluate(w: Workload, steps: Step[], ref: Reference): Result {
  let flow = w.mode === 'batch' ? w.totalBytes : w.requestBytes; // bytes per job / per request
  const out: StepResult[] = [];
  const month = SECONDS_PER_MONTH;

  for (const step of steps) {
    if (step.kind === 'store') {
      const row = ref.costs.get(step.costId);
      const perGBMonth = costValue(row, w.tier);
      const replicas = Math.max(1, step.replicas || 1);
      const math: string[] = [];
      let usd: number;
      let stored: number;
      if (w.mode === 'batch') {
        stored = flow * replicas;
        usd = (stored / GB) * perGBMonth * step.months;
        math.push(`stored = ${formatBytes(flow)}${replicas > 1 ? ` × ${replicas} replicas` : ''} = ${formatBytes(stored)}`);
        math.push(`cost = ${sig(stored / GB)} GB × ${formatMoney(perGBMonth)}/GB·mo × ${step.months} mo = ${formatMoney(usd)}`);
      } else {
        // steady state: a month of writes, retained for `months`
        const perMonth = flow * w.rps * month;
        stored = perMonth * step.months * replicas;
        usd = (stored / GB) * perGBMonth;
        math.push(`written / month = ${formatBytes(flow)} × ${formatCount(w.rps)}/s × 2.63M s = ${formatBytes(perMonth)}`);
        math.push(`retained = ${formatBytes(perMonth)} × ${step.months} mo${replicas > 1 ? ` × ${replicas}` : ''} = ${formatBytes(stored)}`);
        math.push(`cost / month = ${sig(stored / GB)} GB × ${formatMoney(perGBMonth)}/GB·mo = ${formatMoney(usd)}`);
      }
      out.push({
        id: step.id, title: `Store · ${row?.name ?? step.costId}`, kind: 'store', inBytes: flow, outBytes: flow, ioBytes: flow,
        requestLatencyNs: 0, timeNs: 0, bound: 'none', effectiveThroughputBps: null, requests: 0, unitsNeeded: 0, unitLabel: '',
        inFlight: 0, share: 1, vcpus: 0, costs: [{ label: `${row?.name ?? 'Storage'} at rest`, usd, formula: math.at(-1)!, kind: 'storage' }], costUsd: usd, math, warnings: [],
      });
      continue;
    }

    const base = ref.ops.get(step.opId);
    if (!base) continue;
    const op: Operation = { ...base, latencyNs: step.latencyNs ?? base.latencyNs, throughputBps: step.throughputBps ?? base.throughputBps };
    const p = Math.max(1, step.parallelism || 1);
    const tr = transformOf(op);
    const ratio = Math.max(1, step.ratio ?? tr?.defaultRatio ?? 1);
    const inBytes = flow;
    const outBytes = tr ? (tr.kind === 'compress' ? inBytes / ratio : inBytes * ratio) : inBytes;
    // Throughput of compress/decompress rows is on uncompressed bytes.
    const share = Math.min(1, Math.max(0, step.share ?? 1));
    const rps = w.rps * share;
    const workBytes = (tr ? Math.max(inBytes, outBytes) : inBytes) * (w.mode === 'batch' ? share : 1);
    const io = stepRequestSize(op, step, inBytes, w);
    const rtt = op.plusRtt ? step.rttNs ?? 100e3 : 0;
    const lat = (op.latencyNs ?? 0) + rtt;
    const thrUnit = op.throughputBps; // one unit = one thread for 1-thread CPU rows, else the device/VM
    const thr = thrUnit ? thrUnit * (op.scalesWithThreads ? p : 1) : null;
    const math: string[] = [];
    const warnings: string[] = [];
    const costs: CostLine[] = [];
    const scaleNote = op.scalesWithThreads ? ` × ${p} threads` : '';

    // host (machine rent)
    const host = hostOf(op);
    const shape = ref.shapes.get(step.shapeId ?? host.shapeId);
    const autoVcpus = thr ? Math.max(1, Math.ceil(thr / DISK_MB_PER_VCPU)) : 1;
    const vcpus = step.hostVcpus ?? (host.vcpus === 'parallelism' ? p : host.vcpus === 'auto' ? autoVcpus : host.vcpus);
    const vcpuSecond = shapeVcpuMonth(shape, w.tier) / month;

    let timeNs = 0;
    let bound: StepResult['bound'] = 'none';
    let requests: number;
    let unitsNeeded = 0;
    let inFlight = 0;
    let requestLatencyNs: number;
    let stepVcpus = 0;

    if (w.mode === 'batch') {
      requests = Math.max(1, Math.ceil(workBytes / io));
      const tThr = thr ? (workBytes / thr) * 1e9 : 0;
      const tLat = isIoBound(op) ? (requests * lat) / p : 0;
      timeNs = Math.max(tThr, tLat);
      bound = tThr >= tLat ? 'throughput' : 'latency';
      requestLatencyNs = lat + (thrUnit ? (Math.min(io, workBytes) / thrUnit) * 1e9 : 0);
      if (thr) math.push(`throughput bound = ${formatBytes(workBytes)} ÷ ${formatRate(thrUnit!)}${scaleNote} = ${formatDuration(tThr)}`);
      if (lat && isIoBound(op)) math.push(`latency bound = ${formatCount(requests)} × ${formatBytes(io)} requests × ${formatDuration(lat)}${rtt ? ' (incl. RTT)' : ''} ÷ ${p} in flight = ${formatDuration(tLat)}`);
      math.push(`time = max(…) = ${formatDuration(timeNs)} → ${bound}-bound`);
      if (bound === 'latency' && thr) {
        const need = Math.ceil((requests * lat) / (tThr || 1));
        warnings.push(`Latency-bound: ~${formatCount(need)} requests in flight (or bigger requests) would reach ${formatRate(thr)}.`);
      }
      const seconds = timeNs / 1e9;
      stepVcpus = vcpus;
      if (vcpus > 0 && vcpuSecond > 0) {
        const usd = seconds * vcpus * vcpuSecond;
        costs.push({ label: `${vcpus} vCPU of ${shape?.name ?? 'compute'}`, usd, kind: 'compute', formula: `${formatDuration(timeNs)} × ${vcpus} vCPU × ${formatMoney(shapeVcpuMonth(shape, w.tier))}/vCPU·mo ÷ 2.63M s = ${formatMoney(usd)}` });
      }
      for (const f of feesOf(op)) costs.push(feeLine(f, workBytes, requests, ref, w.tier));
    } else {
      // stream: per request latency, capacity via Little's law
      const s = Math.min(io, workBytes);
      const reqs = Math.max(1, Math.ceil(workBytes / io)); // sub-requests per request
      requests = reqs * rps;
      requestLatencyNs = reqs * lat + (thrUnit ? (workBytes / thrUnit) * 1e9 : 0);
      const demand = workBytes * rps;
      const thrCap = thrUnit ? demand / thrUnit : 0; // units needed for bandwidth
      const latCap = (requests * (op.latencyNs ?? 0)) / 1e9; // busy cores for latency-only rows (RTT isn't CPU time)
      unitsNeeded = op.throughputBps ? thrCap : latCap;
      inFlight = (requests * lat) / 1e9 + (thrUnit ? thrCap : 0);
      math.push(`per request = ${reqs > 1 ? `${reqs} × ` : ''}${formatDuration(lat)}${rtt ? ' (incl. RTT)' : ''}${thrUnit ? ` + ${formatBytes(workBytes)} ÷ ${formatRate(thrUnit)}` : ''} = ${formatDuration(requestLatencyNs)}`);
      if (thrUnit) math.push(`demand = ${formatBytes(workBytes)} × ${formatCount(rps)}/s = ${formatRate(demand)} → ${sig(thrCap)} × ${op.scalesWithThreads ? 'threads' : 'device/VM'} at ${formatRate(thrUnit)}`);
      else math.push(`busy = ${formatCount(requests)}/s × ${formatDuration(lat)} = ${sig(latCap)} cores`);
      math.push(`in flight (Little's law) ≈ ${sig(inFlight)}`);
      if (s < (op.blockBytes ?? 0)) warnings.push(`Request (${formatBytes(s)}) is smaller than this row's natural size (${formatBytes(op.blockBytes!)}); it still costs one full latency.`);
      // monthly cost
      // Thread-scaled and latency-only rows need `unitsNeeded` vCPUs; device/VM-bound rows need that
      // many machines, each the size of the step's host.
      const perMachine = step.hostVcpus ?? (host.vcpus === 'auto' ? Math.max(1, Math.ceil((thrUnit ?? 0) / DISK_MB_PER_VCPU)) : host.vcpus === 'parallelism' ? 1 : host.vcpus);
      const threadLike = op.scalesWithThreads || !thrUnit || host.vcpus === 'parallelism';
      const machineVcpus = threadLike ? unitsNeeded : unitsNeeded * perMachine;
      stepVcpus = host.vcpus === 0 ? 0 : machineVcpus;
      if (!threadLike && perMachine > 0) math.push(`compute = ${sig(unitsNeeded)} × ${perMachine} vCPU host = ${sig(machineVcpus)} vCPU`);
      if (host.vcpus !== 0 && vcpuSecond > 0 && machineVcpus > 0) {
        const usd = machineVcpus * shapeVcpuMonth(shape, w.tier);
        costs.push({ label: `${sig(machineVcpus)} vCPU of ${shape?.name ?? 'compute'}`, usd, kind: 'compute', formula: `${sig(machineVcpus)} vCPU × ${formatMoney(shapeVcpuMonth(shape, w.tier))}/vCPU·mo = ${formatMoney(usd)}/mo` });
      }
      for (const f of feesOf(op)) costs.push(feeLine(f, demand * month, requests * month, ref, w.tier, '/mo'));
    }
    if (share < 1) math.unshift(`applies to ${sig(share * 100)}% of traffic`);
    if (tr) math.unshift(`${tr.kind === 'compress' ? 'out = in ÷' : 'out = in ×'} ${sig(ratio)} = ${formatBytes(outBytes)}`);
    const costUsd = costs.reduce((a, c) => a + c.usd, 0);
    out.push({
      id: step.id, title: op.name, kind: 'op', op, inBytes, outBytes, ioBytes: io, requestLatencyNs, timeNs, bound,
      effectiveThroughputBps: thr, requests, unitsNeeded, unitLabel: op.scalesWithThreads ? 'threads' : op.throughputBps ? 'devices' : 'cores',
      inFlight, share, vcpus: stepVcpus, costs, costUsd, math, warnings,
    });
    flow = outBytes;
  }

  const ops = out.filter((s) => s.kind === 'op');
  const serialNs = ops.reduce((a, s) => a + s.timeNs, 0);
  const bottleneck = w.mode === 'batch'
    ? ops.reduce<StepResult | null>((b, s) => (!b || s.timeNs > b.timeNs ? s : b), null)
    : ops.reduce<StepResult | null>((b, s) => (!b || s.requestLatencyNs > b.requestLatencyNs ? s : b), null);
  const sum = (k: CostLine['kind']) => out.reduce((a, s) => a + s.costs.filter((c) => c.kind === k).reduce((x, c) => x + c.usd, 0), 0);
  return {
    steps: out,
    totals: {
      serialNs,
      pipelinedNs: ops.reduce((a, s) => Math.max(a, s.timeNs), 0),
      bottleneckId: bottleneck?.id ?? null,
      // expected latency: steps that only see part of the traffic contribute in proportion
      requestLatencyNs: ops.reduce((a, s) => a + s.requestLatencyNs * s.share, 0),
      costUsd: out.reduce((a, s) => a + s.costUsd, 0),
      feeUsd: sum('fee'),
      computeUsd: sum('compute'),
      storageUsd: sum('storage'),
      outBytes: flow,
    },
  };
}

function feeLine(f: Fee, bytes: number, requests: number, ref: Reference, tier: PricingTier, suffix = ''): CostLine {
  const gb = bytes / GB;
  switch (f.kind) {
    case 'perGB': {
      const rate = costValue(ref.costs.get(f.costId), tier);
      return { label: f.label, usd: gb * rate, kind: 'fee', formula: `${sig(gb)} GB × ${formatMoney(rate)}/GB = ${formatMoney(gb * rate)}${suffix}` };
    }
    case 'perGBConst':
      return { label: f.label, usd: gb * f.usd, kind: 'fee', formula: `${sig(gb)} GB × ${formatMoney(f.usd)}/GB = ${formatMoney(gb * f.usd)}${suffix}` };
    case 'blobRequest': {
      const row = ref.blob.get(f.row);
      const rate = f.scope === 'zonal' ? row?.zonalPerMillion ?? 0 : row?.regionalPerMillion ?? 0;
      const usd = (requests / 1e6) * rate;
      return { label: f.label, usd, kind: 'fee', formula: `${formatCount(requests)} requests × ${formatMoney(rate)}/M = ${formatMoney(usd)}${suffix}` };
    }
    case 'perMillionConst': {
      const usd = (requests / 1e6) * f.usd;
      return { label: f.label, usd, kind: 'fee', formula: `${formatCount(requests)} requests × ${formatMoney(f.usd)}/M = ${formatMoney(usd)}${suffix}` };
    }
  }
}

let seq = 0;
export const newId = () => `s${Date.now().toString(36)}${(seq++).toString(36)}`;
