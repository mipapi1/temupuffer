import { useState } from "react";
import { ExternalLink, Sparkles, Type } from "lucide-react";
import type { Result } from "../api";
import { Chip } from "./ui";

export function RankBadges({ ranks }: { ranks: Result["ranks"] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {ranks.vector != null && (
        <Chip tone="accent">
          <Sparkles size={11} /> meaning #{ranks.vector}
        </Chip>
      )}
      {ranks.keyword != null && (
        <Chip>
          <Type size={11} /> words #{ranks.keyword}
        </Chip>
      )}
    </div>
  );
}

export default function ResultCard({ r, compact = false }: { r: Result; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const url = r.arxiv_id ? `https://arxiv.org/abs/${r.arxiv_id}` : undefined;
  return (
    <article className="group rounded-xl border border-line bg-surface p-4 transition-colors hover:border-faint">
      <div className="flex items-start justify-between gap-3">
        <h3 className={`${compact ? "text-[14px]" : "text-[15.5px]"} leading-snug font-semibold`}>
          {url ? (
            <a href={url} target="_blank" rel="noreferrer" className="hover:text-accent">
              {r.title}
              <ExternalLink size={12} className="ml-1 inline align-baseline text-faint opacity-0 group-hover:opacity-100" />
            </a>
          ) : (
            r.title
          )}
        </h3>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-muted">
        <span className="font-medium text-text">{r.field}</span>
        <span className="font-mono text-[12px]">{r.category}</span>
        {r.year > 0 && <span className="tabular">{r.year}</span>}
        {!compact && r.authors && <span className="truncate">· {r.authors}</span>}
      </div>
      {!compact && (
        <p
          onClick={() => setOpen(!open)}
          className={`mt-2 cursor-pointer text-[13.5px] leading-relaxed text-muted ${open ? "" : "line-clamp-3"}`}
          title={open ? "Show less" : "Show the whole abstract"}
        >
          {r.abstract}
        </p>
      )}
      <div className="mt-2.5">
        <RankBadges ranks={r.ranks} />
      </div>
    </article>
  );
}
