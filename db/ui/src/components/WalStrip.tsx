// The WAL as a strip of blocks: one block per WAL entry, oldest on the left.
// Amber = durable but not indexed yet (every strong query brute-forces it).
// Teal  = folded into a segment by the indexer.
// The vertical line is the index cursor: everything left of it is indexed.

import { useEffect, useRef } from "react";
import type { WalEntry } from "../api";
import { fmtBytes } from "../api";

export default function WalStrip({ entries, cursor }: { entries: WalEntry[]; cursor: number }) {
  const seen = useRef<Set<number>>(new Set());
  const first = useRef(true);
  const fresh = new Set<number>();
  for (const e of entries) if (!seen.current.has(e.seq) && !first.current) fresh.add(e.seq);
  useEffect(() => {
    entries.forEach((e) => seen.current.add(e.seq));
    first.current = false;
  });

  const maxBytes = Math.max(1, ...entries.map((e) => e.bytes));
  // Fewer entries -> wider blocks, so a short log still reads as a strip.
  const width = entries.length <= 40 ? 22 : entries.length <= 90 ? 12 : 7;
  if (!entries.length) return <p className="text-[13px] text-muted">The WAL is empty. Write something to this namespace.</p>;

  return (
    <div>
      <div className="flex flex-wrap items-end gap-[3px]" role="list" aria-label="WAL entries">
        {entries.map((e, i) => {
          const showCursor = e.seq === cursor && i < entries.length - 1;
          const h = 16 + Math.round(40 * Math.sqrt(e.bytes / maxBytes)); // height ~ entry size
          return (
            <div key={e.seq} className="flex items-end" role="listitem">
              <div
                title={`WAL entry ${e.seq}\n${fmtBytes(e.bytes)}${e.rows != null ? `, ${e.rows} rows` : ""}\n${e.indexed ? "indexed" : "not indexed yet"}\n${new Date(e.at * 1000).toLocaleTimeString()}`}
                className={`rounded-[3px] transition-colors duration-700 ${e.indexed ? "bg-teal" : "bg-amber"} ${fresh.has(e.seq) ? "wal-arrive" : ""}`}
                style={{ height: h, width }}
              />
              {showCursor && <div aria-label={`index cursor at ${cursor}`} className="ml-[3px] h-16 w-[2px] rounded bg-text" />}
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-[12px] text-muted">
        <span className="flex items-center gap-1.5"><i className="inline-block h-2.5 w-2.5 rounded-sm bg-amber" />In the WAL, scanned by every query</span>
        <span className="flex items-center gap-1.5"><i className="inline-block h-2.5 w-2.5 rounded-sm bg-teal" />Indexed into a segment</span>
        <span className="flex items-center gap-1.5"><i className="inline-block h-3 w-[2px] rounded bg-text" />Index cursor</span>
        <span>Block height shows entry size. Hover a block for details.</span>
      </div>
    </div>
  );
}
