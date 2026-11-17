import { useEffect, useState } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Activity, Database, HardDrive, KeyRound, Moon, Search, Sun } from "lucide-react";
import { api, getApiKey, getBackend, getBackends, setApiKey, setBackend } from "./api";
import { Button } from "./components/ui";
import Namespaces from "./pages/Namespaces";
import NamespaceDetail from "./pages/NamespaceDetail";
import Playground from "./pages/Playground";
import UnderTheHood from "./pages/UnderTheHood";

type Theme = "light" | "dark" | "system";

function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return (localStorage.getItem("tp-theme") as Theme) || "system";
    } catch {
      return "system";
    }
  });
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") delete root.dataset.theme;
    else root.dataset.theme = theme;
    try {
      localStorage.setItem("tp-theme", theme);
    } catch {
      /* not persisted */
    }
  }, [theme]);
  return [theme, setTheme];
}

const NAV = [
  { to: "/", label: "Namespaces", icon: Database, end: true },
  { to: "/query", label: "Query", icon: Search },
  { to: "/under-the-hood", label: "Under the hood", icon: Activity },
];

export default function App() {
  const [theme, setTheme] = useTheme();
  const [keyOpen, setKeyOpen] = useState(false);
  const ready = useQuery({
    queryKey: ["readyz"],
    queryFn: () => api<{ node: string; store?: { kind: string; label?: string } }>("/readyz"),
    refetchInterval: 10_000,
  });
  const isDark = theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside className="reef-edge flex shrink-0 flex-row items-center gap-1 border-b border-line bg-surface px-3 py-2 md:w-56 md:flex-col md:items-stretch md:border-r md:border-b-0 md:px-3 md:py-4">
        <div className="mr-3 flex items-center gap-2 px-2 md:mr-0 md:mb-5">
          <img src="/logo.svg" alt="" className="puffer-bob h-8 w-auto" />
          <span className="text-[15px] font-semibold tracking-tight">temupuffer</span>
        </div>
        <nav className="flex flex-1 flex-row gap-1 overflow-x-auto md:flex-col">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink key={to} to={to} end={end}
              className={({ isActive }) =>
                `flex items-center gap-2 whitespace-nowrap rounded-md px-2 py-1.5 text-[13.5px] ${isActive ? "bg-accent-soft font-medium text-accent" : "text-muted hover:bg-surface-2 hover:text-text"}`}>
              <Icon size={16} strokeWidth={1.75} />
              <span className="hidden sm:inline">{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="flex items-center gap-1 md:flex-col md:items-stretch md:gap-2">
          <StoragePicker store={ready.data?.store?.label} />
          <div className="hidden px-2 text-[12px] text-faint md:block">
            {ready.data ? <>Connected to <span className="font-mono text-muted">{ready.data.node}</span></> : ready.isError ? "Query node unreachable" : "Connecting…"}
          </div>
          <div className="flex gap-1 md:px-1">
            <button aria-label="Set API key" title="API key" onClick={() => setKeyOpen(true)} className="rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-text">
              <KeyRound size={16} />
            </button>
            <button aria-label="Toggle theme" title="Toggle theme" onClick={() => setTheme(isDark ? "light" : "dark")} className="rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-text">
              {isDark ? <Sun size={16} /> : <Moon size={16} />}
            </button>
          </div>
        </div>
      </aside>

      <main className="min-w-0 flex-1 px-4 py-6 md:px-8">
        <Routes>
          <Route path="/" element={<Namespaces />} />
          <Route path="/ns/:ns" element={<NamespaceDetail />} />
          <Route path="/query" element={<Playground />} />
          <Route path="/under-the-hood" element={<UnderTheHood />} />
        </Routes>
      </main>

      {keyOpen && <KeyDialog onClose={() => setKeyOpen(false)} />}
    </div>
  );
}

// Which temupuffer stack (and so which object store) the console talks to.
// Each option is a separate deployment with its own bucket/container; switching
// reloads the page, so nothing from the other store lingers in the cache.
function StoragePicker({ store }: { store?: string }) {
  const backends = getBackends();
  const current = getBackend();
  if (backends.length < 2) {
    return store ? <div className="hidden px-2 text-[12px] text-faint md:block" title="Object store">{store}</div> : null;
  }
  return (
    <div className="md:px-1">
      <label className="mb-1 hidden items-center gap-1.5 px-1 text-[11px] font-medium uppercase tracking-wide text-faint md:flex">
        <HardDrive size={12} /> Storage
      </label>
      <select aria-label="Storage backend" value={current.id} onChange={(e) => setBackend(e.target.value)}
        className="h-8 w-full max-w-[11rem] rounded-md border border-line bg-surface px-2 text-[13px]">
        {backends.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
      </select>
      {store && <div className="mt-1 hidden truncate px-1 font-mono text-[11px] text-faint md:block" title={store}>{store}</div>}
    </div>
  );
}

function KeyDialog({ onClose }: { onClose: () => void }) {
  const [value, setValue] = useState(getApiKey());
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <form className="w-full max-w-sm rounded-lg border border-line bg-surface p-5" onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); setApiKey(value); onClose(); window.location.reload(); }}>
        <h2>API key</h2>
        <p className="mt-1 text-[13px] text-muted">Sent as <span className="font-mono">Authorization: Bearer …</span> on every request{getBackends().length > 1 ? <> to <span className="font-medium">{getBackend().label}</span></> : null}. Stored in this browser only.</p>
        <input autoFocus value={value} onChange={(e) => setValue(e.target.value)}
          className="mt-4 h-9 w-full rounded-md border border-line bg-bg px-3 font-mono text-[13px]" />
        <div className="mt-4 flex justify-end gap-2">
          <Button kind="quiet" onClick={onClose}>Cancel</Button>
          <Button type="submit">Save key</Button>
        </div>
      </form>
    </div>
  );
}
