import { Fragment, useMemo, useState } from 'react';
import { useDatasets } from '../lib/useDatasets.ts';
import { findVms, solveThroughput, monthly, tieredCost, headlineRate, type Datasets, type VmQuery, type ThroughputQuery } from '../lib/cloud.ts';
import { GEO_LABEL, PROVIDER_LABEL, PROVIDERS, type Geo, type Provider } from '../lib/schema.ts';
import { TIER_LABEL, type PricingTier } from '../lib/engine.ts';
import { setState, useAppState, type AppState } from '../lib/store.ts';
import { Quantity } from '../components/Quantity.tsx';
import { formatBytes, formatMoney, formatRate, GB, GiB, MiB, sig } from '../lib/units.ts';

const GEOS: Geo[] = ['us-east', 'us-central', 'us-west', 'europe', 'asia'];

function Prov({ p }: { p: Provider }) {
  return <span className={`prov ${p}`}><i />{PROVIDER_LABEL[p]}</span>;
}
function Est({ on, title }: { on?: boolean; title?: string }) {
  return on ? <span className="est-badge" title={title ?? 'Estimated or derived, not read from the provider’s price list'}>est.</span> : null;
}

function Common({ geo, setGeo, tier, setTier, providers, setProviders }: {
  geo: Geo; setGeo: (g: Geo) => void; tier: PricingTier; setTier: (t: PricingTier) => void; providers: Provider[]; setProviders: (p: Provider[]) => void;
}) {
  return (
    <>
      <label className="field">
        Region
        <select className="plain" value={geo} onChange={(e) => setGeo(e.target.value as Geo)}>
          {GEOS.map((g) => <option key={g} value={g}>{GEO_LABEL[g]}</option>)}
        </select>
      </label>
      <div className="seg" role="group" aria-label="Pricing">
        {(['monthly', 'commit1y', 'spot'] as PricingTier[]).map((k) => (
          <button key={k} aria-pressed={tier === k} onClick={() => setTier(k)}>{TIER_LABEL[k]}</button>
        ))}
      </div>
      <div className="seg" role="group" aria-label="Providers">
        {PROVIDERS.map((p) => (
          <button key={p} aria-pressed={providers.includes(p)} onClick={() => setProviders(providers.includes(p) ? providers.filter((x) => x !== p) : [...providers, p])}>
            {PROVIDER_LABEL[p]}
          </button>
        ))}
      </div>
    </>
  );
}

