import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Database, LoaderCircle, Play, Square, Trash2, Upload } from "lucide-react";
import { api, fmtInt, type JobKind, type JobState, type Jobs, type Stats } from "../api";
import InfoPopover from "./InfoPopover";
import { Button, Card, Chip, ErrorNote } from "./ui";

const SIZES = [10_000, 100_000, 300_000, 1_000_000];
const short = (n: number) => (n >= 1_000_000 ? `${n / 1_000_000}M` : `${n / 1_000}k`);
const busy = (j?: JobState) => j?.state === "running" || j?.state === "starting";

function eta(seconds: number) {
  if (!isFinite(seconds) || seconds <= 0) return null;
  const m = Math.round(seconds / 60);
  return m < 60 ? `~${m} min left` : `~${Math.floor(m / 60)} h ${m % 60} min left`;
}

/** Docs/s from successive samples while a job runs (the embed Job reports nothing itself). */
function useRate(running: boolean, value: number) {
  const first = useRef<{ t: number; v: number } | null>(null);
  const [rate, setRate] = useState<number | null>(null);
  useEffect(() => {
    if (!running) {
      first.current = null;
      setRate(null);
      return;
    }
    const now = Date.now() / 1000;
    if (!first.current) first.current = { t: now, v: value };
    else if (now - first.current.t > 20 && value > first.current.v) setRate((value - first.current.v) / (now - first.current.t));
  }, [running, value]);
  return rate;
}

export default function DataCard({ stats, backend = "temupuffer" }: { stats?: Stats; backend?: string }) {
  const qc = useQueryClient();
  const jobs = useQuery({ queryKey: ["jobs"], queryFn: api.jobs, refetchInterval: 3000 });
  const j = jobs.data;
  const refresh = (data: Jobs) => qc.setQueryData(["jobs"], { ...j, ...data });

  const start = useMutation({
    mutationFn: (a: { kind: JobKind; docs: number; skip?: number }) => api.startJob(a.kind, { ...a, backend }),
    onSuccess: refresh,
  });
  const stop = useMutation({ mutationFn: (kind: JobKind) => api.stopJob(kind), onSuccess: refresh });

  const anyBusy = busy(j?.embed) || busy(j?.load);
  const can = !!j?.available && !!j?.actions_enabled;
  const rows = stats?.metadata?.approx_row_count ?? 0;

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Database size={16} className="text-muted" />
          <h2>Data</h2>
        </div>
        <span className="text-[12.5px] text-muted">
          Embeddings in object storage:{" "}
          <span className="tabular font-medium text-text">{fmtInt(j?.embeddings.docs ?? 0)}</span> papers ({fmtInt(j?.embeddings.chunks ?? 0)} chunks)
        </span>
      </div>
      <p className="mt-0.5 text-[12.5px] text-muted">
        Embed once, load many times: turning papers into vectors is the slow part, so it's saved to object storage and every load reuses it.
      </p>

      {j && !j.available && <Note>{j.reason}. The (i) next to each step shows the command to run instead.</Note>}
      {j?.available && !j.actions_enabled && <Note>Buttons are off on this deployment (ADMIN_ACTIONS=0). The (i) next to each step shows the command to run instead.</Note>}
      {j?.embeddings.error && <ErrorNote error={`Can't list embeddings: ${j.embeddings.error}`} />}

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <EmbedStep j={j} can={can} anyBusy={anyBusy} onStart={(docs) => start.mutate({ kind: "embed", docs })} onStop={() => stop.mutate("embed")} />
        <LoadStep
          j={j}
          stats={stats}
          rows={rows}
          can={can}
          anyBusy={anyBusy}
          backend={backend}
          onStart={(docs, skip) => start.mutate({ kind: "load", docs, skip })}
          onStop={() => stop.mutate("load")}
        />
      </div>
      <div className="mt-2 space-y-2">
        <ErrorNote error={start.error ?? stop.error ?? jobs.error} />
      </div>
      <ResetRow namespace={stats?.namespace ?? "arxiv"} can={can} anyBusy={anyBusy} backend={backend} />
    </Card>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return <div className="mt-3 rounded-lg bg-surface-2 px-3 py-2 text-[12.5px] text-muted">{children}</div>;
}

function StepBox({ title, state, info, children }: { title: string; state?: JobState; info: React.ReactNode; children: React.ReactNode }) {
  const tone = { running: "accent", starting: "accent", succeeded: "teal", failed: "red", none: "neutral" } as const;
  return (
    <div className="rounded-lg border border-line p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <span className="text-[13.5px] font-semibold">{title}</span>
          {info}
        </div>
        {state && state.state !== "none" && <Chip tone={tone[state.state]}>{state.state}</Chip>}
      </div>
      {children}
    </div>
  );
}

function Bar({ pct }: { pct: number }) {
  return (
    <div className="mt-2.5 h-2 overflow-hidden rounded-full bg-surface-2">
      <div className="h-full rounded-full bg-accent transition-[width] duration-700" style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
    </div>
  );
}

