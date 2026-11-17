// Query playground: build vector, BM25 and filter queries, pick strong or eventual,
// and see the request, the rows and the performance block side by side.

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Play } from "lucide-react";
import { api, type Metadata, type QueryResult } from "../api";
import { Button, ErrorNote, JsonBlock, Panel } from "../components/ui";
import PerfPanel from "../components/PerfPanel";

type Mode = "bm25" | "vector" | "order";

const input = "h-9 w-full rounded-md border border-line bg-bg px-3 text-[13px]";

export default function Playground() {
  const list = useQuery({ queryKey: ["namespaces"], queryFn: () => api<{ namespaces: { id: string }[] }>("/v1/namespaces?page_size=1000") });
  const [ns, setNs] = useState("");
  useEffect(() => {
    if (!ns && list.data?.namespaces.length) setNs(list.data.namespaces[0].id);
  }, [list.data, ns]);
  const meta = useQuery({ enabled: !!ns, queryKey: ["metadata", ns], queryFn: () => api<Metadata>(`/v1/namespaces/${ns}/metadata`) });
  const ftsAttrs = Object.entries(meta.data?.schema ?? {}).filter(([, s]) => s.full_text_search).map(([k]) => k);
  const filterable = Object.entries(meta.data?.schema ?? {}).filter(([k, s]) => s.filterable && k !== "vector").map(([k]) => k);

  const [mode, setMode] = useState<Mode>("bm25");
  const [text, setText] = useState("quantum puffer");
  const [ftsAttr, setFtsAttr] = useState("");
  const [vectorText, setVectorText] = useState("");
  const [ann, setAnn] = useState(true);
  const [filterJson, setFilterJson] = useState("");
  const [limit, setLimit] = useState(10);
  const [consistency, setConsistency] = useState<"strong" | "eventual">("strong");

  useEffect(() => {
    if (ftsAttrs.length && !ftsAttrs.includes(ftsAttr)) setFtsAttr(ftsAttrs[0]);
    if (!meta.data?.dims && mode === "vector") setMode(ftsAttrs.length ? "bm25" : "order");
  }, [meta.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const body = useMemo(() => {
    let rank_by: unknown;
    if (mode === "bm25") rank_by = [ftsAttr, "BM25", text];
    else if (mode === "vector") {
      let v: number[] = [];
      try { v = JSON.parse(vectorText || "[]"); } catch { /* shown as an error on run */ }
      rank_by = ["vector", ann ? "ANN" : "kNN", v];
    } else rank_by = ["id", "asc"];
    const b: Record<string, unknown> = { rank_by, limit, include_attributes: true, consistency: { level: consistency } };
    if (filterJson.trim()) {
      try { b.filters = JSON.parse(filterJson); } catch { b.filters = "invalid JSON"; }
    }
    return b;
  }, [mode, ftsAttr, text, vectorText, ann, filterJson, limit, consistency]);

  const run = useMutation({ mutationFn: () => api<QueryResult>(`/v2/namespaces/${ns}/query`, { body }) });

  // A vector to start from: borrow one from an existing document.
  const sample = useMutation({
    mutationFn: () => api<QueryResult>(`/v2/namespaces/${ns}/query`, { body: { rank_by: ["id", "asc"], limit: 1, include_attributes: ["vector"] } }),
    onSuccess: (r) => r.rows?.[0] && setVectorText(JSON.stringify(r.rows[0].vector)),
  });

  const shownBody = mode === "vector" && vectorText.length > 120
    ? { ...body, rank_by: ["vector", ann ? "ANN" : "kNN", `[${(JSON.parse(vectorText || "[]") as number[]).length} floats]`] } : body;

  return (
    <div className="mx-auto max-w-6xl">
      <h1>Query</h1>
      <p className="mt-1 max-w-2xl text-muted">
        Run the same query with strong and with eventual consistency, then run it twice to watch the cache warm.
        The performance block says where the time went.
      </p>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,420px)_1fr]">
        <Panel title="Build a query">
          <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); run.mutate(); }}>
            <label className="block text-[12px] text-muted">Namespace
              <select className={`${input} mt-1 font-mono`} value={ns} onChange={(e) => setNs(e.target.value)}>
                {list.data?.namespaces.map((n) => <option key={n.id}>{n.id}</option>)}
              </select>
            </label>

            <div role="radiogroup" aria-label="Ranking" className="grid grid-cols-3 gap-1 rounded-md bg-surface-2 p-1 text-[13px]">
              {([["bm25", "Full text"], ["vector", "Vector"], ["order", "Filter only"]] as [Mode, string][]).map(([m, label]) => (
                <button type="button" role="radio" aria-checked={mode === m} key={m} onClick={() => setMode(m)}
                  disabled={(m === "vector" && !meta.data?.dims) || (m === "bm25" && !ftsAttrs.length)}
                  className={`rounded px-2 py-1 disabled:opacity-40 ${mode === m ? "bg-surface font-medium shadow-sm" : "text-muted"}`}>{label}</button>
              ))}
            </div>

            {mode === "bm25" && (
              <div className="grid grid-cols-[1fr_130px] gap-2">
                <label className="text-[12px] text-muted">Search text
                  <input className={`${input} mt-1`} value={text} onChange={(e) => setText(e.target.value)} />
                </label>
                <label className="text-[12px] text-muted">Attribute
                  <select className={`${input} mt-1 font-mono`} value={ftsAttr} onChange={(e) => setFtsAttr(e.target.value)}>
                    {ftsAttrs.map((a) => <option key={a}>{a}</option>)}
                  </select>
                </label>
              </div>
            )}
            {mode === "vector" && (
              <div>
                <div className="flex items-end justify-between">
                  <span className="text-[12px] text-muted">Query vector ({meta.data?.dims} dims)</span>
                  <button type="button" className="text-[12px] text-accent hover:underline" onClick={() => sample.mutate()}>Use a document's vector</button>
                </div>
                <textarea className="mt-1 h-20 w-full rounded-md border border-line bg-bg p-2 font-mono text-[12px]" value={vectorText}
                  onChange={(e) => setVectorText(e.target.value)} placeholder="[0.12, -0.4, …]" />
                <label className="mt-1 flex items-center gap-2 text-[13px]">
                  <input type="checkbox" checked={ann} onChange={(e) => setAnn(e.target.checked)} />
                  Approximate (ANN). Untick for exact kNN, which compares against every vector.
                </label>
              </div>
            )}

            <label className="block text-[12px] text-muted">Filters (JSON, optional)
              <textarea className="mt-1 h-16 w-full rounded-md border border-line bg-bg p-2 font-mono text-[12px]" value={filterJson}
                onChange={(e) => setFilterJson(e.target.value)}
                placeholder={filterable.length ? `["And", [["${filterable[0]}", "Eq", "…"], ["year", "Gte", 2015]]]` : ""} />
            </label>
            {filterable.length > 0 && <div className="-mt-2 text-[12px] text-faint">Filterable: {filterable.join(", ")}</div>}

            <div className="grid grid-cols-2 gap-2">
              <label className="text-[12px] text-muted">Limit
                <input type="number" min={1} max={10000} className={`${input} mt-1`} value={limit} onChange={(e) => setLimit(Number(e.target.value))} />
              </label>
              <div className="text-[12px] text-muted">Consistency
                <div role="radiogroup" className="mt-1 grid h-9 grid-cols-2 gap-1 rounded-md bg-surface-2 p-1 text-[13px]">
                  {(["strong", "eventual"] as const).map((c) => (
                    <button type="button" role="radio" aria-checked={consistency === c} key={c} onClick={() => setConsistency(c)}
                      className={`rounded ${consistency === c ? "bg-surface font-medium text-text shadow-sm" : ""}`}>{c}</button>
                  ))}
                </div>
              </div>
            </div>
            <Button type="submit" disabled={!ns || run.isPending}><Play size={14} />Run query</Button>
          </form>
          <div className="mt-5">
            <div className="mb-1 text-[12px] text-muted">Request body, <span className="font-mono">POST /v2/namespaces/{ns}/query</span></div>
            <JsonBlock value={shownBody} maxHeight={220} />
          </div>
        </Panel>

        <div className="flex min-w-0 flex-col gap-6">
          <ErrorNote error={run.error} />
          {!run.data && !run.error && (
            <div className="rounded-lg border border-dashed border-line px-6 py-12 text-center text-muted">Results and timings appear here.</div>
          )}
          {run.data && (
            <>
              <Panel title="How this query ran" aside="performance"><PerfPanel p={run.data.performance} /></Panel>
              <Panel title={`${run.data.rows?.length ?? 0} rows`} aside={mode === "vector" ? "$dist is distance: lower is closer" : mode === "bm25" ? "$dist is the BM25 score: higher is better" : undefined}>
                <ol className="space-y-2">
                  {run.data.rows?.map((r) => (
                    <li key={String(r.id)} className="rounded-md border border-line px-3 py-2 text-[13px]">
                      <div className="flex justify-between gap-3 font-mono text-[12px]">
                        <span>id {String(r.id)}</span>
                        {r.$dist !== undefined && <span className="tabular text-muted">$dist {r.$dist.toFixed(4)}</span>}
                      </div>
                      <div className="mt-1 text-muted">
                        {Object.entries(r).filter(([k]) => k !== "id" && k !== "$dist" && k !== "vector").map(([k, v]) => (
                          <span key={k} className="mr-3"><span className="text-faint">{k}</span> {typeof v === "object" ? JSON.stringify(v) : String(v)}</span>
                        ))}
                      </div>
                    </li>
                  ))}
                </ol>
              </Panel>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
