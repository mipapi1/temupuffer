import { useMemo, useState } from 'react';
import { OPERATIONS, COSTS, SHAPES, BLOB_REQUESTS, COMPRESSION, ENCODINGS, TECHNIQUES, READ_COST, REFERENCE_META, CATEGORY_LABEL, type Category } from '../lib/reference.ts';
import type { Overrides } from '../lib/engine.ts';
import { setState, useAppState } from '../lib/store.ts';
import { Quantity } from '../components/Quantity.tsx';
import { formatMoney } from '../lib/units.ts';

type Tab = 'ops' | 'costs' | 'shapes' | 'compression' | 'techniques';

function patch<K extends keyof Overrides>(key: K, id: string, field: string, value: number | null) {
  setState((s) => {
    const section = { ...(s.overrides[key] ?? {}) } as Record<string, Record<string, number | null>>;
    const row = { ...(section[id] ?? {}) };
    if (value == null) delete row[field];
    else row[field] = value;
    if (Object.keys(row).length) section[id] = row;
    else delete section[id];
    return { ...s, overrides: { ...s.overrides, [key]: section } };
  });
}

export function ReferenceView() {
  const { overrides } = useAppState();
  const [tab, setTab] = useState<Tab>('ops');
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<Category | 'all'>('all');
  const edits = Object.values(overrides).reduce((a, sec) => a + Object.keys(sec ?? {}).length, 0);

  const ops = useMemo(
    () => OPERATIONS.filter((o) => (cat === 'all' || o.category === cat) && o.name.toLowerCase().includes(q.toLowerCase())),
    [q, cat],
  );
  const cats = [...new Set(OPERATIONS.map((o) => o.category))];

  return (
    <div className="page">
      <div className="page-head">
        <h1>Reference numbers</h1>
        <p>
          From <a href={REFERENCE_META.source} target="_blank" rel="noreferrer">sirupsen/napkin-math</a>
          {REFERENCE_META.measured ? `, measured ${REFERENCE_META.measured}` : ''}. Rounded for memorization, not faux precision. Edit any number to
          change it in every scenario.
          {edits > 0 && (
            <>
              {' '}
              <button className="reset" style={{ fontSize: 14, color: 'var(--time)' }} onClick={() => setState((s) => ({ ...s, overrides: {} }))}>
                Reset {edits} edited row{edits > 1 ? 's' : ''}
              </button>
            </>
          )}
        </p>
      </div>
      <div className="tabs" role="tablist">
        {([['ops', 'Latency & throughput'], ['costs', 'Cost numbers'], ['shapes', 'Instance shapes'], ['compression', 'Compression'], ['techniques', 'Techniques']] as [Tab, string][]).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>

      {tab === 'ops' && (
        <>
          <div className="filters">
            <input className="search" placeholder="Filter operations" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter operations" />
            <button className="pill" aria-pressed={cat === 'all'} onClick={() => setCat('all')}>All</button>
            {cats.map((c) => (
              <button key={c} className="pill" aria-pressed={cat === c} onClick={() => setCat(c)}>{CATEGORY_LABEL[c]}</button>
            ))}
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>Operation</th><th>Category</th><th className="r">Latency</th><th className="r">Throughput</th><th /></tr>
              </thead>
              <tbody>
                {ops.map((o) => {
                  const ov = overrides.ops?.[o.id];
                  return (
                    <tr key={o.id}>
                      <td>
                        {o.name}
                        {o.synthetic && <span className="faint"> · priced, not benchmarked</span>}
                      </td>
                      <td className="muted">{CATEGORY_LABEL[o.category]}</td>
                      <td className="r">
                        <Quantity kind="duration" label={`${o.name} latency`} nullable className={ov?.latencyNs != null ? 'edited' : ''} value={ov?.latencyNs ?? o.latencyNs} onChange={(n) => patch('ops', o.id, 'latencyNs', n === o.latencyNs ? null : n)} />
                      </td>
                      <td className="r">
                        <Quantity kind="rate" label={`${o.name} throughput`} nullable className={`wide ${ov?.throughputBps != null ? 'edited' : ''}`} value={ov?.throughputBps ?? o.throughputBps} onChange={(n) => patch('ops', o.id, 'throughputBps', n === o.throughputBps ? null : n)} />
                      </td>
                      <td>{ov && <button className="reset" onClick={() => setState((s) => { const x = { ...(s.overrides.ops ?? {}) }; delete x[o.id]; return { ...s, overrides: { ...s.overrides, ops: x } }; })}>reset</button>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="note" style={{ marginTop: 16 }}>
            Latency is one request at a time at the size in parentheses. Throughput is the most measured at any size and any number in flight. Rows marked 1 thread
            scale with cores until memory bandwidth runs out (on x86 a vCPU is half a core). +1 RTT rows leave out the network round trip.
          </p>
        </>
      )}

      {tab === 'costs' && (
        <div className="grid-2" style={{ marginTop: 20 }}>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>What</th><th>Per</th><th className="r">$/month</th><th className="r">1-year</th><th className="r">Spot</th></tr></thead>
              <tbody>
                {COSTS.map((c) => {
                  const ov = overrides.costs?.[c.id] ?? {};
                  const cell = (f: 'monthly' | 'commit1y' | 'spot') => (
                    <td className="r">
                      {c[f] != null || ov[f] != null ? (
                        <Quantity kind="money" label={`${c.name} ${f}`} nullable className={`narrow ${ov[f] != null ? 'edited' : ''}`} value={ov[f] ?? c[f]} onChange={(n) => patch('costs', c.id, f, n === c[f] ? null : n)} />
                      ) : <span className="faint">—</span>}
                    </td>
                  );
                  return (
                    <tr key={c.id}>
                      <td>{c.group ? <span className="faint">{c.group} · </span> : null}{c.name}</td>
                      <td className="muted num">{c.amount}</td>
                      {cell('monthly')}{cell('commit1y')}{cell('spot')}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div>
            <table className="data">
              <thead><tr><th>Blob requests</th><th className="r">Regional, 1M</th><th className="r">Zonal, 1M</th></tr></thead>
              <tbody>
                {BLOB_REQUESTS.map((b) => {
                  const ov = overrides.blob?.[b.id] ?? {};
                  return (
                    <tr key={b.id}>
                      <td>{b.name}</td>
                      <td className="r"><Quantity kind="money" label={`${b.name} regional`} className={`narrow ${ov.regionalPerMillion != null ? 'edited' : ''}`} value={ov.regionalPerMillion ?? b.regionalPerMillion} onChange={(n) => patch('blob', b.id, 'regionalPerMillion', n === b.regionalPerMillion ? null : n)} /></td>
                      <td className="r"><Quantity kind="money" label={`${b.name} zonal`} className={`narrow ${ov.zonalPerMillion != null ? 'edited' : ''}`} value={ov.zonalPerMillion ?? b.zonalPerMillion} onChange={(n) => patch('blob', b.id, 'zonalPerMillion', n === b.zonalPerMillion ? null : n)} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="section-head"><h3>Reading 1 TiB costs (README)</h3></div>
            <table className="data">
              <thead><tr><th>What</th><th className="r">$/TiB</th><th className="r">1-year</th><th className="r">Spot</th></tr></thead>
              <tbody>
                {READ_COST.map((r) => (
                  <tr key={r.name}><td>{r.name}</td><td className="r num">{formatMoney(r.perTiB)}</td><td className="r num muted">{formatMoney(r.commit1y)}</td><td className="r num muted">{formatMoney(r.spot)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'shapes' && (
        <div className="table-wrap" style={{ marginTop: 20 }}>
          <table className="data">
            <thead>
              <tr><th>Shape</th><th className="r">Memory / vCPU</th><th className="r">SSD / vCPU</th><th className="r">HDD / vCPU</th><th className="r">Network GB/s</th><th className="r">$/vCPU·mo</th><th className="r">1-year</th><th className="r">Spot</th><th className="r">Max vCPU</th></tr>
            </thead>
            <tbody>
              {SHAPES.map((s) => {
                const ov = overrides.shapes?.[s.id] ?? {};
                const cell = (f: 'monthlyPerVcpu' | 'commit1yPerVcpu' | 'spotPerVcpu') => (
                  <td className="r"><Quantity kind="money" label={`${s.name} ${f}`} className={`narrow ${ov[f] != null ? 'edited' : ''}`} value={ov[f] ?? s[f]} onChange={(n) => patch('shapes', s.id, f, n === s[f] ? null : n)} /></td>
                );
                return (
                  <tr key={s.id}>
                    <td>{s.name}</td>
                    <td className="r num">{s.memoryGiB} GiB</td>
                    <td className="r num muted">{s.ssdGB ? `${s.ssdGB} GB` : '—'}</td>
                    <td className="r num muted">{s.hddGB ? `${s.hddGB} GB` : '—'}</td>
                    <td className="r num muted">{s.networkGBps}</td>
                    {cell('monthlyPerVcpu')}{cell('commit1yPerVcpu')}{cell('spotPerVcpu')}
                    <td className="r num muted">{s.maxVcpu}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="note" style={{ marginTop: 16 }}>Per vCPU, averaged over AWS and GCP at list price in their cheapest US region. Scenarios rent these shapes while a step runs.</p>
        </div>
      )}

      {tab === 'compression' && (
        <div className="grid-2" style={{ marginTop: 20 }}>
          <table className="data">
            <thead><tr><th>Data</th><th className="r">Ratio (lz4 → zstd -19)</th></tr></thead>
            <tbody>{COMPRESSION.map((c) => <tr key={c.id}><td>{c.name}</td><td className="r num">{c.low === c.high ? `${c.low}x` : `${c.low}–${c.high}x`}</td></tr>)}</tbody>
          </table>
          <div>
            <table className="data">
              <thead><tr><th>Structured</th><th>Encoding</th><th className="r">Ratio</th></tr></thead>
              <tbody>{ENCODINGS.map((c) => <tr key={c.id}><td>{c.name}</td><td className="muted">{c.encoding}</td><td className="r num">{c.ratio}</td></tr>)}</tbody>
            </table>
            <p className="note" style={{ marginTop: 16 }}>Rule of thumb: each extra 1x of compression ratio costs ~10x in speed. lz4 gets 2x at ~500 MiB/s, zstd -9 3.5x at ~50 MiB/s, zstd -19 4x at ~3 MiB/s.</p>
          </div>
        </div>
      )}

      {tab === 'techniques' && (
        <div className="prose" style={{ marginTop: 8 }}>
          {TECHNIQUES.map((t) => (
            <div key={t.title}>
              <h4>{t.title}</h4>
              <p>{t.body.replace(/`/g, '')}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
