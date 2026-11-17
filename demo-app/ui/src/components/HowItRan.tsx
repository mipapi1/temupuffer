import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { fmtInt, fmtMs, type SearchResponse } from "../api";
import { Card, Chip } from "./ui";

function Row({ label, value, why }: { label: string; value: React.ReactNode; why: string }) {
  return (
    <div className="border-t border-line py-2.5 first:border-t-0">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[13px] text-muted">{label}</span>
        <span className="tabular text-right text-[13.5px] font-medium">{value}</span>
      </div>
      <p className="mt-0.5 text-[12px] leading-snug text-faint">{why}</p>
    </div>
  );
}

const tempTone = (t?: string) => (t === "hot" ? "teal" : t === "warm" ? "amber" : t === "cold" ? "red" : "neutral");

export default function HowItRan({ res }: { res: SearchResponse }) {
  const [showReq, setShowReq] = useState(false);
  const p = res.performance;
  const t = res.timing;
  const db = t.database_ms ?? 0;
  const embed = t.embed_ms ?? 0;
  const other = Math.max(0, t.total_ms - db - embed);
  const total = Math.max(t.total_ms, 0.001);
  const seg = (ms: number) => `${Math.max(0, (ms / total) * 100)}%`;
  const isTemu = res.backend === "temupuffer";

  return (
    <Card className="p-4">
      <h2 className="text-[15px]">How this query ran</h2>
      <div className="mt-3">
        <div className="flex items-baseline justify-between">
          <span className="text-[12px] text-muted">Total</span>
          <span className="tabular text-[20px] font-semibold">{fmtMs(t.total_ms)}</span>
        </div>
        <div className="mt-1.5 flex h-2 overflow-hidden rounded-full bg-surface-2" aria-hidden>
          <div style={{ width: seg(embed) }} className="bg-accent" />
          <div style={{ width: seg(db) }} className="bg-teal" />
          <div style={{ width: seg(other) }} className="bg-faint/50" />
        </div>
        <div className="mt-1.5 flex flex-wrap gap-x-3 text-[11.5px] text-muted">
          <span>
            <i className="mr-1 inline-block h-2 w-2 rounded-full bg-accent" />
            embedding {fmtMs(embed)}
          </span>
          <span>
            <i className="mr-1 inline-block h-2 w-2 rounded-full bg-teal" />
            database {fmtMs(db)}
          </span>
          <span>
            <i className="mr-1 inline-block h-2 w-2 rounded-full bg-faint/50" />
            app {fmtMs(other)}
          </span>
        </div>
      </div>

      <div className="mt-3">
        <Row
          label="Mode"
          value={res.mode === "hybrid" ? "hybrid (2 queries, fused)" : res.mode}
          why={
            res.mode === "hybrid"
              ? "A vector query and a BM25 query run together on one snapshot; reciprocal rank fusion merges the two lists."
              : res.mode === "vector"
                ? "Finds papers with similar meaning: nearest neighbours of your query's embedding."
                : "Finds papers containing your words, ranked by BM25 (title counts double)."
          }
        />
        <Row
          label="Time in the database"
          value={fmtMs(t.server_ms)}
          why="server_total_ms: measured inside the database, excluding the network."
        />
        <Row
          label="Cache"
          value={
            <span className="inline-flex items-center gap-1.5">
              <Chip tone={tempTone(p.cache_temperature)}>{p.cache_temperature ?? "–"}</Chip>
              {p.cache_hit_ratio != null && <span className="text-muted">{Math.round(p.cache_hit_ratio * 100)}% hits</span>}
            </span>
          }
          why="hot = served from memory, warm = from the node's disk, cold = fetched from object storage."
        />
        {isTemu && (
          <Row
            label="Object storage round trips"
            value={p.object_storage_round_trips ?? "–"}
            why="Strong queries always make 2 (manifest check + list the WAL tail). More means cache misses."
          />
        )}
        <Row
          label="Rows brute-forced"
          value={fmtInt(p.exhaustive_search_count)}
          why="Recent writes not indexed yet are scanned one by one. 0 means everything came from the index."
        />
        <Row
          label="Consistency"
          value={
            <>
              {p.consistency ?? "strong"}
              {p.consistency === "eventual" && p.view_age_ms != null && (
                <span className="text-muted"> · view {fmtMs(p.view_age_ms)} old</span>
              )}
            </>
          }
          why="Strong checks object storage for the newest writes every time. Eventual reuses a view up to 60 s old: faster, maybe stale."
        />
        {isTemu && (p.node || res.routed_to) && (
          <Row
            label="Served by"
            value={<span className="font-mono text-[12px]">{p.node ?? res.routed_to}</span>}
            why="Each namespace hashes to one query pod, so its cache stays warm on that pod."
          />
        )}
        {p.approx_namespace_size != null && (
          <Row label="Searched" value={`${fmtInt(p.approx_namespace_size)} docs`} why="approx_namespace_size: documents in the namespace." />
        )}
      </div>

      <button
        onClick={() => setShowReq(!showReq)}
        className="mt-2 flex w-full items-center justify-between rounded-md py-1.5 text-[12.5px] font-medium text-muted hover:text-text"
        aria-expanded={showReq}
      >
        Request sent to {res.backend}
        <ChevronDown size={14} className={`transition-transform ${showReq ? "rotate-180" : ""}`} />
      </button>
      {showReq && (
        <pre className="max-h-80 overflow-auto rounded-lg bg-surface-2 p-3 font-mono text-[11.5px] leading-relaxed">
          {JSON.stringify(res.request, null, 2)}
        </pre>
      )}
    </Card>
  );
}
