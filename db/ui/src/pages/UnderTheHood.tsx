// Under the hood: the write -> WAL -> indexer -> query flow, live.
//
// Everything on this page is read from the cluster every second:
//   /debug/namespaces/{ns}/wal   WAL entries, cursor, manifest
//   /debug/queue                 queue.json
//   /debug/cluster               every query node's and indexer's counters and events

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowRight, Plus, Zap } from "lucide-react";
import { ago, api, fmtBytes, fmtNum, type Cluster, type Metadata, type NodeEvent, type QueueDoc, type WalState } from "../api";
import { Button, ErrorNote, Panel, Pill, Stat } from "../components/ui";
import WalStrip from "../components/WalStrip";

export default function UnderTheHood() {
  const list = useQuery({ queryKey: ["namespaces"], queryFn: () => api<{ namespaces: { id: string }[] }>("/v1/namespaces?page_size=1000"), refetchInterval: 5000 });
  const [ns, setNs] = useState("");
  useEffect(() => {
    if (!ns && list.data?.namespaces.length) setNs(list.data.namespaces[0].id);
  }, [list.data, ns]);

  const wal = useQuery({ enabled: !!ns, queryKey: ["wal", ns, 160], queryFn: () => api<WalState>(`/debug/namespaces/${ns}/wal?limit=160`), refetchInterval: 1000 });
  const queue = useQuery({ queryKey: ["queue"], queryFn: () => api<QueueDoc>("/debug/queue"), refetchInterval: 1000 });
  const cluster = useQuery({ queryKey: ["cluster"], queryFn: () => api<Cluster>("/debug/cluster"), refetchInterval: 1500 });
  const meta = useQuery({ enabled: !!ns, queryKey: ["metadata", ns], queryFn: () => api<Metadata>(`/v1/namespaces/${ns}/metadata`) });

  const nodes = cluster.data?.query_nodes ?? [];
  const indexers = cluster.data?.indexers ?? [];
  const w = wal.data;
  const writers = nodes.map((n) => n.writers?.[ns]).filter(Boolean);
  const lastBatch = Math.max(0, ...writers.map((x) => x!.last_batch_requests));
  const lostRaces = writers.reduce((a, x) => a + x!.lost_races, 0);
  const busy = indexers.find((i) => i.current?.ns === ns)?.current;
  const job = queue.data?.jobs[ns];

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <h1>Under the hood</h1>
          <p className="mt-1 max-w-2xl text-muted">
            A write is durable once it's in the WAL. The indexer folds the WAL into segments later, and until it does,
            every query scans the unindexed part by brute force.
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <select aria-label="Namespace" className="h-8 rounded-md border border-line bg-surface px-2 font-mono text-[13px]" value={ns} onChange={(e) => setNs(e.target.value)}>
            {list.data?.namespaces.map((n) => <option key={n.id}>{n.id}</option>)}
          </select>
          <PracticeButton onCreated={setNs} taken={list.data?.namespaces.map((n) => n.id) ?? []} />
          {meta.data && <BurstButton ns={ns} meta={meta.data} />}
        </div>
      </div>
      <ErrorNote error={wal.error ?? cluster.error} />

      {/* The pipeline, one stage per box, each with its live number. */}
      <ol className="mt-6 grid gap-2 md:grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr]">
        <Stage n="Query node" title="Group commit" detail={lastBatch > 1 ? `Last entry held ${lastBatch} requests` : "Writes queue for up to 1 s, then share one entry"}>
          <Stat label="writes / lost CAS races" value={<>{fmtNum(nodes.reduce((a, n) => a + (n.writes ?? 0), 0))} <span className="text-faint">/ {lostRaces}</span></>} />
        </Stage>
        <Arrow />
        <Stage n="Object storage" title="WAL" detail="PUT wal/<seq> with If-None-Match: *">
          <Stat label="unindexed rows" tone={w?.unindexed_rows ? "amber" : undefined} value={fmtNum(w?.unindexed_rows)} hint={fmtBytes(w?.unindexed_bytes)} />
        </Stage>
        <Arrow />
        <Stage n="Indexer" title={busy ? `Busy: ${busy.stage}` : job ? "Job queued" : "Idle"}
          detail={busy ? `WAL ${busy.from_seq} to ${busy.to_seq}, ${fmtNum(busy.rows)} rows` : "Claims jobs in queue.json with If-Match"}>
          <Stat label="index cursor / WAL head" value={<>{w?.cursor ?? "…"} <span className="text-faint">/ {w?.head ?? "…"}</span></>} />
        </Stage>
        <Arrow />
        <Stage n="Object storage" title="Segments" detail="manifest.json swapped with If-Match">
          <Stat label="live segments" tone="teal" value={w?.manifest.segments.length ?? "…"} hint={`manifest v${w?.manifest.version ?? 0}`} />
        </Stage>
      </ol>

      <Panel className="mt-6" title="Write-ahead log" aside={w ? `${w.entries.length} most recent entries of ns/${ns}/wal/` : undefined}>
        {w && <WalStrip entries={w.entries} cursor={w.cursor} />}
      </Panel>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Panel title="Indexer queue" aside={queue.data ? `queue.json v${queue.data.version}` : undefined}>
          <p className="mb-3 text-[13px] text-muted">One JSON file on object storage, changed only by compare-and-swap. One job per namespace with unindexed WAL entries.</p>
          {queue.data && Object.keys(queue.data.jobs).length === 0 && <p className="text-[13px] text-faint">No jobs. Every namespace is up to date.</p>}
          <ul className="space-y-2">
            {queue.data && Object.entries(queue.data.jobs).map(([name, j]) => (
              <li key={name} className="flex flex-wrap items-center gap-2 rounded-md border border-line px-3 py-2 text-[13px]">
                <span className="font-mono">{name}</span>
                {j.claimed_by ? <Pill tone="amber">claimed by {j.claimed_by}</Pill> : <Pill tone="neutral">waiting</Pill>}
                {j.rerun && <Pill tone="accent">rerun</Pill>}
                <span className="ml-auto text-[12px] text-faint">{j.heartbeat ? `heartbeat ${ago(j.heartbeat)}` : `queued ${ago(j.enqueued_at)}`}</span>
              </li>
            ))}
          </ul>
          <div className="mt-4 space-y-1 text-[12.5px] text-muted">
            {indexers.length === 0 && <p>No indexers configured for the cluster view (set INDEXER_URLS or INDEXER_DNS).</p>}
            {indexers.map((i) => (
              <p key={i.url}>
                <span className="font-mono text-text">{i.ok ? i.node : i.url}</span>{" "}
                {i.ok ? <>{fmtNum(i.passes)} passes, {i.compactions} compactions{i.last_pass ? `, last pass ${i.last_pass.ms} ms for ${fmtNum(i.last_pass.rows)} rows` : ""}</> : <span className="text-red">unreachable</span>}
              </p>
            ))}
          </div>
        </Panel>

        <Panel title="Query node caches" aside="memory, disk, then object storage">
          <div className="space-y-4">
            {nodes.map((n) => <NodeCache key={n.url} n={n} ns={ns} />)}
          </div>
        </Panel>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_1.2fr]">
        <Panel title="Object storage requests" aside="every node, last 10 s">
          <RequestTable cluster={cluster.data} />
        </Panel>
        <Panel title="Activity" aside="newest first">
          <Activity cluster={cluster.data} ns={ns} />
        </Panel>
      </div>
    </div>
  );
}