export function CloudView() {
  const app = useAppState();
  const ds = useDatasets(true);
  const tab = app.cloudTab;
  const setTab = (t: AppState['cloudTab']) => setState((s) => ({ ...s, cloudTab: t }));
  const [geo, setGeo] = useState<Geo>('us-east');
  const [tier, setTier] = useState<PricingTier>('monthly');
  const [providers, setProviders] = useState<Provider[]>([...PROVIDERS]);
  const common = { geo, setGeo, tier, setTier, providers, setProviders };

  return (
    <div className="page">
      <div className="page-head">
        <h1>Cloud prices</h1>
        <p>Current list prices for AWS, Azure and Google Cloud, cached locally. Compare compute, find the cheapest way to hit a throughput target, or price a scenario on one provider.</p>
      </div>
      <div className="tabs" role="tablist">
        {([['vm', 'Find a VM'], ['throughput', 'Throughput solver'], ['prices', 'Storage & network'], ['sources', 'Data sources']] as [AppState['cloudTab'], string][]).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      {!ds ? (
        <p className="muted" style={{ marginTop: 24 }}>Loading the price cache…</p>
      ) : tab === 'vm' ? (
        <VmFinder ds={ds} {...common} />
      ) : tab === 'throughput' ? (
        <ThroughputSolver ds={ds} {...common} />
      ) : tab === 'prices' ? (
        <Prices ds={ds} geo={geo} setGeo={setGeo} />
      ) : (
        <Sources ds={ds} />
      )}
    </div>
  );
}

type CommonProps = { ds: Datasets; geo: Geo; setGeo: (g: Geo) => void; tier: PricingTier; setTier: (t: PricingTier) => void; providers: Provider[]; setProviders: (p: Provider[]) => void };

function VmFinder({ ds, ...c }: CommonProps) {
  const [vcpu, setVcpu] = useState(16);
  const [mem, setMem] = useState(64);
  const [ssd, setSsd] = useState(0);
  const [arch, setArch] = useState<VmQuery['arch']>('any');
  const [fleet, setFleet] = useState(false);
  const [burst, setBurst] = useState(false);
  const q: VmQuery = { vcpu, memoryGiB: mem, localSsdGB: ssd, arch, tier: c.tier, geo: c.geo, providers: c.providers, allowFleet: fleet, includeBurstable: burst };
  const rows = useMemo(() => findVms(ds, q, 60), [ds, vcpu, mem, ssd, arch, c.tier, c.geo, c.providers, fleet, burst]);
  const best = PROVIDERS.map((p) => rows.find((r) => r.sku.provider === p)).filter(Boolean);
  const cheapest = rows[0]?.monthly;

  return (
    <>
      <div className="filters">
        <label className="field">vCPU ≥<Quantity kind="number" className="narrow" label="Minimum vCPU" value={vcpu} min={1} onChange={(n) => n && setVcpu(n)} /></label>
        <label className="field">Memory ≥<Quantity kind="number" className="narrow" label="Minimum memory GiB" value={mem} min={0} onChange={(n) => n != null && setMem(n)} />GiB</label>
        <label className="field">Local SSD ≥<Quantity kind="number" className="narrow" label="Minimum local SSD GB" value={ssd} min={0} onChange={(n) => n != null && setSsd(n)} />GB</label>
        <div className="seg" role="group" aria-label="CPU architecture">
          {(['any', 'x86', 'arm'] as const).map((a) => <button key={a} aria-pressed={arch === a} onClick={() => setArch(a)}>{a === 'any' ? 'Any CPU' : a === 'arm' ? 'Arm' : 'x86'}</button>)}
        </div>
      </div>
      <div className="filters" style={{ marginTop: -4 }}>
        <Common {...c} />
        <button className="pill" aria-pressed={fleet} onClick={() => setFleet(!fleet)} title="Allow several smaller instances to add up to the requirement">Allow N × smaller</button>
        <button className="pill" aria-pressed={burst} onClick={() => setBurst(!burst)}>Include burstable</button>
      </div>

      {best.length > 0 && (
        <div className="results" style={{ gridTemplateColumns: `repeat(${best.length}, minmax(0,1fr))`, marginTop: 8 }}>
          {best.map((b) => (
            <div className="result" key={b!.sku.provider}>
              <div className="result-label"><Prov p={b!.sku.provider} /> cheapest</div>
              <div className="result-value t-money">{formatMoney(b!.monthly)}<span className="faint" style={{ fontSize: 14 }}>/mo</span></div>
              <div className="result-sub">
                {b!.count > 1 ? `${b!.count} × ` : ''}{b!.sku.sku} · {b!.sku.vcpu} vCPU · {sig(b!.sku.memoryGiB)} GiB
                {cheapest && b!.monthly > cheapest * 1.005 ? ` · +${sig((b!.monthly / cheapest - 1) * 100, 2)}%` : ' · cheapest'}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="table-wrap" style={{ marginTop: 24 }}>
        <table className="data">
          <thead>
            <tr><th>Provider</th><th>Instance</th><th>Region</th><th className="r">vCPU</th><th className="r">Memory</th><th className="r">Local SSD</th><th className="r">Network</th><th className="r">$/vCPU·mo</th><th className="r">{TIER_LABEL[c.tier]} $/mo</th></tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={9} className="muted">No single instance fits in {GEO_LABEL[c.geo]}. Try “Allow N × smaller”, a different region or {c.tier === 'spot' ? 'on-demand (not every SKU has spot)' : 'fewer requirements'}.</td></tr>}
            {rows.map((r, i) => (
              <tr key={`${r.sku.provider}${r.sku.region}${r.sku.sku}`} className={i === 0 ? 'best' : ''}>
                <td><Prov p={r.sku.provider} /></td>
                <td className="num">{r.count > 1 ? <span className="t-time">{r.count} × </span> : null}{r.sku.sku} <span className="faint">{r.sku.arch === 'arm' ? 'arm' : ''}</span></td>
                <td className="muted">{r.regionName}</td>
                <td className="r num">{r.sku.vcpu}</td>
                <td className="r num">{sig(r.sku.memoryGiB)} GiB {r.sku.derived?.includes('memoryGiB') && <Est on title="Azure memory derived from series ratio" />}</td>
                <td className="r num muted">{r.sku.localSsdGB ? formatBytes(r.sku.localSsdGB * GB) : '—'} {r.sku.localSsdGB > 0 && r.sku.derived?.includes('localSsdGB') && <Est on title="Azure local disk derived from series ratio" />}</td>
                <td className="r num muted">{r.sku.networkGbps ? `${sig(r.sku.networkGbps)} Gbps` : '—'}</td>
                <td className="r num muted">{formatMoney(r.perVcpu)}</td>
                <td className="r num t-money">{formatMoney(r.monthly)} <Est on={r.sku.estimated} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="note" style={{ marginTop: 14 }}>Linux, list price, 730 hours a month. 1-year is a no-upfront reservation / committed-use discount. Spot is a point-in-time price and isn’t offered for every SKU.</p>
    </>
  );
}

function ThroughputSolver({ ds, ...c }: CommonProps) {
  const [target, setTarget] = useState(10 * GiB);
  const [dataset, setDataset] = useState(10 * 2 ** 40);
  const [hours, setHours] = useState(730);
  const [req, setReq] = useState(8 * MiB);
  const q: ThroughputQuery = { targetBps: target, datasetGB: dataset / GB, hoursPerMonth: hours, objectRequestBytes: req, tier: c.tier, geo: c.geo, providers: c.providers };
  const opts = useMemo(() => solveThroughput(ds, q), [ds, target, dataset, hours, req, c.tier, c.geo, c.providers]);
  const [open, setOpen] = useState<string | null>(null);
  const shown = opts.slice(0, 30);
  const max = Math.max(...shown.map((o) => o.monthly), 1);
  const bestBy = (k: string) => opts.find((o) => o.kind === k);

  return (
    <>
      <div className="filters">
        <label className="field">Read at<Quantity kind="rate" className="wide" label="Target throughput" value={target} min={1} onChange={(n) => n && setTarget(n)} /></label>
        <label className="field">over<Quantity kind="bytes" label="Dataset size" value={dataset} min={1} onChange={(n) => n && setDataset(n)} /></label>
        <label className="field">for<Quantity kind="number" className="narrow" label="Hours per month at that rate" value={hours} min={1} onChange={(n) => n && setHours(Math.min(730, n))} />h/month</label>
        <label className="field">object GETs of<Quantity kind="bytes" label="Object request size" value={req} min={1024} onChange={(n) => n && setReq(n)} /></label>
      </div>
      <div className="filters" style={{ marginTop: -4 }}><Common {...c} /></div>

      <div className="results" style={{ gridTemplateColumns: 'repeat(3, minmax(0,1fr))', marginTop: 8 }}>
        {(['Network disk', 'Local NVMe', 'Object storage'] as const).map((k) => {
          const b = bestBy(k);
          return (
            <div className="result" key={k}>
              <div className="result-label">Cheapest {k.toLowerCase()}</div>
              <div className="result-value t-money">{b ? formatMoney(b.monthly) : '—'}<span className="faint" style={{ fontSize: 14 }}>{b ? '/mo' : ''}</span></div>
              <div className="result-sub">{b ? <><Prov p={b.provider} /> · {b.name} · {b.units}</> : 'No option in this region'}</div>
            </div>
          );
        })}
      </div>

      <div className="table-wrap" style={{ marginTop: 24 }}>
        <table className="data">
          <thead><tr><th>Provider</th><th>How</th><th>Option</th><th>Units</th><th style={{ width: '22%' }} /><th className="r">$/month</th></tr></thead>
          <tbody>
            {shown.map((o, i) => {
              const key = `${o.provider}${o.region}${o.kind}${o.name}`;
              return (
                <Fragment key={key}>
                  <tr className={i === 0 ? 'best' : ''} onClick={() => setOpen(open === key ? null : key)} style={{ cursor: 'pointer' }}>
                    <td><Prov p={o.provider} /> <span className="faint">{o.region}</span></td>
                    <td className="muted">{o.kind}</td>
                    <td>{o.name} <Est on={o.estimated} /></td>
                    <td className="num muted">{o.units}</td>
                    <td style={{ width: '22%' }}><div className="bar-inline" style={{ width: `${Math.max(2, (o.monthly / max) * 100)}%` }} /></td>
                    <td className="r num t-money">{formatMoney(o.monthly)}</td>
                  </tr>
                  {open === key && (
                    <tr>
                      <td colSpan={6}>
                        <div className="kv" style={{ maxWidth: 640 }}>
                          {o.lines.map((l) => <Fragment key={l.label}><span className="k">{l.label}</span><span className="v">{formatMoney(l.usd)}</span></Fragment>)}
                        </div>
                        <ul className="note" style={{ margin: '8px 0 0', paddingLeft: 18 }}>{o.assumptions.map((a) => <li key={a}>{a}</li>)}</ul>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="note" style={{ marginTop: 14 }}>
        Click a row for its breakdown. Network disks are sized to the dataset and provisioned for {formatRate(target)}, plus enough General vCPUs to push the bytes (~40 MB/s per vCPU, from the README). Local NVMe instances run all month
        to hold the data. Object storage pays for GETs and reader vCPUs only for the {hours} hours you read. Single copy, no replication.
      </p>
    </>
  );
}

function Prices({ ds, geo, setGeo }: { ds: Datasets; geo: Geo; setGeo: (g: Geo) => void }) {
  const [tb, setTb] = useState(50 * 2 ** 40);
  const sets = PROVIDERS.map((p) => ds[p]).filter(Boolean) as NonNullable<Datasets[Provider]>[];
  const inGeo = (p: Provider) => new Set(ds[p]?.regions.filter((r) => r.geo === geo).map((r) => r.id));
  const regionName = (p: Provider, id: string) => ds[p]?.regions.find((r) => r.id === id)?.name ?? id;

  return (
    <>
      <div className="filters">
        <label className="field">
          Region
          <select className="plain" value={geo} onChange={(e) => setGeo(e.target.value as Geo)}>
            {GEOS.map((g) => <option key={g} value={g}>{GEO_LABEL[g]}</option>)}
          </select>
        </label>
        <label className="field">Egress per month<Quantity kind="bytes" label="Egress per month" value={tb} min={0} onChange={(n) => n != null && setTb(n)} /></label>
      </div>

      <div className="section-head"><h3>Network</h3></div>
      <table className="data">
        <thead><tr><th>Provider</th><th>Region</th><th className="r">Internet egress / GB</th><th className="r">Your egress</th><th className="r">Cross-zone / GB</th><th className="r">Inter-region / GB</th></tr></thead>
        <tbody>
          {sets.flatMap((d) => d.regions.filter((r) => r.geo === geo).map((r) => {
            const n = (k: string) => d.network.find((x) => x.region === r.id && x.kind === k);
            const eg = n('internet-egress');
            return (
              <tr key={d.provider + r.id}>
                <td><Prov p={d.provider} /></td>
                <td className="muted">{r.name}</td>
                <td className="r num">{eg ? formatMoney(headlineRate(eg.tiers)) : '—'} <Est on={eg?.estimated} /></td>
                <td className="r num t-money">{eg ? formatMoney(tieredCost(eg.tiers, tb / GB)) : '—'}</td>
                <td className="r num">{n('cross-zone') ? formatMoney(headlineRate(n('cross-zone')!.tiers)) : '—'}</td>
                <td className="r num" title={n('inter-region')?.name}>{n('inter-region') ? formatMoney(headlineRate(n('inter-region')!.tiers)) : '—'}</td>
              </tr>
            );
          }))}
        </tbody>
      </table>
      <p className="note" style={{ marginTop: 8 }}>“Your egress” applies each provider’s volume tiers to {formatBytes(tb)}/month, including free allowances.</p>

      <div className="section-head"><h3>Block storage (network disks)</h3></div>
      <div className="table-wrap">
        <table className="data">
          <thead><tr><th>Provider</th><th>Disk</th><th className="r">$/GB·mo</th><th className="r">$/IOPS·mo</th><th className="r">$/MiB/s·mo</th><th className="r">Included</th><th className="r">Max per volume</th></tr></thead>
          <tbody>
            {sets.flatMap((d) => d.blockStorage.filter((b) => inGeo(d.provider).has(b.region)).map((b) => (
              <tr key={d.provider + b.region + b.id}>
                <td><Prov p={d.provider} /> <span className="faint">{b.region}</span></td>
                <td>{b.name} <span className="faint">{b.media.toUpperCase() === 'HDD' ? 'HDD' : ''}</span> <Est on={b.estimated} /></td>
                <td className="r num">{formatMoney(b.perGBMonth)}</td>
                <td className="r num muted">{b.perIopsMonth != null ? formatMoney(b.perIopsMonth) : '—'}</td>
                <td className="r num muted">{b.perMiBpsMonth != null ? formatMoney(b.perMiBpsMonth) : '—'}</td>
                <td className="r num muted">{b.includedIops.toLocaleString()} IOPS · {b.includedMiBps} MiB/s</td>
                <td className="r num muted">{b.maxIops.toLocaleString()} IOPS · {b.maxMiBps.toLocaleString()} MiB/s</td>
              </tr>
            )))}
          </tbody>
        </table>
      </div>

      <div className="section-head"><h3>Object storage</h3></div>
      <table className="data">
        <thead><tr><th>Provider</th><th>Class</th><th>Region</th><th className="r">$/GB·mo</th><th className="r">GET / 1M</th><th className="r">PUT / 1M</th><th className="r">Retrieval / GB</th></tr></thead>
        <tbody>
          {sets.flatMap((d) => d.objectStorage.filter((o) => inGeo(d.provider).has(o.region)).map((o) => (
            <tr key={d.provider + o.region + o.id}>
              <td><Prov p={d.provider} /></td>
              <td>{o.name} <Est on={o.estimated} /></td>
              <td className="muted">{regionName(d.provider, o.region)}</td>
              <td className="r num">{formatMoney(o.perGBMonth)}</td>
              <td className="r num muted">{formatMoney(o.perMillionReads)}</td>
              <td className="r num muted">{formatMoney(o.perMillionWrites)}</td>
              <td className="r num muted">{o.retrievalPerGB ? formatMoney(o.retrievalPerGB) : '—'}</td>
            </tr>
          )))}
        </tbody>
      </table>
    </>
  );
}

function Sources({ ds }: { ds: Datasets }) {
  return (
    <div style={{ marginTop: 16 }}>
      {PROVIDERS.map((p) => {
        const d = ds[p];
        if (!d) return (
          <div className="source-card" key={p}><h3><Prov p={p} /></h3><p className="muted">No cache yet. Run <code>npm run fetch:{p}</code>.</p></div>
        );
        const od = d.compute.filter((c) => monthly(c, 'monthly') != null).length;
        return (
          <div className="source-card" key={p}>
            <h3><Prov p={p} /> {d.mode === 'live' ? <span className="live-badge">official API</span> : <span className="est-badge">curated snapshot</span>}</h3>
            <div className="muted" style={{ fontSize: 13 }}>
              Fetched {new Date(d.fetchedAt).toLocaleString()} · {od.toLocaleString()} compute SKUs, {d.blockStorage.length} disk prices, {d.objectStorage.length} object classes across {d.regions.length} regions
            </div>
            <ul>
              {d.sources.map((s) => <li key={s.url}><a href={s.url} target="_blank" rel="noreferrer">{s.name}</a></li>)}
              {d.notes.map((n) => <li key={n}>{n}</li>)}
            </ul>
          </div>
        );
      })}
      <div className="source-card">
        <h3>Refreshing</h3>
        <ul>
          <li><code>npm run fetch:prices</code> refreshes all three into <code>data/cloud/</code>, then reload. AWS streams ~300 MB per region; expect about a minute.</li>
          <li><code>GCP_API_KEY=… npm run fetch:gcp</code> replaces the Google Cloud snapshot with the Cloud Billing Catalog.</li>
          <li>Prices are list prices before discounts, taxes and support plans. Regions are grouped by geography so the three clouds line up.</li>
        </ul>
      </div>
    </div>
  );
}
