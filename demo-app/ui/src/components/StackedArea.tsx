import { useEffect, useRef, useState } from "react";
import { fmtInt } from "../api";

export interface Point {
  t: number; // unix seconds
  indexed: number;
  unindexed: number;
}

const H = 220;
const PAD = { top: 12, right: 92, bottom: 26, left: 56 };

/** A round tick step (1, 2 or 5 × 10^n) that splits `max` into about 4 intervals. */
function niceStep(max: number) {
  if (max <= 0) return 1;
  const raw = max / 4;
  const p = 10 ** Math.floor(Math.log10(raw));
  const n = raw / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

const fmtShort = (n: number) =>
  n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${+(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k` : `${n}`;
const fmtClock = (t: number) => new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** Indexed (teal) under unindexed (amber): the stack's top edge is the total row count. */
export default function StackedArea({ data }: { data: Point[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(640);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(320, e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);

  if (data.length < 2) {
    return (
      <div ref={ref} className="flex h-[220px] items-center justify-center rounded-lg bg-surface-2 text-[13px] text-muted">
        Collecting samples every 5 seconds…
      </div>
    );
  }

  const t0 = data[0].t;
  const t1 = data[data.length - 1].t;
  const peak = Math.max(...data.map((d) => d.indexed + d.unindexed)) * 1.05;
  const step = niceStep(peak);
  const yMax = Math.max(step, Math.ceil(peak / step) * step);
  const iw = w - PAD.left - PAD.right;
  const ih = H - PAD.top - PAD.bottom;
  const x = (t: number) => PAD.left + ((t - t0) / Math.max(1, t1 - t0)) * iw;
  const y = (v: number) => PAD.top + ih - (v / yMax) * ih;

  const lowerTop = data.map((d) => [x(d.t), y(d.indexed)] as const);
  const upperTop = data.map((d) => [x(d.t), y(d.indexed + d.unindexed)] as const);
  const line = (pts: readonly (readonly [number, number])[]) => pts.map(([a, b], i) => `${i ? "L" : "M"}${a},${b}`).join("");
  const base = `L${x(t1)},${y(0)}L${x(t0)},${y(0)}Z`;
  const lowerArea = line(lowerTop) + base;
  const upperArea = line(upperTop) + lowerTop.slice().reverse().map(([a, b]) => `L${a},${b}`).join("") + "Z";
  const ticks = Array.from({ length: Math.round(yMax / step) + 1 }, (_, i) => i * step);

  const last = data[data.length - 1];
  const lowerMid = y(last.indexed / 2);
  const upperMid = y(last.indexed + last.unindexed / 2);
  const upperBand = y(last.indexed) - y(last.indexed + last.unindexed);

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * w;
    const t = t0 + ((px - PAD.left) / iw) * (t1 - t0);
    let best = 0;
    for (let i = 1; i < data.length; i++) if (Math.abs(data[i].t - t) < Math.abs(data[best].t - t)) best = i;
    setHover(best);
  };
  const hp = hover != null ? data[hover] : null;

  return (
    <div ref={ref} className="relative">
      <svg
        viewBox={`0 0 ${w} ${H}`}
        width="100%"
        height={H}
        role="img"
        aria-label={`Rows over time: ${fmtInt(last.indexed)} indexed and ${fmtInt(last.unindexed)} not yet indexed now`}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        className="block touch-none"
      >
        {ticks.map((v) => (
          <g key={v}>
            <line x1={PAD.left} x2={PAD.left + iw} y1={y(v)} y2={y(v)} stroke="var(--line)" strokeWidth={1} />
            <text x={PAD.left - 8} y={y(v)} dy="0.32em" textAnchor="end" fontSize={11} fill="var(--muted)" className="tabular">
              {fmtShort(v)}
            </text>
          </g>
        ))}
        <path d={lowerArea} fill="var(--chart-teal)" fillOpacity={0.28} />
        <path d={upperArea} fill="var(--chart-amber)" fillOpacity={0.3} />
        <path d={line(lowerTop)} fill="none" stroke="var(--surface)" strokeWidth={4} />
        <path d={line(lowerTop)} fill="none" stroke="var(--chart-teal)" strokeWidth={2} />
        <path d={line(upperTop)} fill="none" stroke="var(--chart-amber)" strokeWidth={2} />
        <text x={PAD.left} y={H - 6} fontSize={11} fill="var(--muted)">
          {fmtClock(t0)}
        </text>
        <text x={PAD.left + iw} y={H - 6} fontSize={11} fill="var(--muted)" textAnchor="end">
          {fmtClock(t1)}
        </text>
        {y(0) - y(last.indexed) >= 14 && (
          <text x={PAD.left + iw + 8} y={lowerMid} dy="0.32em" fontSize={12} fill="var(--text)">
            indexed
          </text>
        )}
        {upperBand >= 14 && (
          <text x={PAD.left + iw + 8} y={upperMid} dy="0.32em" fontSize={12} fill="var(--text)">
            not indexed
          </text>
        )}
        {hp && (
          <g>
            <line x1={x(hp.t)} x2={x(hp.t)} y1={PAD.top} y2={PAD.top + ih} stroke="var(--muted)" strokeWidth={1} strokeDasharray="3 3" />
            <circle cx={x(hp.t)} cy={y(hp.indexed)} r={4} fill="var(--chart-teal)" stroke="var(--surface)" strokeWidth={2} />
            <circle cx={x(hp.t)} cy={y(hp.indexed + hp.unindexed)} r={4} fill="var(--chart-amber)" stroke="var(--surface)" strokeWidth={2} />
          </g>
        )}
      </svg>
      {hp && (
        <div
          className="pointer-events-none absolute top-2 rounded-lg border border-line bg-surface px-3 py-2 text-[12px] shadow-md"
          style={{ left: Math.min(Math.max(x(hp.t) / w, 0.1), 0.72) * 100 + "%" }}
        >
          <div className="font-medium">{fmtClock(hp.t)}</div>
          <div className="tabular mt-1 flex items-center gap-2">
            <i className="h-2 w-2 rounded-full" style={{ background: "var(--chart-teal)" }} /> indexed {fmtInt(hp.indexed)}
          </div>
          <div className="tabular flex items-center gap-2">
            <i className="h-2 w-2 rounded-full" style={{ background: "var(--chart-amber)" }} /> not indexed {fmtInt(hp.unindexed)}
          </div>
          <div className="tabular mt-0.5 text-muted">total {fmtInt(hp.indexed + hp.unindexed)}</div>
        </div>
      )}
    </div>
  );
}