function Stage({ n, title, detail, children }: { n: string; title: string; detail: string; children: React.ReactNode }) {
  return (
    <li className="min-w-0 rounded-lg border border-line bg-surface p-3">
      <div className="text-[12px] text-faint">{n}</div>
      <div className="font-medium">{title}</div>
      <div className="mb-3 min-h-[36px] text-[12px] text-muted">{detail}</div>
      {children}
    </li>
  );
}

function Arrow() {
  return (
    <li aria-hidden className="flex items-center justify-center text-faint">
      <ArrowRight className="hidden md:block" size={16} />
      <ArrowDown className="md:hidden" size={16} />
    </li>
  );
}

function NodeCache({ n, ns }: { n: Cluster["query_nodes"][number]; ns: string }) {
  if (!n.ok) return <p className="text-[13px] text-red">{n.url}: unreachable</p>;
  const c = n.cache;
  const total = c.memory_hits + c.disk_hits + c.misses || 1;
  const view = n.views?.[ns];
  return (
    <div>
      <div className="flex items-baseline justify-between text-[13px]">
        <span className="font-mono">{n.node}</span>
        <span className="text-[12px] text-faint">{view ? `view of ${ns} is ${view.age_s}s old` : `hasn't served ${ns} yet`}</span>
      </div>
      <div className="mt-1.5 flex h-2 overflow-hidden rounded-full bg-surface-2" aria-label="cache hits by tier">
        <div className="bg-teal" style={{ width: `${(100 * c.memory_hits) / total}%` }} />
        <div className="bg-amber" style={{ width: `${(100 * c.disk_hits) / total}%` }} />
        <div className="bg-red" style={{ width: `${(100 * c.misses) / total}%` }} />
      </div>
      <div className="mt-1 flex flex-wrap gap-x-4 text-[12px] text-muted">
        <span><b className="font-medium text-teal">{fmtNum(c.memory_hits)}</b> memory hits</span>
        <span><b className="font-medium text-amber">{fmtNum(c.disk_hits)}</b> disk hits</span>
        <span><b className="font-medium text-red">{fmtNum(c.misses)}</b> misses</span>
        <span>{fmtBytes(c.memory_bytes)} in memory, {fmtBytes(c.disk_bytes)} on disk</span>
      </div>
    </div>
  );
}

