import { useEffect, useState } from 'react';
import { fromHash, setState, useAppState, type View } from './lib/store.ts';
import { ScenarioView } from './views/Scenario.tsx';
import { ReferenceView } from './views/Reference.tsx';
import { CloudView } from './views/Cloud.tsx';
import { HomelabView } from './views/Homelab.tsx';
import { newId } from './lib/engine.ts';
import { REFERENCE_META } from './lib/reference.ts';
import { KiB, GiB } from './lib/units.ts';
import type { Scenario } from './lib/presets.ts';

const VIEWS: { id: View; label: string }[] = [
  { id: 'reference', label: 'Reference numbers' },
  { id: 'cloud', label: 'Cloud prices' },
  { id: 'homelab', label: 'My homelab' },
];

type Theme = 'light' | 'dark' | 'system';

function readTheme(): Theme {
  try {
    const t = localStorage.getItem('tp-theme');
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    return 'system';
  }
}

export function App() {
  const app = useAppState();
  const [theme, setTheme] = useState<Theme>(readTheme);
  const isDark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    if (theme === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    try {
      if (theme === 'system') localStorage.removeItem('tp-theme');
      else localStorage.setItem('tp-theme', theme);
    } catch {
      /* private mode: lasts for this page only */
    }
  }, [theme]);
  const active = app.scenarios.find((s) => s.id === app.activeId) ?? app.scenarios[0];

  // Keep the view in the URL hash so reload / back work.
  useEffect(() => {
    const onHash = () => setState((s) => fromHash(s, location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => {
    const want = app.view === 'scenarios' ? `#s/${app.activeId}` : app.view === 'cloud' ? `#cloud/${app.cloudTab}` : `#${app.view}`;
    if (location.hash !== want) history.replaceState(null, '', want);
  }, [app.view, app.activeId, app.cloudTab]);

  const go = (view: View, activeId?: string) => setState((s) => ({ ...s, view, activeId: activeId ?? s.activeId }));

  const create = () => {
    const sc: Scenario = {
      id: newId(),
      name: 'Untitled estimate',
      description: '',
      workload: { mode: 'batch', totalBytes: GiB, rps: 1000, requestBytes: 4 * KiB, tier: 'monthly' },
      steps: [],
    };
    setState((s) => ({ ...s, scenarios: [...s.scenarios, sc], activeId: sc.id, view: 'scenarios' }));
  };
  const duplicate = () => {
    if (!active) return;
    const sc: Scenario = { ...JSON.parse(JSON.stringify(active)), id: newId(), name: `${active.name} (copy)`, preset: false };
    setState((s) => ({ ...s, scenarios: [...s.scenarios, sc], activeId: sc.id, view: 'scenarios' }));
  };
  const remove = (id: string) => {
    setState((s) => {
      const scenarios = s.scenarios.filter((x) => x.id !== id);
      return { ...s, scenarios, activeId: scenarios[0]?.id ?? '' };
    });
  };

  const presets = app.scenarios.filter((s) => s.preset);
  const mine = app.scenarios.filter((s) => !s.preset);

  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">
          <img className="brand-logo" src="/logo.svg" alt="" />
          <span className="brand-name">Napkin Math</span>
          <button
            className="icon-btn theme-btn"
            aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
            title={isDark ? 'Light mode' : 'Dark mode'}
            onClick={() => setTheme(isDark ? 'light' : 'dark')}
          >
            {isDark ? '☀' : '☾'}
          </button>
        </div>

        <nav className="nav" aria-label="Your estimates">
          <div className="nav-head">
            <span>Your estimates</span>
            <span>
              {app.view === 'scenarios' && active && <button className="icon-btn" aria-label="Duplicate current estimate" title="Duplicate current estimate" onClick={duplicate}>⧉</button>}
              <button className="icon-btn" aria-label="New estimate" title="New estimate" onClick={create}>+</button>
            </span>
          </div>
          {mine.length === 0 && <div className="nav-head" style={{ paddingBottom: 0 }}><span>Start one with +, or duplicate a preset.</span></div>}
          {mine.map((s) => (
            <ScenarioLink key={s.id} s={s} current={app.view === 'scenarios' && s.id === active?.id} onClick={() => go('scenarios', s.id)} onRemove={() => remove(s.id)} />
          ))}
        </nav>

        <nav className="nav" aria-label="Presets">
          <div className="nav-head"><span>Presets</span></div>
          {presets.map((s) => (
            <ScenarioLink key={s.id} s={s} current={app.view === 'scenarios' && s.id === active?.id} onClick={() => go('scenarios', s.id)} />
          ))}
        </nav>

        <nav className="nav" aria-label="Data">
          <div className="nav-head"><span>Data</span></div>
          {VIEWS.map((v) => (
            <button key={v.id} className="nav-item" aria-current={app.view === v.id} onClick={() => go(v.id)}>
              <span className="dot" />
              <span className="label">{v.label}</span>
            </button>
          ))}
        </nav>

        <div className="side-foot">
          <span>Numbers from <a href={REFERENCE_META.source} target="_blank" rel="noreferrer">sirupsen/napkin-math</a>{REFERENCE_META.measured ? `, ${REFERENCE_META.measured}` : ''}.</span>
          <span><span className="kbd">⌘K</span> adds a step · <span className="kbd">↑↓</span> in a field doubles or halves</span>
        </div>
      </aside>

      <main className="main">
        {app.view === 'reference' ? <ReferenceView /> : app.view === 'cloud' ? <CloudView /> : app.view === 'homelab' ? <HomelabView /> : active ? <ScenarioView key={active.id} scenario={active} /> : (
          <div className="page"><div className="empty">No estimates yet. <button className="btn" onClick={create}>New estimate</button></div></div>
        )}
      </main>
    </div>
  );
}

function ScenarioLink({ s, current, onClick, onRemove }: { s: Scenario; current: boolean; onClick: () => void; onRemove?: () => void }) {
  return (
    <div style={{ position: 'relative' }}>
      <button className="nav-item" aria-current={current} onClick={onClick} title={s.description}>
        <span className={`dot ${s.workload.mode === 'stream' ? 'stream' : ''}`} />
        <span className="label">{s.name}</span>
      </button>
      {onRemove && current && (
        <button className="icon-btn" style={{ position: 'absolute', right: 4, top: 5 }} aria-label={`Delete ${s.name}`} title="Delete" onClick={onRemove}>✕</button>
      )}
    </div>
  );
}
