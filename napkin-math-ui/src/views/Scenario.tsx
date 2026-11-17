import { useEffect, useMemo, useRef, useState } from 'react';
import { evaluate, resolveReference, newId, TIER_LABEL, type OpStep, type PricingTier, type Step, type StepResult, type StoreStep } from '../lib/engine.ts';
import {
  OPERATIONS, OPS_BY_ID, CATEGORY_LABEL, STORE_CLASSES, shortName, transformOf, hostOf, defaultParallelism, parallelismLabel, isIoBound, type Category,
} from '../lib/reference.ts';
import { formatBytes, formatDuration, formatMoney, formatRate, formatCount, napkin, sig } from '../lib/units.ts';
import { overlayFor } from '../lib/cloud.ts';
import { useDatasets } from '../lib/useDatasets.ts';
import { PROVIDER_LABEL, PROVIDERS, type Provider } from '../lib/schema.ts';
import { setState, updateScenario, resetPreset, useAppState } from '../lib/store.ts';
import type { Scenario } from '../lib/presets.ts';
import { Quantity } from '../components/Quantity.tsx';
import { Palette, type PaletteItem } from '../components/Palette.tsx';
import { Ruler } from '../components/Ruler.tsx';

const CATEGORY_ORDER: Category[] = ['memory', 'cache', 'cpu', 'ssd', 'hdd', 'network-disk', 'network', 'blob', 'egress', 'service', 'os', 'gpu'];

const PALETTE_ITEMS: PaletteItem[] = [
  ...CATEGORY_ORDER.flatMap((c) =>
    OPERATIONS.filter((o) => o.category === c).map((o) => ({
      id: `op:${o.id}`,
      group: CATEGORY_LABEL[c],
      label: o.name,
      meta: [o.latencyNs != null ? formatDuration(o.latencyNs) : null, o.throughputBps ? formatRate(o.throughputBps) : null].filter(Boolean).join('  ·  '),
      keywords: `${o.category} ${o.scope ?? ''}`,
    })),
  ),
  ...STORE_CLASSES.map((c) => ({ id: `store:${c.id}`, group: 'Keep at rest', label: `Store in ${c.name}`, meta: `$${c.monthly}/GB·mo`, keywords: 'store retention storage rest keep' })),
];

function NapkinForm({ value, unit }: { value: number; unit: string }) {
  if (!Number.isFinite(value) || value === 0) return null;
  const { c, e } = napkin(value);
  return (
    <span className="napkin-form">
      ≈ {c}×10<sup>{e}</sup> {unit}
    </span>
  );
}