function RequestTable({ cluster }: { cluster?: Cluster }) {
  if (!cluster) return null;
  const sources = [...cluster.query_nodes, ...cluster.indexers].filter((s) => s.ok);
  const ops = Array.from(new Set(sources.flatMap((s) => Object.keys(s.store_totals ?? {})))).sort();
  const label: Record<string, string> = {
    GET: "GET (read an object)", GET_304: "GET → 304 (unchanged)", GET_404: "GET → 404", LIST: "LIST (find WAL entries)",
    PUT: "PUT", PUT_IF_NONE_MATCH: "PUT If-None-Match", PUT_IF_NONE_MATCH_412: "  ↳ lost (412)", PUT_IF_MATCH: "PUT If-Match (CAS)",
    PUT_IF_MATCH_412: "  ↳ lost (412)", DELETE: "DELETE", HEAD: "HEAD",
  };
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[12.5px]">
        <thead className="text-muted">
          <tr>
            <th className="py-1 pr-3 text-left font-medium">Request</th>
            {sources.map((s) => <th key={s.url} className="whitespace-nowrap py-1 pl-3 text-right font-mono font-normal">{s.node}</th>)}
          </tr>
        </thead>
        <tbody className="tabular">
          {ops.map((op) => (
            <tr key={op} className="border-t border-line">
              <td className="whitespace-pre py-1 pr-3">{label[op] ?? op}</td>
              {sources.map((s) => (
                <td key={s.url} className="py-1 pl-3 text-right">
                  {fmtNum(s.store_totals[op] ?? 0)}
                  {(s.store_rate_10s[op] ?? 0) > 0 && <span className="ml-1 text-accent">+{s.store_rate_10s[op]}</span>}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-[12px] text-faint">Lifetime totals per process. The +n is the last 10 seconds.</p>
    </div>
  );
}

const EVENT_TEXT: Record<string, (e: NodeEvent) => string> = {
  wal_commit: (e) => `committed WAL entry ${e.seq}: ${fmtNum(e.rows as number)} rows from ${e.requests} request${e.requests === 1 ? "" : "s"}`,
  query: (e) => `${e.level} query, ${e.ms} ms, ${e.temperature}, ${e.round_trips} round trips, ${fmtNum(e.exhaustive as number)} rows brute-forced`,
  indexed: (e) => `indexed ${e.entries} entries (${fmtNum(e.rows as number)} rows) in ${e.ms} ms, cursor now ${e.cursor}`,
  compacted: (e) => `compacted ${e.segments} segments into one (${fmtNum(e.rows as number)} rows) in ${e.ms} ms`,
  backpressure_429: (e) => `rejected a write with 429: ${fmtNum(e.unindexed_rows as number)} rows unindexed`,
  manifest_race_lost: () => "lost the manifest CAS race, discarded its segment",
  cache_warmed: (e) => `warmed the cache in ${e.ms} ms`,
  sweep_enqueued: () => "sweep found unindexed entries and queued a job",
  namespace_deleted: (e) => `deleted the namespace (${e.objects} objects)`,
};

function Activity({ cluster, ns }: { cluster?: Cluster; ns: string }) {
  if (!cluster) return null;
  const events = [...cluster.query_nodes, ...cluster.indexers]
    .flatMap((s) => (s.ok ? s.events : []))
    .filter((e) => e.ns === ns)
    .sort((a, b) => b.t - a.t)
    .slice(0, 14);
  if (!events.length) return <p className="text-[13px] text-faint">Nothing has happened to {ns} yet.</p>;
  const tone = (k: string) => (k === "indexed" || k === "compacted" ? "bg-teal" : k === "wal_commit" ? "bg-amber" : k === "backpressure_429" ? "bg-red" : "bg-accent");
  return (
    <ul className="space-y-1.5 text-[12.5px]">
      {events.map((e, i) => (
        <li key={`${e.t}-${i}`} className="flex gap-2">
          <i className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${tone(e.kind)}`} />
          <span className="min-w-0 flex-1"><span className="font-mono text-muted">{e.node}</span> {(EVENT_TEXT[e.kind] ?? ((x) => x.kind))(e)}</span>
          <span className="shrink-0 text-faint">{ago(e.t)}</span>
        </li>
      ))}
    </ul>
  );
}

// Creates a small practice namespace ("walkthrough", or "walkthrough-2"… if taken) with 1,000 rows
// shaped like scripts/load.py's: 64-dim vectors, a full-text title, a category. That way the walkthrough
// never has to write test rows into a namespace that holds real data.
const PRACTICE_WORDS = "puffer fish ocean harbor quantum vector search index object storage cache latency river mountain forest".split(" ");
const PRACTICE_CATEGORIES = ["news", "sport", "tech", "science", "travel", "food"];

function PracticeButton({ onCreated, taken }: { onCreated: (ns: string) => void; taken: string[] }) {
  const qc = useQueryClient();
  const create = useMutation({
    mutationFn: async () => {
      let name = "walkthrough";
      for (let i = 2; taken.includes(name); i++) name = `walkthrough-${i}`;
      const rows = Array.from({ length: 1000 }, (_, i) => {
        const c = i % 40;
        const words = [0, 1, 2].map((j) => PRACTICE_WORDS[(c * 3 + j) % PRACTICE_WORDS.length]);
        for (let j = 0; j < 5; j++) words.push(PRACTICE_WORDS[Math.floor(Math.random() * PRACTICE_WORDS.length)]);
        return {
          id: i,
          vector: Array.from({ length: 64 }, (_, d) => +(Math.sin(c * 7 + d) * 3 + (Math.random() - 0.5) * 1.2).toFixed(4)),
          title: words.join(" "),
          category: PRACTICE_CATEGORIES[c % PRACTICE_CATEGORIES.length],
        };
      });
      await api(`/v2/namespaces/${name}`, {
        body: { upsert_rows: rows, distance_metric: "cosine_distance", schema: { title: { type: "string", full_text_search: true } } },
      });
      return name;
    },
    onSuccess: (name) => {
      qc.invalidateQueries({ queryKey: ["namespaces"] });
      onCreated(name);
    },
  });
  return (
    <>
      <Button kind="quiet" onClick={() => create.mutate()} disabled={create.isPending} title="Create a small namespace with 1,000 practice rows">
        <Plus size={14} />{create.isPending ? "Creating…" : "New practice namespace"}
      </Button>
      {create.error && <span className="text-[12px] text-red">{(create.error as Error).message.slice(0, 60)}</span>}
    </>
  );
}

// Writes 5,000 synthetic rows in 5 concurrent requests, matching the namespace's
// vector dims, so you can watch group commit, the backlog and the indexer.
// Asks first when the namespace already holds a lot of rows (likely real data, e.g. temupuffer-search's).
function BurstButton({ ns, meta }: { ns: string; meta: Metadata }) {
  const burst = useMutation({
    mutationFn: async () => {
      const base = Math.floor(Date.now() / 1000) * 10_000;
      const words = "puffer fish ocean harbor quantum vector search index storage cache latency river".split(" ");
      const textAttr = Object.entries(meta.schema).find(([, s]) => s.full_text_search)?.[0];
      const req = (k: number) => {
        const rows = Array.from({ length: 1000 }, (_, i) => {
          const row: Record<string, unknown> = { id: base + k * 1000 + i };
          if (meta.dims) row.vector = Array.from({ length: meta.dims }, () => +(Math.random() * 2 - 1).toFixed(3));
          if (textAttr) row[textAttr] = Array.from({ length: 6 }, () => words[Math.floor(Math.random() * words.length)]).join(" ");
          return row;
        });
        return api(`/v2/namespaces/${ns}`, { body: { upsert_rows: rows, ...(meta.distance_metric ? { distance_metric: meta.distance_metric } : {}) } });
      };
      return Promise.all([0, 1, 2, 3, 4].map(req));
    },
  });
  return (
    <>
      <Button
        onClick={() => {
          const big = meta.approx_row_count > 50_000;
          if (big && !confirm(`${ns} has ${meta.approx_row_count.toLocaleString()} rows, probably real data. Write 5,000 test rows into it anyway? A practice namespace is safer.`)) return;
          burst.mutate();
        }}
        disabled={burst.isPending}
        title="5 concurrent requests of 1,000 rows each"
      >
        <Zap size={14} />{burst.isPending ? "Writing…" : "Write 5,000 rows"}
      </Button>
      {burst.error && <span className="text-[12px] text-red">{(burst.error as Error).message.slice(0, 60)}</span>}
    </>
  );
}
