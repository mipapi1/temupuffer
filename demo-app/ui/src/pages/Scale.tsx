import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { LoaderCircle, Play } from "lucide-react";
import { api, fmtInt, fmtMs, type Bench, type Config, type Level, type Mode } from "../api";
import DataCard from "../components/DataCard";
import ExplainCard from "../components/ExplainCard";
import StackedArea from "../components/StackedArea";
import { Button, Card, Chip, ErrorNote, Segmented, Stat } from "../components/ui";

const fmtBytes = (b?: number) =>
  b == null ? "–" : b >= 2 ** 30 ? `${(b / 2 ** 30).toFixed(2)} GiB` : `${(b / 2 ** 20).toFixed(0)} MiB`;

export default function ScalePage({ config, backend }: { config?: Config; backend?: string }) {
  const stats = useQuery({ queryKey: ["stats"], queryFn: api.stats, refetchInterval: 2000 });
  const s = stats.data;
  const m = s?.metadata;
  const unindexed = m?.index?.unindexed_rows ?? 0;
  const rows = m?.approx_row_count ?? 0;
  const [table, setTable] = useState(false);
  const points = (s?.history ?? []).map((h) => ({ t: h.t, indexed: Math.max(0, h.rows - h.unindexed), unindexed: h.unindexed }));

  return (
    <div className="space-y-5">
      <div>
        <h1>Scale</h1>
        <p className="mt-1 max-w-2xl text-muted">
          Namespace <span className="font-mono text-[13px] text-text">{s?.namespace ?? config?.namespace}</span> on{" "}
          <span className="font-medium text-text">{s?.backend ?? backend}</span>. Watch an ingest land, the indexer catch up, and what a load test does to latency.
        </p>
      </div>
      <ErrorNote error={stats.error ?? m?.error} />
      <ExplainCard />
      <DataCard stats={s} backend={s?.backend ?? backend} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Documents" value={fmtInt(rows)} sub={m?.approx_logical_bytes != null ? fmtBytes(m.approx_logical_bytes) + " logical" : undefined} />
        <Stat
          label="Not indexed yet"
          value={<span className={unindexed > 0 ? "text-amber" : ""}>{fmtInt(unindexed)}</span>}
          sub={unindexed > 0 ? "scanned by brute force on every strong query" : "everything is in the index"}
        />
        <Stat
          label="Index"
          value={<Chip tone={m?.index?.status === "up-to-date" ? "teal" : "amber"}>{m?.index?.status ?? "–"}</Chip>}
          sub={m?.temupuffer ? `${m.temupuffer.segments} segments · manifest v${m.temupuffer.manifest_version}` : undefined}
        />
        <Stat
          label="Ingest"
          value={s?.ingest ? `${fmtInt(s.ingest.rows_per_s)}/s` : "–"}
          sub={s?.ingest ? (s.ingest.done ? "finished" : "rows acknowledged per second") : "no load job has reported yet"}
        />
      </div>

      <Card className="p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2>Rows over time</h2>
          <div className="flex items-center gap-4 text-[12.5px] text-muted">
            <span className="flex items-center gap-1.5">
              <i className="h-2.5 w-2.5 rounded-sm" style={{ background: "var(--chart-teal)" }} /> indexed
            </span>
            <span className="flex items-center gap-1.5">
              <i className="h-2.5 w-2.5 rounded-sm" style={{ background: "var(--chart-amber)" }} /> not indexed
            </span>
            <button onClick={() => setTable(!table)} className="text-accent hover:underline">
              {table ? "Chart" : "Table"}
            </button>
          </div>
        </div>
        <div className="mt-3">
          {table ? (
            <div className="max-h-[220px] overflow-auto">
              <table className="tabular w-full text-[13px]">
                <thead className="text-left text-muted">
                  <tr>
                    <th className="py-1 font-medium">Time</th>
                    <th className="py-1 text-right font-medium">Indexed</th>
                    <th className="py-1 text-right font-medium">Not indexed</th>
                  </tr>
                </thead>
                <tbody>
                  {points.slice(-60).reverse().map((p) => (
                    <tr key={p.t} className="border-t border-line">
                      <td className="py-1">{new Date(p.t * 1000).toLocaleTimeString()}</td>
                      <td className="py-1 text-right">{fmtInt(p.indexed)}</td>
                      <td className="py-1 text-right">{fmtInt(p.unindexed)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <StackedArea data={points} />
          )}
        </div>
        <p className="mt-2 text-[12.5px] text-muted">
          Writes land in the WAL first (amber) and are searchable right away by brute force. The indexer folds them into segments (teal).
          When too much piles up, writes get a 429 until it catches up.
        </p>
      </Card>

      <BenchCard bench={s?.bench} backend={backend} />

      {s && s.latency.length > 0 && (
        <Card className="p-4">
          <h2>Your searches</h2>
          <p className="mt-0.5 text-[12.5px] text-muted">Latency of searches from the Search page (last 1,000 per mode), including embedding.</p>
          <LatencyTable rows={s.latency.map((l) => ({ name: `${l.mode} · ${l.backend}`, ...l }))} />
        </Card>
      )}
    </div>
  );
}

function LatencyTable({ rows }: { rows: { name: string; count: number; p50: number | null; p90: number | null; p99: number | null }[] }) {
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="tabular w-full min-w-[420px] text-[13px]">
        <thead className="text-left text-muted">
          <tr>
            <th className="py-1.5 font-medium" />
            <th className="py-1.5 text-right font-medium">Queries</th>
            <th className="py-1.5 text-right font-medium">p50</th>
            <th className="py-1.5 text-right font-medium">p90</th>
            <th className="py-1.5 text-right font-medium">p99</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name} className="border-t border-line">
              <td className="py-1.5 font-medium">{r.name}</td>
              <td className="py-1.5 text-right">{fmtInt(r.count)}</td>
              <td className="py-1.5 text-right">{fmtMs(r.p50)}</td>
              <td className="py-1.5 text-right">{fmtMs(r.p90)}</td>
              <td className="py-1.5 text-right">{fmtMs(r.p99)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BenchCard({ bench, backend }: { bench?: Bench; backend?: string }) {
  const [seconds, setSeconds] = useState(30);
  const [concurrency, setConcurrency] = useState(4);
  const [level, setLevel] = useState<Level>("strong");
  const modes: Mode[] = ["hybrid", "keyword", "vector"];
  const start = useMutation({ mutationFn: () => api.startBench({ seconds, concurrency, modes, consistency: level, backend }) });
  const running = bench?.state === "running" || bench?.state === "measuring recall";
  const r = bench?.result;

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2>Load test</h2>
        {bench && bench.state !== "idle" && (
          <span className="text-[12.5px] text-muted">
            {running
              ? bench.state === "measuring recall"
                ? "measuring recall…"
                : `${bench.elapsed ?? 0}s of ${bench.seconds}s · ${fmtInt(bench.done_queries)} queries`
              : bench.state === "done"
                ? `last run: ${bench.concurrency} clients, ${bench.consistency}, ${bench.backend}`
                : bench.state}
          </span>
        )}
      </div>
      <p className="mt-0.5 text-[12.5px] text-muted">
        Concurrent clients send a mix of hybrid, word and meaning searches. Times exclude embedding (queries are embedded up front), so they measure the database.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2.5 text-[13px]">
        <label className="flex items-center gap-1.5 text-muted">
          Seconds
          <select id="bench-seconds" value={seconds} onChange={(e) => setSeconds(+e.target.value)} className="rounded-lg border border-line bg-surface px-2 py-1 text-text">
            {[15, 30, 60, 120].map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-muted">
          Clients
          <select id="bench-clients" value={concurrency} onChange={(e) => setConcurrency(+e.target.value)} className="rounded-lg border border-line bg-surface px-2 py-1 text-text">
            {[1, 2, 4, 8, 16].map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </label>
        <Segmented label="Consistency" value={level} onChange={setLevel} options={[{ value: "strong", label: "Strong" }, { value: "eventual", label: "Eventual" }]} />
        <Button variant="primary" onClick={() => start.mutate()} disabled={running || start.isPending}>
          {running ? <LoaderCircle size={14} className="animate-spin" /> : <Play size={14} />}
          {running ? "Running" : "Run load test"}
        </Button>
      </div>
      <ErrorNote error={start.error ?? (bench?.state === "error" ? bench.error : null)} />
      {r && (
        <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_260px]">
          <LatencyTable
            rows={Object.entries(r.by_mode).map(([mode, v]) => ({ name: mode, count: v.client.count, p50: v.client.p50, p90: v.client.p90, p99: v.client.p99 }))}
          />
          <div className="space-y-2 text-[13px]">
            <div className="flex justify-between">
              <span className="text-muted">Throughput</span>
              <span className="tabular font-medium">{r.qps} queries/s</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted">Errors</span>
              <span className={`tabular font-medium ${r.errors ? "text-red" : ""}`}>{r.errors}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted">Cache</span>
              <span className="tabular">
                {Object.entries(r.cache_temperature)
                  .map(([k, v]) => `${k} ${fmtInt(v)}`)
                  .join(" · ")}
              </span>
            </div>
            {r.recall && (
              <>
                <div className="flex justify-between border-t border-line pt-2">
                  <span className="text-muted">Recall@10 (ANN vs exact)</span>
                  <span className="tabular font-medium">{r.recall.recall_at_10 != null ? r.recall.recall_at_10.toFixed(2) : "–"}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted">ANN vs exact, p50</span>
                  <span className="tabular">
                    {fmtMs(r.recall.ann_server_ms_p50)} vs {fmtMs(r.recall.exact_server_ms_p50)}
                  </span>
                </div>
                <p className="text-[12px] text-faint">
                  Recall: how many of the true 10 nearest papers the fast index found. turbopuffer targets 90-100%.
                </p>
              </>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