export function ScenarioView({ scenario }: { scenario: Scenario }) {
  const app = useAppState();
  const ds = useDatasets(true);
  const [palette, setPalette] = useState<null | { replace?: string }>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const w = scenario.workload;

  // ⌘K / Ctrl+K opens the step picker
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette({});
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const overlay = useMemo(() => {
    const src = app.priceSource;
    const d = src && ds?.[src.provider];
    return d ? overlayFor(d, src!.region) : null;
  }, [app.priceSource, ds]);
  const ref = useMemo(() => resolveReference(overlay?.overrides, app.overrides), [overlay, app.overrides]);
  const result = useMemo(() => evaluate(w, scenario.steps, ref), [w, scenario.steps, ref]);

  const set = (fn: (s: Scenario) => Scenario) => updateScenario(scenario.id, fn);
  const setW = (patch: Partial<typeof w>) => set((s) => ({ ...s, workload: { ...s.workload, ...patch } }));
  const setStep = (id: string, patch: Partial<OpStep> | Partial<StoreStep>) => set((s) => ({ ...s, steps: s.steps.map((x) => (x.id === id ? ({ ...x, ...patch } as Step) : x)) }));
  const move = (id: string, d: -1 | 1) =>
    set((s) => {
      const i = s.steps.findIndex((x) => x.id === id);
      const j = i + d;
      if (j < 0 || j >= s.steps.length) return s;
      const steps = [...s.steps];
      [steps[i], steps[j]] = [steps[j], steps[i]];
      return { ...s, steps };
    });

  const pick = (pid: string) => {
    const [kind, id] = pid.split(':');
    let step: Step;
    if (kind === 'op') {
      const op = OPS_BY_ID.get(id)!;
      step = { id: newId(), kind: 'op', opId: id, parallelism: defaultParallelism(op) };
    } else step = { id: newId(), kind: 'store', costId: id, months: 1, replicas: 1 };
    const replace = palette?.replace;
    set((s) => ({ ...s, steps: replace ? s.steps.map((x) => (x.id === replace ? { ...step, id: x.id } : x)) : [...s.steps, step] }));
    setPalette(null);
  };

  const opResults = result.steps.filter((s) => s.kind === 'op');
  const t = result.totals;
  const batch = w.mode === 'batch';
  const bottleneck = result.steps.find((s) => s.id === t.bottleneckId);
  const source = app.priceSource;
  const sourceDs = source ? ds?.[source.provider] : undefined;
  const sourceEstimated = sourceDs?.mode === 'snapshot';

  return (
    <div className="page">
      <header>
        <input className="title-input" value={scenario.name} aria-label="Scenario name" onChange={(e) => set((s) => ({ ...s, name: e.target.value }))} />
        <AutoTextarea value={scenario.description} onChange={(v) => set((s) => ({ ...s, description: v }))} />
      </header>

      <div className="toolbar">
        <div className="seg" role="group" aria-label="Workload mode">
          <button aria-pressed={batch} onClick={() => setW({ mode: 'batch' })} title="Process a fixed amount of data once">Batch</button>
          <button aria-pressed={!batch} onClick={() => setW({ mode: 'stream' })} title="Steady traffic: requests per second">Stream</button>
        </div>
        {batch ? (
          <label className="field">
            Data
            <Quantity kind="bytes" label="Total data" value={w.totalBytes} min={1} onChange={(n) => n && setW({ totalBytes: n })} />
          </label>
        ) : (
          <>
            <label className="field">
              Requests/s
              <Quantity kind="count" label="Requests per second" value={w.rps} min={0} onChange={(n) => n != null && setW({ rps: n })} />
            </label>
            <label className="field">
              Size
              <Quantity kind="bytes" label="Bytes per request" value={w.requestBytes} min={1} onChange={(n) => n && setW({ requestBytes: n })} />
            </label>
          </>
        )}
        <div className="seg" role="group" aria-label="Pricing">
          {(['monthly', 'commit1y', 'spot'] as PricingTier[]).map((k) => (
            <button key={k} aria-pressed={w.tier === k} onClick={() => setW({ tier: k })}>{TIER_LABEL[k]}</button>
          ))}
        </div>
        <label className="field" title="Swap the README's round numbers for one provider-region's list prices">
          Prices
          <select
            className="plain"
            value={source ? `${source.provider}|${source.region}` : ''}
            onChange={(e) => {
              const v = e.target.value;
              setState((s) => ({ ...s, priceSource: v ? { provider: v.split('|')[0] as Provider, region: v.split('|')[1] } : null }));
            }}
          >
            <option value="">Napkin defaults (README)</option>
            {PROVIDERS.map((p) =>
              ds?.[p] ? (
                <optgroup key={p} label={`${PROVIDER_LABEL[p]}${ds[p]!.mode === 'snapshot' ? ' (estimates)' : ''}`}>
                  {ds[p]!.regions.map((r) => (
                    <option key={r.id} value={`${p}|${r.id}`}>{PROVIDER_LABEL[p]} · {r.name}</option>
                  ))}
                </optgroup>
              ) : null,
            )}
          </select>
          {source && (sourceEstimated ? <span className="est-badge">estimate</span> : <span className="live-badge">list price</span>)}
        </label>
      </div>

      <section className="results" aria-label="Results">
        {batch ? (
          <>
            <Metric label="Time, one step after another" value={formatDuration(t.serialNs)} napkinV={t.serialNs / 1e9} unit="s" cls="t-time" sub={`${opResults.length} steps`} />
            <Metric label="Time, steps overlapped" value={formatDuration(t.pipelinedNs)} napkinV={t.pipelinedNs / 1e9} unit="s" cls="t-time" sub={bottleneck ? `Bottleneck: ${shortName(bottleneck.op!)}` : '—'} />
            <Metric label={`Cost (${TIER_LABEL[w.tier].toLowerCase()})`} value={formatMoney(t.costUsd)} napkinV={t.costUsd} unit="$" cls="t-money" sub={`${formatMoney(t.costUsd / Math.max(1e-12, w.totalBytes / 2 ** 40))} per TiB in`} />
            <Metric label="Data out" value={formatBytes(t.outBytes)} napkinV={t.outBytes} unit="B" cls="t-data" sub={`from ${formatBytes(w.totalBytes)} in`} />
          </>
        ) : (
          <>
            <Metric label="Latency per request" value={formatDuration(t.requestLatencyNs)} napkinV={t.requestLatencyNs / 1e9} unit="s" cls="t-time" sub={bottleneck ? `Slowest: ${shortName(bottleneck.op!)}` : '—'} />
            <Metric label="Cost per month" value={formatMoney(t.costUsd)} napkinV={t.costUsd} unit="$" cls="t-money" sub={`${formatMoney(t.costUsd / Math.max(1, w.rps * 2.628e6) * 1e6)} per 1M requests`} />
            <Metric label="Traffic in" value={formatRate(w.rps * w.requestBytes)} napkinV={w.rps * w.requestBytes} unit="B/s" cls="t-data" sub={`${formatBytes(w.rps * w.requestBytes * 2.628e6)} per month`} />
            <Metric label="Compute needed" value={`${sig(computeVcpus(result.steps))} vCPU`} napkinV={computeVcpus(result.steps)} unit="vCPU" cls="" sub={`${formatMoney(t.computeUsd)}/mo of the total`} />
          </>
        )}
      </section>

      {opResults.length > 0 && (
        <Ruler
          caption={batch ? 'Where the time goes' : 'Where a request spends its time'}
          rows={[
            ...opResults.map((s) => ({ id: s.id, label: shortName(s.op!), ns: batch ? s.timeNs : s.requestLatencyNs, highlight: s.id === t.bottleneckId })),
            { id: 'total', label: batch ? 'Total' : 'Total per request', ns: batch ? t.serialNs : t.requestLatencyNs, total: true },
          ]}
        />
      )}

      <div className="section-head">
        <h3>Steps</h3>
        <div style={{ display: 'flex', gap: 6 }}>
          {scenario.preset && (
            <button className="btn ghost" onClick={() => resetPreset(scenario.id)} title="Restore this preset's original steps">Reset preset</button>
          )}
        </div>
      </div>
      <div className="steps">
        {scenario.steps.length === 0 && (
          <div className="empty">
            Add the first step: a read, some CPU work, a network hop. <br />
            <button className="btn" style={{ marginTop: 14 }} onClick={() => setPalette({})}>Add step <span className="kbd">⌘K</span></button>
          </div>
        )}
        {scenario.steps.map((step, i) => {
          const r = result.steps.find((x) => x.id === step.id);
          return (
            <StepRow
              key={step.id}
              index={i}
              step={step}
              r={r}
              batch={batch}
              bottleneck={step.id === t.bottleneckId && opResults.length > 1}
              open={!!open[step.id]}
              toggle={() => setOpen((o) => ({ ...o, [step.id]: !o[step.id] }))}
              onChange={(p) => setStep(step.id, p)}
              onRemove={() => set((s) => ({ ...s, steps: s.steps.filter((x) => x.id !== step.id) }))}
              onMove={(d) => move(step.id, d)}
              onSwap={() => setPalette({ replace: step.id })}
              first={i === 0}
              last={i === scenario.steps.length - 1}
            />
          );
        })}
      </div>
      {scenario.steps.length > 0 && (
        <div className="add-row">
          <button className="btn" onClick={() => setPalette({})}>Add step <span className="kbd">⌘K</span></button>
          <button className="btn ghost" onClick={() => setOpen(Object.fromEntries(scenario.steps.map((s) => [s.id, !Object.values(open).some(Boolean)])))}>
            {Object.values(open).some(Boolean) ? 'Hide the math' : 'Show the math'}
          </button>
        </div>
      )}

      <section className="breakdown">
        <div>
          <div className="section-head" style={{ marginTop: 0 }}><h3>Cost breakdown{batch ? '' : ' per month'}</h3></div>
          <div className="kv">
            {result.steps.flatMap((s) => s.costs.map((c, j) => (
              <FragmentKV key={`${s.id}${j}`} k={`${c.label}`} v={formatMoney(c.usd)} title={c.formula} />
            )))}
            <span className="k total">Total</span>
            <span className="v total t-money">{formatMoney(t.costUsd)}</span>
          </div>
        </div>
        <div>
          <div className="section-head" style={{ marginTop: 0 }}><h3>Assumptions</h3></div>
          <div className="note" style={{ display: 'grid', gap: 8 }}>
            <span>Numbers are the README’s, rounded for memorization. Edit them under <a href="#" onClick={(e) => (e.preventDefault(), setState((s) => ({ ...s, view: 'reference' })))}>Reference</a>; edits apply everywhere.</span>
            {batch ? (
              <span>Each step takes max(bytes ÷ throughput, requests × latency ÷ in flight). Overlapped time assumes the steps stream into each other, so the slowest one sets the pace.</span>
            ) : (
              <span>Latency adds up along the path; capacity comes from demand ÷ per-unit throughput and Little’s law (in flight = rate × latency). Storage is steady state after the retention period.</span>
            )}
            <span>Compute is the machine you rent while a step runs: vCPUs × the shape’s $/vCPU/month ÷ 2.6M s, the same way the README prices reading 1 TiB.</span>
            {overlay && (
              <details>
                <summary style={{ cursor: 'pointer', color: 'var(--muted)' }}>
                  Priced with {PROVIDER_LABEL[source!.provider]} {source!.region}
                  {sourceEstimated ? ' (curated estimates)' : ` list prices, fetched ${new Date(sourceDs!.fetchedAt).toLocaleDateString()}`}
                </summary>
                <div className="kv" style={{ marginTop: 8 }}>
                  {overlay.mapped.map((m) => (
                    <FragmentKV key={m.what} k={m.what} v={m.value} title={m.from} />
                  ))}
                </div>
              </details>
            )}
          </div>
        </div>
      </section>

      {palette && (
        <Palette
          items={PALETTE_ITEMS}
          placeholder={palette.replace ? 'Replace this step with…' : 'Add a step: try “ssd random”, “compress”, “cross-zone”…'}
          onPick={pick}
          onClose={() => setPalette(null)}
        />
      )}
    </div>
  );
}