function SizeSelect({ id, value, onChange, max, extra }: { id: string; value: number; onChange: (n: number) => void; max: number; extra?: { value: number; label: string } }) {
  const opts = SIZES.filter((n) => n <= max).map((n) => ({ value: n, label: short(n) }));
  if (extra && !opts.some((o) => o.value === extra.value)) opts.push(extra);
  if (opts.length === 0) opts.push({ value: 0, label: "–" });
  return (
    <label htmlFor={id} className="flex items-center gap-1.5 text-[13px] text-muted">
      Papers
      <select
        id={id}
        value={value}
        disabled={opts[0].value === 0}
        onChange={(e) => onChange(+e.target.value)}
        className="rounded-lg border border-line bg-surface px-2 py-1 text-text disabled:opacity-50"
      >
        {opts.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function EmbedStep({ j, can, anyBusy, onStart, onStop }: { j?: Jobs; can: boolean; anyBusy: boolean; onStart: (docs: number) => void; onStop: () => void }) {
  const [docs, setDocs] = useState(1_000_000);
  const e = j?.embed;
  const running = busy(e);
  const have = j?.embeddings.docs ?? 0;
  const target = running && e?.docs ? e.docs : docs;
  const rate = useRate(running, have);
  const podsUp = e?.pods?.filter((p) => p.phase === "Running").length ?? 0;

  return (
    <StepBox
      title="1 · Embed"
      state={e}
      info={
        <InfoPopover kind="embed" title="Embed papers" docs={target}>
          <p>
            Downloads arXiv metadata from Hugging Face and turns each title + abstract into a 384-number vector with all-MiniLM-L6-v2, on CPU,
            inside the cluster.
          </p>
          <p>
            Runs as a Kubernetes Job with 3 pods (one per node), each capped at 2 CPUs so Forgejo and the rest keep running. About 48 papers/s per pod:
            ~2 hours for 1M.
          </p>
          <p>Resumable: chunks already in object storage are skipped, so Stop and Start again continues where it left off.</p>
        </InfoPopover>
      }
    >
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <SizeSelect id="embed-docs" value={docs} onChange={setDocs} max={j?.max_docs ?? 1_000_000} />
        {running ? (
          <Button onClick={onStop} disabled={!can}>
            <Square size={13} /> Stop
          </Button>
        ) : (
          <Button variant="primary" onClick={() => onStart(docs)} disabled={!can || anyBusy}>
            <Play size={13} /> Embed {short(docs)}
          </Button>
        )}
        {running && (
          <InfoPopover kind="stop" title="Stop a job" align="right">
            <p>Deletes the Job and its pods. Nothing is lost: finished chunks stay in object storage and the next Embed skips them.</p>
          </InfoPopover>
        )}
      </div>
      {(running || e?.state === "succeeded" || have > 0) && (
        <>
          <Bar pct={(have / target) * 100} />
          <div className="tabular mt-1.5 flex flex-wrap gap-y-1 text-[12.5px] text-muted [&>span+span]:before:mx-2 [&>span+span]:before:text-faint [&>span+span]:before:content-['·']">
            <span>
              <span className="font-medium text-text">{fmtInt(have)}</span> of {fmtInt(target)}
            </span>
            {running && <span>{podsUp} of {e?.completions ?? 3} pods running</span>}
            {running && rate && <span>{fmtInt(rate)} papers/s</span>}
            {running && rate && <span>{eta((target - have) / rate)}</span>}
            {e?.state === "failed" && <span className="text-red">failed: kubectl -n {j?.namespace} logs job/search-embed</span>}
          </div>
        </>
      )}
    </StepBox>
  );
}

function LoadStep({
  j,
  stats,
  rows,
  can,
  anyBusy,
  backend,
  onStart,
  onStop,
}: {
  j?: Jobs;
  stats?: Stats;
  rows: number;
  can: boolean;
  anyBusy: boolean;
  backend: string;
  onStart: (docs: number, skip: number) => void;
  onStop: () => void;
}) {
  const have = j?.embeddings.docs ?? 0;
  const [docs, setDocs] = useState<number | null>(null);
  const [skip, setSkip] = useState(0);
  const chosen = docs ?? Math.max(have - skip, 0);
  const l = j?.load;
  const running = busy(l);
  const g = stats?.ingest;
  const ns = stats?.namespace ?? "arxiv";

  return (
    <StepBox
      title="2 · Load"
      state={l}
      info={
        <InfoPopover kind="load" title="Load into the database" docs={chosen || 100_000} skip={skip} backend={backend} align="right">
          <p>
            Reads the saved vectors and upserts them into namespace <span className="font-mono text-text">{ns}</span> on {backend}, 2,000 papers
            per request, 4 requests in flight.
          </p>
          <p>
            Each write lands in the WAL first and is searchable right away. If the indexer falls behind, the database answers 429 and the job waits
            and retries the same batch: that's backpressure, not an error.
          </p>
          <p>Skip = papers already loaded, to resume a load that stopped. Writes are upserts, so loading a paper twice is harmless.</p>
        </InfoPopover>
      }
    >
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <SizeSelect
          id="load-docs"
          value={chosen}
          onChange={setDocs}
          max={Math.max(have - skip, 0)}
          extra={have - skip > 0 ? { value: have - skip, label: `all (${fmtInt(have - skip)})` } : undefined}
        />
        <label htmlFor="load-skip" className="flex items-center gap-1.5 text-[13px] text-muted">
          Skip
          <input
            id="load-skip"
            type="number"
            min={0}
            step={10000}
            value={skip}
            onChange={(e) => {
              setSkip(Math.max(0, +e.target.value || 0));
              setDocs(null);
            }}
            className="tabular w-28 rounded-lg border border-line bg-surface px-2 py-1 text-text"
          />
        </label>
        {running ? (
          <Button onClick={onStop} disabled={!can}>
            <Square size={13} /> Stop
          </Button>
        ) : (
          <Button variant="primary" onClick={() => onStart(chosen, skip)} disabled={!can || anyBusy || chosen < 1000}>
            <Upload size={13} /> Load {chosen >= 1000 ? fmtInt(chosen) : ""}
          </Button>
        )}
      </div>
      {!running && rows > 0 && rows < have && skip !== rows && (
        <button onClick={() => (setSkip(rows), setDocs(null))} className="mt-1.5 text-[12.5px] text-accent hover:underline">
          Resume: skip the {fmtInt(rows)} already loaded
        </button>
      )}
      {have === 0 && <div className="mt-1.5 text-[12.5px] text-faint">Embed first: there's nothing to load yet.</div>}
      {g && (running || l?.state === "succeeded" || !j?.available) && (
        <>
          <Bar pct={g.target ? (g.acked / g.target) * 100 : 0} />
          <div className="tabular mt-1.5 flex flex-wrap gap-y-1 text-[12.5px] text-muted [&>span+span]:before:mx-2 [&>span+span]:before:text-faint [&>span+span]:before:content-['·']">
            <span>
              <span className="font-medium text-text">{fmtInt(g.acked)}</span> of {fmtInt(g.target)} acknowledged
            </span>
            <span>{fmtInt(g.rows_per_s)} rows/s</span>
            <span className={g.retries_429 ? "text-amber" : ""}>{fmtInt(g.retries_429)} × 429</span>
            {running && g.rows_per_s > 0 && <span>{eta((g.target - g.acked) / g.rows_per_s)}</span>}
          </div>
        </>
      )}
      {l?.state === "failed" && <div className="mt-1.5 text-[12.5px] text-red">failed: kubectl -n {j?.namespace} logs job/search-load</div>}
    </StepBox>
  );
}

function ResetRow({ namespace, can, anyBusy, backend }: { namespace: string; can: boolean; anyBusy: boolean; backend: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [alsoEmb, setAlsoEmb] = useState(false);
  const reset = useMutation({
    mutationFn: () => api.reset({ confirm: typed, delete_embeddings: alsoEmb, backend }),
    onSuccess: () => {
      setOpen(false);
      setTyped("");
      setAlsoEmb(false);
      qc.invalidateQueries();
    },
  });

  return (
    <div className="mt-3 border-t border-line pt-3">
      <div className="flex flex-wrap items-center gap-1">
        <button
          onClick={() => setOpen(!open)}
          disabled={!can || anyBusy}
          className="inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-red disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Trash2 size={13} /> Reset namespace…
        </button>
        <InfoPopover kind="reset" title="Reset" backend={backend}>
          <p>
            Deletes namespace <span className="font-mono text-text">{namespace}</span>: its WAL, index segments and manifest in object storage. Search
            returns nothing until the next load.
          </p>
          <p>The saved embeddings are kept unless you tick the box, so a fresh load doesn't need a new 2-hour embed.</p>
        </InfoPopover>
        {anyBusy && <span className="text-[12px] text-faint">(stop the running job first)</span>}
      </div>
      {open && (
        <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-red/30 bg-red-soft/40 p-3 text-[13px]">
          <label htmlFor="reset-confirm" className="text-muted">
            Type <span className="font-mono text-text">{namespace}</span> to confirm
          </label>
          <input
            id="reset-confirm"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            className="w-36 rounded-lg border border-line bg-surface px-2 py-1 font-mono text-[12.5px]"
          />
          <label className="flex items-center gap-1.5 text-muted">
            <input type="checkbox" checked={alsoEmb} onChange={(e) => setAlsoEmb(e.target.checked)} /> also delete the embeddings
          </label>
          <button
            onClick={() => reset.mutate()}
            disabled={typed !== namespace || reset.isPending}
            className="inline-flex items-center gap-1.5 rounded-lg bg-red px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-40"
          >
            {reset.isPending ? <LoaderCircle size={13} className="animate-spin" /> : <Trash2 size={13} />} Delete
          </button>
          <ErrorNote error={reset.error} />
        </div>
      )}
    </div>
  );
}
