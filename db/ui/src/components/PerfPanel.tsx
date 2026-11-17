// The performance block of a query, with a plain-English line for each field.

import type { Performance } from "../api";
import { Pill } from "./ui";

const TEMPERATURE = {
  hot: { tone: "teal", text: "Everything came from this node's memory." },
  warm: { tone: "amber", text: "Read from this node's disk cache, no object storage reads for data." },
  cold: { tone: "red", text: "Fetched index files from object storage. Repeat the query to see it warm up." },
} as const;

export default function PerfPanel({ p }: { p: Performance }) {
  const t = TEMPERATURE[p.cache_temperature];
  const items: [string, React.ReactNode, string][] = [
    ["server_total_ms", `${p.server_total_ms} ms`, `Time on the query node. ${p.query_execution_ms} ms of it was search, the rest was fetching and checking state.`],
    ["cache_temperature", <Pill tone={t.tone}>{p.cache_temperature}</Pill>, `${t.text} Hit ratio ${Math.round(p.cache_hit_ratio * 100)}%.`],
    ["exhaustive_search_count", p.exhaustive_search_count.toLocaleString(),
      p.exhaustive_search_count ? "Unindexed rows brute-forced from the WAL tail. This drops to 0 once the indexer catches up." : "No unindexed rows: the index answered everything."],
    ["object_storage_round_trips", p.object_storage_round_trips,
      p.object_storage_round_trips === 0 ? "None: this query didn't touch the bucket at all." :
        `Requests to the bucket: ${Object.entries(p.object_storage_requests).map(([k, v]) => `${v} ${k}`).join(", ")}. A 304 means the manifest hadn't changed.`],
    ["consistency", p.consistency,
      p.consistency === "strong" ? "Checked object storage for the newest writes before answering." :
        `Reused this node's view from ${(p.view_age_ms / 1000).toFixed(1)} s ago without re-checking.${p.unindexed_entries_skipped ? ` Skipped ${p.unindexed_entries_skipped} WAL entries past the scan limit.` : ""}`],
    ["approx_namespace_size", p.approx_namespace_size.toLocaleString(), `Live documents seen, over ${p.segments_searched} segments and ${p.unindexed_entries_scanned} WAL entries (cursor ${p.index_cursor}, head ${p.wal_head}).`],
  ];
  return (
    <dl className="divide-y divide-line text-[13px]">
      {items.map(([k, v, why]) => (
        <div key={k} className="grid grid-cols-[minmax(0,190px)_1fr] gap-3 py-2">
          <dt className="font-mono text-[12px] text-muted">{k}</dt>
          <dd>
            <div className="tabular font-medium">{v}</div>
            <div className="text-[12.5px] text-muted">{why}</div>
          </dd>
        </div>
      ))}
      <div className="py-2 text-[12px] text-faint">Answered by node <span className="font-mono">{p.node}</span></div>
    </dl>
  );
}
