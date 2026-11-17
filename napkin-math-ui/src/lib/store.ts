// Tiny persisted app state (localStorage). Everything the user edits lives here.
import { useSyncExternalStore } from 'react';
import type { Overrides } from './engine.ts';
import type { Provider } from './schema.ts';
import { PRESETS, type Scenario } from './presets.ts';

export type View = 'scenarios' | 'reference' | 'cloud' | 'homelab';

export interface AppState {
  scenarios: Scenario[];
  activeId: string;
  overrides: Overrides;
  priceSource: { provider: Provider; region: string } | null;
  view: View;
  cloudTab: 'vm' | 'throughput' | 'prices' | 'sources';
}

const KEY = 'napkin-math-ui/v1';
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

function initial(): AppState {
  const fresh: AppState = { scenarios: clone(PRESETS), activeId: PRESETS[0].id, overrides: {}, priceSource: null, view: 'scenarios', cloudTab: 'vm' };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return fresh;
    const s = JSON.parse(raw) as AppState;
    // Pick up presets added since the user last visited.
    const have = new Set(s.scenarios.map((x) => x.id));
    for (const p of PRESETS) if (!have.has(p.id)) s.scenarios.push(clone(p));
    return { ...fresh, ...s };
  } catch {
    return fresh;
  }
}

/** Apply a URL hash (#s/<id>, #reference, #cloud, #homelab) to the state. */
export function fromHash(s: AppState, hash: string): AppState {
  const h = decodeURIComponent(hash.replace(/^#/, ''));
  if (h.startsWith('s/')) return s.scenarios.some((x) => x.id === h.slice(2)) ? { ...s, view: 'scenarios', activeId: h.slice(2) } : s;
  if (h === 'reference' || h === 'cloud' || h === 'homelab') return { ...s, view: h };
  const tab = h.match(/^cloud\/(vm|throughput|prices|sources)$/)?.[1] as AppState['cloudTab'] | undefined;
  if (tab) return { ...s, view: 'cloud', cloudTab: tab };
  return s;
}

let state: AppState = fromHash(initial(), typeof location !== 'undefined' ? location.hash : '');
const listeners = new Set<() => void>();
let saveTimer: ReturnType<typeof setTimeout> | undefined;

export function setState(fn: (s: AppState) => AppState) {
  state = fn(state);
  listeners.forEach((l) => l());
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      /* storage unavailable: keep working in memory */
    }
  }, 150);
}

export function useAppState(): AppState {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => state,
  );
}

export function updateScenario(id: string, fn: (s: Scenario) => Scenario) {
  setState((s) => ({ ...s, scenarios: s.scenarios.map((x) => (x.id === id ? fn(x) : x)) }));
}

export function resetPreset(id: string) {
  const p = PRESETS.find((x) => x.id === id);
  if (p) updateScenario(id, () => clone(p));
}

export function resetAll() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  state = initial();
  listeners.forEach((l) => l());
}
