import { useLayoutEffect, useRef, useState } from 'react';
import { formatDuration, napkin } from '../lib/units.ts';

export interface RulerRow {
  id: string;
  label: string;
  ns: number;
  highlight?: boolean;
  total?: boolean;
}

const DECADE_LABEL = (d: number) => {
  const units: [number, string][] = [[0, 'ns'], [3, 'μs'], [6, 'ms'], [9, 's']];
  if (d >= 12) return ['17 min', '2.8 h', '28 h', '12 d', '116 d'][d - 12] ?? `10^${d - 9} s`;
  const [base, u] = units.filter(([b]) => b <= d).at(-1)!;
  return `${10 ** (d - base)} ${u}`;
};

/** Orders of magnitude, drawn: each step's time on a log axis with its napkin exponent. */
export function Ruler({ rows, caption }: { rows: RulerRow[]; caption: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(900);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const vals = rows.map((r) => r.ns).filter((x) => x > 0);
  const lo = Math.max(0, Math.min(Math.floor(Math.log10(Math.min(...vals, 1e3))), 15));
  const hi = Math.min(16, Math.max(Math.ceil(Math.log10(Math.max(...vals, 1))) + 1, lo + 6));
  const labelW = w < 640 ? 120 : 200;
  const right = 96;
  const plotW = Math.max(120, w - labelW - right);
  const x = (ns: number) => labelW + ((Math.log10(Math.max(ns, 10 ** lo)) - lo) / (hi - lo)) * plotW;
  const rowH = 26;
  const top = 22;
  const h = top + rows.length * rowH + 6;
  const decades = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);

  return (
    <div className="ruler" ref={ref}>
      <div className="ruler-head">
        <h3>{caption}</h3>
        <span className="faint" style={{ fontSize: 12 }}>log scale · each line is 10×</span>
      </div>
      <svg height={h} role="img" aria-label={`${caption}: ${rows.map((r) => `${r.label} ${formatDuration(r.ns)}`).join(', ')}`}>
        {decades.map((d) => (
          <g key={d}>
            <line className={`decade ${d % 3 === 0 ? 'major' : ''}`} x1={x(10 ** d)} x2={x(10 ** d)} y1={14} y2={h} />
            {(d % 3 === 0 || plotW / (hi - lo) > 70) && (
              <text className="tick-label" x={x(10 ** d)} y={10} textAnchor="middle">
                {DECADE_LABEL(d)}
              </text>
            )}
          </g>
        ))}
        {rows.map((r, i) => {
          const y = top + i * rowH;
          const end = x(r.ns);
          const { c, e } = napkin(r.ns / 1e9);
          const color = r.total ? 'var(--text)' : r.highlight ? 'var(--time)' : 'var(--time-soft)';
          return (
            <g className="row" key={r.id}>
              <title>{`${r.label}: ${formatDuration(r.ns)}`}</title>
              {(
                <text className="row-label" x={labelW - 12} y={y + 13} textAnchor="end" style={r.total ? { fill: 'var(--text)', fontWeight: 500 } : undefined}>
                  {r.label.length > (labelW < 200 ? 16 : 28) ? r.label.slice(0, labelW < 200 ? 15 : 27) + '…' : r.label}
                </text>
              )}
              <rect className="bar" x={labelW} y={y + 5} width={Math.max(2, end - labelW)} height={r.total ? 12 : 10} rx={2} fill={color} />
              <circle cx={end} cy={y + (r.total ? 11 : 10)} r={3} fill={color} />
              <text className="exp-label" x={end + 8} y={y + 14} style={r.total ? { fill: 'var(--text)' } : undefined}>
                {r.ns > 0 ? (
                  <>
                    {c}×10<tspan dy={-5} fontSize={9}>{e}</tspan>
                    <tspan dy={5}> s</tspan>
                  </>
                ) : '—'}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
