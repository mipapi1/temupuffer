// "My homelab": the hardware temupuffer runs on, a RAM-fit calculator for temupuffer-search's
// query pods, and napkin estimates next to what was actually measured.
// Specs read from the nodes 2026-11-17 (lscpu, /proc/meminfo, lsblk). Measured numbers are from
// my temupuffer runs (durability tests and the 500k / 1M arXiv loads).
import { useMemo, useState } from 'react';
import { evaluate, resolveReference, type Step, type Workload } from '../lib/engine.ts';
import { setState, useAppState } from '../lib/store.ts';
import { formatDuration, GiB, KiB, MiB } from '../lib/units.ts';

const NODES = [
  { name: 'k3s-prod01', cpu: 'Intel N100', runs: 'indexer (pinned here)' },
  { name: 'k3s-prod02', cpu: 'Intel N150', runs: 'query-1 (shard arxiv-b)' },
  { name: 'k3s-prod03', cpu: 'Intel N150', runs: 'query-0 (shard arxiv-a), SILO' },
];
const VM = { vcpus: 4, ramGiB: 9.64, disk: '100 GB virtio' };

// The cold-start estimate: one shard's segment files (arxiv-a, 952 MB) read from object storage
// by the query pod's cache, 32 reads in flight (the cache's IO pool), 8 MiB at a time.
export const COLD_SHARD_BYTES = 952 * 1e6;
export const COLD_SHARD_STEPS: Step[] = [
  { id: 'cold-read', kind: 'op', opId: 'blob-storage-regional-read-128-kib', parallelism: 32, ioBytes: 8 * MiB },
];

type Verdict = 'fits' | 'tight' | 'oom';