function computeVcpus(steps: StepResult[]) {
  return steps.reduce((a, s) => a + s.vcpus, 0);
}

function FragmentKV({ k, v, title }: { k: string; v: string; title?: string }) {
  return (
    <>
      <span className="k" title={title}>{k}</span>
      <span className="v" title={title}>{v}</span>
    </>
  );
}

function Metric({ label, value, sub, napkinV, unit, cls }: { label: string; value: string; sub: string; napkinV: number; unit: string; cls: string }) {
  return (
    <div className="result">
      <div className="result-label">{label}</div>
      <div className={`result-value ${cls}`}>{value}</div>
      <div className="result-sub">
        <NapkinForm value={napkinV} unit={unit} /> {sub && <span> · {sub}</span>}
      </div>
    </div>
  );
}

function AutoTextarea({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight}px`;
    }
  }, [value]);
  return <textarea ref={ref} rows={1} className="desc-input" aria-label="Scenario description" placeholder="What are you estimating?" value={value} onChange={(e) => onChange(e.target.value)} />;
}

function StepRow({
  step, r, index, batch, bottleneck, open, toggle, onChange, onRemove, onMove, onSwap, first, last,
}: {
  step: Step;
  r?: StepResult;
  index: number;
  batch: boolean;
  bottleneck: boolean;
  open: boolean;
  toggle: () => void;
  onChange: (p: Partial<OpStep> | Partial<StoreStep>) => void;
  onRemove: () => void;
  onMove: (d: -1 | 1) => void;
  onSwap: () => void;
  first: boolean;
  last: boolean;
}) {
  const actions = (
    <div className="step-actions">
      <button className="icon-btn" aria-label="Move up" disabled={first} onClick={() => onMove(-1)}>↑</button>
      <button className="icon-btn" aria-label="Move down" disabled={last} onClick={() => onMove(1)}>↓</button>
      <button className="icon-btn" aria-label="Replace step" title="Replace with another operation" onClick={onSwap}>⇄</button>
      <button className="icon-btn" aria-label="Remove step" onClick={onRemove}>✕</button>
    </div>
  );

  if (step.kind === 'store') {
    return (
      <div className="step">
        <div className="step-n">{index + 1}</div>
        <div>
          <div className="step-title">
            <button className="name" onClick={toggle} aria-expanded={open}>Keep at rest</button>
            <span className="step-cat">Storage</span>
          </div>
          {r && <div className="step-flow">holds <span className="t-data">{formatBytes(r.inBytes)}</span>{batch ? '' : ' per request'}</div>}
          <div className="chips">
            <label className="chip">
              in
              <select className="plain" value={step.costId} onChange={(e) => onChange({ costId: e.target.value })}>
                {STORE_CLASSES.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </label>
            <label className="chip">
              for
              <Quantity kind="number" className="narrow" label="Retention in months" value={step.months} min={0} onChange={(n) => n != null && onChange({ months: n })} />
              months
            </label>
            <label className="chip">
              ×
              <Quantity kind="number" className="narrow" label="Replicas" value={step.replicas} min={1} onChange={(n) => n && onChange({ replicas: Math.round(n) })} />
              copies
            </label>
          </div>
        </div>
        {actions}
        <div className="step-metrics">
          <span className="metric-cost">{r ? formatMoney(r.costUsd) : '—'}{batch ? '' : '/mo'}</span>
          <span className="metric-sub">{batch ? `for ${step.months} mo` : 'steady state'}</span>
        </div>
        {open && r && <MathBox r={r} />}
      </div>
    );
  }

  const op = OPS_BY_ID.get(step.opId);
  if (!op) return null;
  const tr = transformOf(op);
  const host = hostOf(op);
  const io = isIoBound(op);
  return (
    <div className={`step ${bottleneck ? 'bottleneck' : ''}`}>
      <div className="step-n" title={bottleneck ? 'Bottleneck' : undefined}>{index + 1}</div>
      <div style={{ minWidth: 0 }}>
        <div className="step-title">
          <button className="name" onClick={toggle} aria-expanded={open} title="Show the math">{shortName(op)}</button>
          <span className="step-cat">{CATEGORY_LABEL[op.category]}{op.scope ? ` · row measured ${op.scope}` : ''}</span>
        </div>
        {r && (
          <div className="step-flow">
            <span className="t-data">{formatBytes(r.inBytes)}</span>
            {tr ? <> → <span className="t-data">{formatBytes(r.outBytes)}</span></> : null}
            {batch ? ` · ${formatCount(r.requests)} × ${formatBytes(r.ioBytes)} requests` : ` · ${formatCount(r.requests)} ops/s`}
          </div>
        )}
        <div className="chips">
          {(op.throughputBps || io) && (
            <label className="chip" title={io ? 'Requests in flight at once (queue depth × threads). README benchmarks use 32.' : 'Threads; 1-thread CPU rows scale with cores until memory bandwidth runs out.'}>
              <Quantity kind="count" className="narrow" label={parallelismLabel(op)} value={step.parallelism} min={1} onChange={(n) => n && onChange({ parallelism: Math.max(1, Math.round(n)) })} />
              {parallelismLabel(op)}
            </label>
          )}
          <label className={`chip ${step.ioBytes ? 'overridden' : ''}`} title="Size of each request / IO. Bigger requests amortize latency.">
            IO
            <Quantity kind="bytes" label="Request size" nullable value={step.ioBytes ?? r?.ioBytes ?? op.blockBytes ?? 1024} min={1} onChange={(n) => onChange({ ioBytes: n })} />
          </label>
          {tr && (
            <label className="chip overridden" title={`${tr.kind === 'compress' ? 'Compression' : 'Expansion'} ratio. Logs 6–30x, JSON 5–13x, HTML 4–8x, already compressed 1x.`}>
              ratio
              <Quantity kind="number" className="narrow" label="Compression ratio" value={step.ratio ?? tr.defaultRatio} min={1} onChange={(n) => n && onChange({ ratio: n })} />×
            </label>
          )}
          <label className={`chip ${step.latencyNs != null ? 'overridden' : ''}`} title="Latency for this step only (empty = reference value)">
            latency
            <Quantity kind="duration" label="Latency override" nullable value={step.latencyNs ?? op.latencyNs ?? null} placeholder="—" onChange={(n) => onChange({ latencyNs: n === op.latencyNs ? null : n })} />
          </label>
          {op.throughputBps != null && (
            <label className={`chip ${step.throughputBps != null ? 'overridden' : ''}`} title="Throughput for this step only (empty = reference value)">
              <Quantity kind="rate" className="wide" label="Throughput override" nullable value={step.throughputBps ?? op.throughputBps} onChange={(n) => onChange({ throughputBps: n === op.throughputBps ? null : n })} />
              {op.scalesWithThreads ? 'per thread' : ''}
            </label>
          )}
          {op.plusRtt && (
            <label className="chip" title="These rows leave out the network round trip; add yours.">
              + RTT
              <Quantity kind="duration" label="Round trip" value={step.rttNs ?? 100e3} onChange={(n) => n != null && onChange({ rttNs: n })} />
            </label>
          )}
          <label className={`chip ${step.share != null && step.share < 1 ? 'overridden' : ''}`} title="Share of traffic that reaches this step, e.g. 5% for a 95% cache hit ratio">
            <Quantity kind="percent" className="narrow" label="Share of traffic" value={step.share ?? 1} onChange={(n) => n != null && onChange({ share: Math.min(1, Math.max(0, n)) })} />
            of traffic
          </label>
          {host.vcpus !== 0 && (
            <label className={`chip ${step.hostVcpus != null ? 'overridden' : ''}`} title={`Machine rented while this runs. Default: ${host.why}.`}>
              host
              <Quantity kind="number" className="narrow" label="Host vCPUs" nullable value={step.hostVcpus ?? (r && batch ? r.vcpus : null)} min={0} onChange={(n) => onChange({ hostVcpus: n })} />
              vCPU
            </label>
          )}
        </div>
      </div>
      {actions}
      {r && (
        <div className="step-metrics">
          <span className="metric-time">{formatDuration(batch ? r.timeNs : r.requestLatencyNs)}</span>
          {batch && r.bound !== 'none' && <span className={`bound ${r.bound}`}>{r.bound === 'throughput' ? 'throughput-bound' : 'latency-bound'}</span>}
          {!batch && <span className="metric-sub">{sig(r.unitsNeeded)} {r.unitLabel} busy</span>}
          <span className="metric-cost">{formatMoney(r.costUsd)}{batch ? '' : '/mo'}</span>
        </div>
      )}
      {open && r && <MathBox r={r} why={host.why} />}
    </div>
  );
}


function MathBox({ r, why }: { r: StepResult; why?: string }) {
  return (
    <div className="math">
      {r.math.map((m, i) => (
        <div className="line" key={i}>{m}</div>
      ))}
      {r.costs.map((c, i) => (
        <div className="line cost-line" key={`c${i}`}>{c.label}: {c.formula}</div>
      ))}
      {r.warnings.map((w, i) => (
        <div className="warn" key={`w${i}`}>{w}</div>
      ))}
      {why && <div className="why">Host: {why}.</div>}
    </div>
  );
}
