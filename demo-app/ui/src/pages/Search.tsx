import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Columns3, Flame, LoaderCircle, PenLine, Search as SearchIcon, Sparkles, Type, Layers } from "lucide-react";
import { api, fmtInt, fmtMs, type Config, type Level, type Mode, type SearchParams, type SearchResponse } from "../api";
import HowItRan from "../components/HowItRan";
import ResultCard from "../components/ResultCard";
import { Button, Card, Chip, ErrorNote, Segmented } from "../components/ui";

const EXAMPLES = [
  "vector search on object storage",
  "why do galaxies rotate too fast",
  "graph neural networks for molecules",
  "quantum error correction with surface codes",
];

const MODE_OPTIONS: { value: Mode; label: string; icon: React.ReactNode }[] = [
  { value: "hybrid", label: "Hybrid", icon: <Layers size={13} /> },
  { value: "vector", label: "Meaning", icon: <Sparkles size={13} /> },
  { value: "keyword", label: "Words", icon: <Type size={13} /> },
];

const MODE_LABEL: Record<string, string> = { hybrid: "Hybrid", vector: "Meaning (vector)", keyword: "Words (BM25)" };

export default function SearchPage({ config, backend }: { config?: Config; backend?: string }) {
  const [q, setQ] = useState("");
  const [mode, setMode] = useState<Mode>("hybrid");
  const [field, setField] = useState("");
  const [yearMin, setYearMin] = useState("");
  const [yearMax, setYearMax] = useState("");
  const [level, setLevel] = useState<Level>("strong");
  const [view, setView] = useState<"results" | "compare">("results");
  const stats = useQuery({ queryKey: ["stats-lite"], queryFn: api.stats, staleTime: 60_000 });

  const params = (text = q): SearchParams => ({
    q: text,
    mode,
    consistency: level,
    backend,
    filters: {
      field: field || undefined,
      year_min: yearMin ? Number(yearMin) : undefined,
      year_max: yearMax ? Number(yearMax) : undefined,
    },
  });

  const search = useMutation({ mutationFn: api.search });
  const compare = useMutation({ mutationFn: (p: SearchParams) => api.compare(p, (config?.backends.length ?? 1) > 1 ? "backends" : "modes") });
  const coldWarm = useMutation({ mutationFn: api.coldWarm });
  const writeRead = useMutation({ mutationFn: () => api.writeRead(backend) });

  const run = (text = q) => {
    if (!text.trim()) return;
    if (view === "compare") compare.mutate(params(text));
    else search.mutate(params(text));
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    run();
  };

  // ?q=… opens with that search already run (shareable demo links).
  useEffect(() => {
    const initial = new URLSearchParams(location.search).get("q");
    if (initial) {
      setQ(initial);
      search.mutate({ ...params(initial) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const docs = stats.data?.metadata?.approx_row_count;
  const res = search.data;
  const busy = search.isPending || compare.isPending;

  return (
    <div className="space-y-5">
      <div>
        <h1>Search arXiv</h1>
        <p className="mt-1 max-w-2xl text-muted">
          {docs ? `${fmtInt(docs)} papers` : "Papers"} searched by meaning (vectors) and by words (BM25), or both at once, on{" "}
          <span className="font-medium text-text">{backend ?? "…"}</span>.
        </p>
      </div>

      <Card className="p-3 sm:p-4">
        <form onSubmit={submit} className="flex gap-2">
          <label className="relative flex-1">
            <span className="sr-only">Search</span>
            <SearchIcon size={18} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint" />
            <input
              id="q"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Ask anything, e.g. how do black holes lose mass?"
              className="w-full rounded-lg border border-line bg-bg py-2.5 pr-3 pl-10 text-[15px] outline-none placeholder:text-faint focus:border-accent"
              autoFocus
            />
          </label>
          <Button type="submit" variant="primary" disabled={busy || !q.trim()}>
            {busy ? <LoaderCircle size={15} className="animate-spin" /> : <SearchIcon size={15} />}
            Search
          </Button>
        </form>

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2.5">
          <Segmented label="Search mode" value={mode} options={MODE_OPTIONS} onChange={setMode} />
          <select
            id="field"
            aria-label="Field"
            value={field}
            onChange={(e) => setField(e.target.value)}
            className="rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[13px]"
          >
            <option value="">All fields</option>
            {config?.fields.map((f) => (
              <option key={f}>{f}</option>
            ))}
          </select>
          <div className="flex items-center gap-1.5 text-[13px] text-muted">
            <span>Years</span>
            <input id="ymin" aria-label="From year" inputMode="numeric" value={yearMin} onChange={(e) => setYearMin(e.target.value.replace(/\D/g, "").slice(0, 4))} placeholder="from" className="w-16 rounded-lg border border-line bg-surface px-2 py-1.5 text-text" />
            <span>–</span>
            <input id="ymax" aria-label="To year" inputMode="numeric" value={yearMax} onChange={(e) => setYearMax(e.target.value.replace(/\D/g, "").slice(0, 4))} placeholder="to" className="w-16 rounded-lg border border-line bg-surface px-2 py-1.5 text-text" />
          </div>
          <Segmented
            label="Consistency"
            value={level}
            onChange={setLevel}
            options={[
              { value: "strong", label: "Strong" },
              { value: "eventual", label: "Eventual" },
            ]}
          />
        </div>
      </Card>

      {!res && !compare.data && !busy && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] text-muted">Try:</span>
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              onClick={() => {
                setQ(ex);
                run(ex);
              }}
              className="rounded-full border border-line bg-surface px-3 py-1 text-[13px] text-muted hover:border-faint hover:text-text"
            >
              {ex}
            </button>
          ))}
        </div>
      )}

      {String(search.error ?? compare.error ?? "").includes("not found") ? (
        <Card className="p-6">
          <h2>No papers loaded yet</h2>
          <p className="mt-1 text-muted">
            The search namespace doesn't exist on {backend}. Embed and load a slice of arXiv, then search again:
          </p>
          <pre className="mt-3 overflow-x-auto rounded-lg bg-surface-2 p-3 font-mono text-[12.5px]">
            make search-embed DOCS=100000{"\n"}make search-load DOCS=100000
          </pre>
        </Card>
      ) : (
        <ErrorNote error={search.error ?? compare.error} />
      )}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-3">
          {(res || compare.data || view === "compare") && (
            <div className="flex flex-wrap items-center justify-between gap-2 text-[13px] text-muted">
              <span>
                {view === "results" && res
                  ? `${res.results.length} results · ${MODE_LABEL[res.mode]} · ${fmtMs(res.timing.total_ms)}`
                  : "Side by side"}
              </span>
              <Segmented
                label="View"
                value={view}
                onChange={(v) => {
                  setView(v);
                  if (q.trim()) (v === "compare" ? compare : search).mutate(params());
                }}
                options={[
                  { value: "results", label: "Results" },
                  { value: "compare", label: "Compare", icon: <Columns3 size={13} /> },
                ]}
              />
            </div>
          )}
          {view === "results" && res && (
            <>
              {res.results.length === 0 && (
                <Card className="p-6 text-center text-muted">No papers match. Try fewer filters or other words.</Card>
              )}
              {res.results.map((r) => (
                <ResultCard key={r.id} r={r} />
              ))}
            </>
          )}
          {view === "compare" && compare.data && <CompareGrid data={compare.data} />}
          {view === "compare" && !compare.data && !busy && (
            <Card className="p-6 text-muted">
              Compare runs your search{" "}
              {(config?.backends.length ?? 1) > 1 ? "on both databases" : "in all three modes"} and shows the results side by side.
              Type a search and press Search.
            </Card>
          )}
        </div>

        <aside className="space-y-4">
          {view === "results" && res && <HowItRan res={res} />}
          <Card className="p-4">
            <h2 className="text-[15px]">Try the database</h2>
            <p className="mt-1 text-[12.5px] text-muted">Two quick experiments that show what's happening underneath.</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button onClick={() => coldWarm.mutate(params(q || EXAMPLES[0]))} disabled={coldWarm.isPending}>
                {coldWarm.isPending ? <LoaderCircle size={14} className="animate-spin" /> : <Flame size={14} />}
                Cold vs warm
              </Button>
              <Button onClick={() => writeRead.mutate()} disabled={writeRead.isPending}>
                {writeRead.isPending ? <LoaderCircle size={14} className="animate-spin" /> : <PenLine size={14} />}
                Write then read
              </Button>
            </div>
            <ErrorNote error={coldWarm.error ?? writeRead.error} />
            {coldWarm.data && (
              <div className="mt-3 space-y-1.5">
                {coldWarm.data.runs.map((r) => (
                  <div key={r.label} className="flex items-center justify-between text-[13px]">
                    <span className="text-muted">{r.label}</span>
                    <span className="flex items-center gap-2">
                      <Chip tone={r.cache_temperature === "hot" ? "teal" : r.cache_temperature === "warm" ? "amber" : "red"}>
                        {r.cache_temperature}
                      </Chip>
                      <span className="tabular w-16 text-right font-medium">{fmtMs(r.server_ms)}</span>
                    </span>
                  </div>
                ))}
                <p className="text-[12px] text-faint">
                  The first run pays for whatever isn't cached yet; the repeat is served from memory. Restart the query pods to see a truly cold start.
                </p>
              </div>
            )}
            {writeRead.data && (
              <div className="mt-3 space-y-1.5">
                {writeRead.data.steps.map((s) => (
                  <div key={s.step} className="flex items-center justify-between text-[13px]">
                    <span className="text-muted">{s.step}</span>
                    <span className="flex items-center gap-2">
                      {s.found != null && <Chip tone={s.found ? "teal" : "amber"}>{s.found ? "found" : "not yet"}</Chip>}
                      <span className="tabular w-16 text-right font-medium">{s.ms != null ? fmtMs(s.ms) : ""}</span>
                    </span>
                  </div>
                ))}
                <p className="text-[12px] text-faint">
                  The write is durable once acknowledged. Strong always sees it; eventual can miss it until its cached view (≤ 60 s) refreshes.
                </p>
              </div>
            )}
          </Card>
        </aside>
      </div>
    </div>
  );
}

function CompareGrid({ data }: { data: { across: string; columns: Record<string, SearchResponse | { error: string }> } }) {
  const cols = Object.entries(data.columns);
  return (
    <div className={`grid gap-3 ${cols.length === 3 ? "md:grid-cols-3" : "md:grid-cols-2"}`}>
      {cols.map(([name, col]) => (
        <div key={name} className="min-w-0 space-y-2">
          <div className="flex items-baseline justify-between px-1">
            <h2 className="text-[14px]">{data.across === "modes" ? MODE_LABEL[name] : name}</h2>
            {"timing" in col && <span className="tabular text-[12.5px] text-muted">{fmtMs(col.timing.total_ms)}</span>}
          </div>
          {"error" in col ? (
            <ErrorNote error={col.error} />
          ) : (
            col.results.map((r) => <ResultCard key={r.id} r={r} compact />)
          )}
        </div>
      ))}
    </div>
  );
}