export function HomelabView() {
  const { overrides } = useAppState();
  const [papers, setPapers] = useState(500_000);
  const [kibPerRow, setKibPerRow] = useState(10);
  const [shards, setShards] = useState(2);
  const [limitGiB, setLimitGiB] = useState(5);

  const perShardRows = papers / Math.max(1, shards);
  const perShardGiB = (perShardRows * kibPerRow * KiB) / GiB;
  const use = perShardGiB / limitGiB;
  // Above ~90% of the limit there's no room left for the caches and per-query memory: the 1M run's pods
  // (~95% by this math) were OOMKilled while loading.
  const verdict: Verdict = use > 0.9 ? 'oom' : use > 0.7 ? 'tight' : 'fits';
  const maxRows = Math.floor((limitGiB * GiB) / (kibPerRow * KiB));

  const cold = useMemo(() => {
    const w: Workload = { mode: 'batch', totalBytes: COLD_SHARD_BYTES, rps: 1000, requestBytes: 4 * KiB, tier: 'monthly' };
    return evaluate(w, COLD_SHARD_STEPS, resolveReference(overrides)).totals.serialNs;
  }, [overrides]);

  const openPreset = () => setState((s) => ({ ...s, view: 'scenarios', activeId: 'temupuffer-cold-shard' }));

  return (
    <div className="page">
      <div className="page-head">
        <h1>My homelab</h1>
        <p>
          The three mini PCs temupuffer and temupuffer-search run on, and the napkin math for what they can hold.
          The Measured column comes from real runs on them; the Napkin column is computed live from the reference numbers.
        </p>
      </div>

      <section className="hl-card">
        <h3 className="hl-title">Hardware</h3>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr><th>Node</th><th>Mini PC CPU</th><th className="r">vCPUs</th><th className="r">RAM</th><th>Disk</th><th>Runs</th></tr>
            </thead>
            <tbody>
              {NODES.map((n) => (
                <tr key={n.name}>
                  <td className="num">{n.name}</td>
                  <td>{n.cpu}</td>
                  <td className="r num">{VM.vcpus}</td>
                  <td className="r num">{VM.ramGiB} GiB</td>
                  <td>{VM.disk}</td>
                  <td className="muted">{n.runs}</td>
                </tr>
              ))}
              <tr className="best">
                <td><b>Total</b></td>
                <td className="muted">3 mini PCs</td>
                <td className="r num"><b>{VM.vcpus * 3}</b></td>
                <td className="r num"><b>{(VM.ramGiB * 3).toFixed(1)} GiB</b></td>
                <td />
                <td className="muted">shared with Forgejo, Longhorn, monitoring…</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="note" style={{ marginTop: 10 }}>
          Each mini PC runs one K3s VM (QEMU). Storage volumes come from Longhorn; temupuffer's only durable state is
          the SILO (S3) bucket.
        </p>
      </section>

      <section className="hl-card">
        <h3 className="hl-title">Will it fit in RAM?</h3>
        <p className="note">
          temupuffer's query pods load every segment of the shard they serve into memory. Measured: about <b>10 KiB per
          paper</b> resident (vector + abstract + index). Try 1M papers to see why that run was OOMKilled.
        </p>
        <div className="toolbar">
          <label className="field">Papers<input className="qty wide" type="number" min={1000} step={50000} value={papers} onChange={(e) => setPapers(Math.max(0, +e.target.value))} /></label>
          <label className="field">KiB / paper<input className="qty narrow" type="number" min={1} step={1} value={kibPerRow} onChange={(e) => setKibPerRow(Math.max(0.1, +e.target.value))} /></label>
          <label className="field">Shards<input className="qty narrow" type="number" min={1} max={12} value={shards} onChange={(e) => setShards(Math.max(1, Math.round(+e.target.value)))} /></label>
          <label className="field">Pod limit<input className="qty narrow" type="number" min={1} step={0.5} value={limitGiB} onChange={(e) => setLimitGiB(Math.max(0.5, +e.target.value))} />GiB</label>
          <span className="seg">
            <button aria-pressed={papers === 500_000} onClick={() => setPapers(500_000)}>500k</button>
            <button aria-pressed={papers === 1_000_000} onClick={() => setPapers(1_000_000)}>1M</button>
          </span>
        </div>

        <div className={`hl-verdict ${verdict}`}>
          <div className="hl-verdict-main">
            <span className="hl-big num">{perShardGiB.toFixed(2)} GiB</span>
            <span>per query pod, limit {limitGiB} GiB</span>
          </div>
          <div className="hl-meter"><i style={{ width: `${Math.min(100, use * 100)}%` }} /></div>
          <div className="hl-verdict-text">
            {verdict === 'fits' && <>Fits, with {(limitGiB - perShardGiB).toFixed(2)} GiB to spare.</>}
            {verdict === 'tight' && <>Tight: {(use * 100).toFixed(0)}% of the limit, with little room left for caches and queries.</>}
            {verdict === 'oom' && use <= 1 && <>OOMKilled: {(use * 100).toFixed(0)}% of the limit before caches and query work. This is what happened at 1M.</>}
            {verdict === 'oom' && use > 1 && <>Doesn't fit: {(use * 100).toFixed(0)}% of the limit. The pod gets OOMKilled while loading.</>}
          </div>
        </div>
        <div className="math">
          <div className="line">{papers.toLocaleString()} papers ÷ {shards} shards = {Math.round(perShardRows).toLocaleString()} papers per pod</div>
          <div className="line">{Math.round(perShardRows).toLocaleString()} × {kibPerRow} KiB = {perShardGiB.toFixed(2)} GiB resident</div>
          <div className="line">at {kibPerRow} KiB each, a {limitGiB} GiB pod holds at most ~{maxRows.toLocaleString()} papers</div>
          <div className="line">each node has {VM.ramGiB} GiB in total, so a pod can't simply grow past ~{(VM.ramGiB / 2).toFixed(1)} GiB without starving everything else</div>
          <div className="why">
            What happened: the 1M run put ~530k papers on each shard. Both query pods were OOMKilled at the 5 GiB limit, so
            temupuffer-search went back to 500k. Getting to 1M needs more shards (more nodes), or an engine that keeps only
            vectors and the index in RAM and reads documents from the disk cache.
          </div>
        </div>
      </section>

      <section className="hl-card">
        <h3 className="hl-title">Napkin estimate vs measured</h3>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>What</th><th className="r">Napkin</th><th className="r">Measured</th><th>Why they differ</th></tr></thead>
            <tbody>
              <tr>
                <td>Cold start: load one 952 MB shard from object storage</td>
                <td className="r num t-time">{formatDuration(cold)}</td>
                <td className="r num">21 s</td>
                <td className="muted">
                  Napkin only counts the reads. The rest is CPU: decoding segments into memory on 4 small cores.{' '}
                  <button className="reset" style={{ color: 'var(--accent)' }} onClick={openPreset}>Open the estimate →</button>
                </td>
              </tr>
              <tr>
                <td>Warm search (everything cached in memory)</td>
                <td className="r num faint">n/a</td>
                <td className="r num">60–390 ms</td>
                <td className="muted">Keyword fastest, hybrid slowest (it runs two searches and fuses them). Single queries, 500k papers.</td>
              </tr>
              <tr>
                <td>Cold keyword query, same app, different store</td>
                <td className="r num faint">n/a</td>
                <td className="r num">~130 ms SILO · ~630 ms Azure</td>
                <td className="muted">In-cluster SILO is on the LAN; Azure Blob is a trip over the internet from home. Warm: ~7 ms vs ~50 ms.</td>
              </tr>
              <tr>
                <td>Embedding papers (all-MiniLM-L6-v2)</td>
                <td className="r num faint">n/a</td>
                <td className="r num">45–110 papers/s per machine</td>
                <td className="muted">The slowest part of ingest, so papers are embedded once and loaded many times.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
