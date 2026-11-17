// Namespace detail: stats, schema, documents and segments for one namespace.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ChevronLeft, Flame, Trash2 } from "lucide-react";
import { api, fmtBytes, fmtNum, type Metadata, type QueryResult, type Row, type WalState } from "../api";
import { Button, Code, ErrorNote, IndexStatus, JsonBlock, Panel, Pill, Stat } from "../components/ui";

const PAGE = 25;

export default function NamespaceDetail() {
  const ns = decodeURIComponent(useParams().ns!);
  const nav = useNavigate();
  const qc = useQueryClient();
  const meta = useQuery({ queryKey: ["metadata", ns], queryFn: () => api<Metadata>(`/v1/namespaces/${ns}/metadata`), refetchInterval: 3000 });
  const wal = useQuery({ queryKey: ["wal", ns], queryFn: () => api<WalState>(`/debug/namespaces/${ns}/wal?limit=50`), refetchInterval: 3000 });
  // Pagination by id, the way turbopuffer's docs suggest: order by id, then filter id > last id seen.
  const [cursors, setCursors] = useState<(string | number | null)[]>([null]);
  const after = cursors[cursors.length - 1];
  const docs = useQuery({
    queryKey: ["docs", ns, after],
    queryFn: () => api<QueryResult>(`/v2/namespaces/${ns}/query`, {
      body: { rank_by: ["id", "asc"], limit: PAGE, include_attributes: true, ...(after !== null ? { filters: ["id", "Gt", after] } : {}) },
    }),
  });
  const [open, setOpen] = useState<Row | null>(null);
  const warm = useMutation({ mutationFn: () => api(`/v1/namespaces/${ns}/hint_cache_warm`) });
  const del = useMutation({
    mutationFn: () => api(`/v2/namespaces/${ns}`, { method: "DELETE" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["namespaces"] }); nav("/"); },
  });

  const m = meta.data;
  const rows = docs.data?.rows ?? [];
  const attrs = m ? Object.keys(m.schema).filter((a) => a !== "id" && a !== "vector") : [];

  return (
    <div className="mx-auto max-w-6xl">
      <Link to="/" className="inline-flex items-center gap-1 text-[13px] text-muted hover:text-text"><ChevronLeft size={14} />Namespaces</Link>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <h1 className="font-mono">{ns}</h1>
        {m && <IndexStatus status={m.index.status} rows={m.index.unindexed_rows} />}
        <div className="ml-auto flex gap-2">
          <Button kind="quiet" onClick={() => warm.mutate()} title="GET /v1/namespaces/{ns}/hint_cache_warm">
            <Flame size={14} />{warm.isSuccess ? "Warming started" : "Warm cache"}
          </Button>
          <Button kind="danger" onClick={() => { if (confirm(`Delete namespace ${ns} and all of its data? This cannot be undone.`)) del.mutate(); }}>
            <Trash2 size={14} />Delete namespace
          </Button>
        </div>
      </div>
      <ErrorNote error={meta.error ?? del.error} />

      {m && (
        <div className="mt-6 grid grid-cols-2 gap-6 rounded-lg border border-line bg-surface p-4 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="Documents" value={fmtNum(m.approx_row_count)} hint="approx_row_count" />
          <Stat label="Size" value={fmtBytes(m.approx_logical_bytes)} hint="approx_logical_bytes" />
          <Stat label="Unindexed rows" value={fmtNum(m.index.unindexed_rows ?? 0)} tone={m.index.unindexed_rows ? "amber" : undefined} hint={fmtBytes(m.index.unindexed_bytes)} />
          <Stat label="Index cursor" value={m.temupuffer.index_cursor} hint={`WAL head ${m.temupuffer.wal_head}`} />
          <Stat label="Segments" value={m.temupuffer.segments} hint={`manifest v${m.temupuffer.manifest_version}`} />
          <Stat label="Distance metric" value={<span className="text-[15px]">{m.distance_metric ?? "None"}</span>} hint={m.dims ? `${m.dims} dims, fixed at first write` : "no vectors"} />
        </div>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_320px]">
        <Panel title="Documents" aside={<>Ordered by id. Strong consistency, so the unindexed tail is included.</>}>
          <ErrorNote error={docs.error} />
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[13px]">
              <thead className="text-[12px] text-muted">
                <tr>
                  <th className="py-1.5 pr-4 font-medium">id</th>
                  {attrs.slice(0, 5).map((a) => <th key={a} className="py-1.5 pr-4 font-medium">{a}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={String(r.id)} onClick={() => setOpen(r)} className="cursor-pointer border-t border-line hover:bg-surface-2">
                    <td className="py-1.5 pr-4 font-mono">{String(r.id)}</td>
                    {attrs.slice(0, 5).map((a) => (
                      <td key={a} className="max-w-[260px] truncate py-1.5 pr-4 text-muted">{r[a] === undefined ? "" : typeof r[a] === "object" ? JSON.stringify(r[a]) : String(r[a])}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex items-center justify-between text-[12px] text-muted">
            <span>Page {cursors.length}</span>
            <div className="flex gap-2">
              <Button kind="quiet" disabled={cursors.length === 1} onClick={() => setCursors(cursors.slice(0, -1))}>Previous</Button>
              <Button kind="quiet" disabled={rows.length < PAGE} onClick={() => setCursors([...cursors, rows[rows.length - 1].id])}>Next</Button>
            </div>
          </div>
          {open && (
            <div className="mt-4">
              <div className="mb-2 flex items-center justify-between text-[13px]"><span>Document <Code>{String(open.id)}</Code></span>
                <button className="text-muted hover:text-text" onClick={() => setOpen(null)}>Close</button></div>
              <JsonBlock value={open} />
            </div>
          )}
        </Panel>

        <div className="flex flex-col gap-6">
          <Panel title="Schema">
            {m && (
              <ul className="space-y-2 text-[13px]">
                {Object.entries(m.schema).map(([name, spec]) => (
                  <li key={name} className="flex flex-wrap items-center gap-2">
                    <span className="font-mono">{name}</span>
                    <span className="text-faint">{spec.type}</span>
                    {spec.full_text_search && <Pill tone="accent">full-text</Pill>}
                    {spec.filterable && <Pill tone="neutral">filterable</Pill>}
                    {spec.ann && <Pill tone="neutral">ANN</Pill>}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <Panel title="Segments" aside="manifest.json">
            {wal.data && wal.data.manifest.segments.length === 0 && <p className="text-[13px] text-muted">Nothing indexed yet. Every query scans the WAL.</p>}
            <ul className="space-y-2 text-[13px]">
              {wal.data?.manifest.segments.map((s) => (
                <li key={s.id} className="rounded-md bg-teal-soft/60 px-3 py-2">
                  <div className="flex justify-between font-mono text-[12px]"><span>seg-{s.id}</span><span className="text-muted">level {s.level}</span></div>
                  <div className="text-muted">WAL {s.min_seq} to {s.max_seq}, {fmtNum(s.live_rows ?? s.rows)} rows, {fmtBytes(s.bytes)}</div>
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      </div>
    </div>
  );
}
