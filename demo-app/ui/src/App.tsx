import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Gauge, Moon, Search as SearchIcon, Sun } from "lucide-react";
import { api } from "./api";
import SearchPage from "./pages/Search";
import ScalePage from "./pages/Scale";

type Page = "search" | "scale";
const pageFromHash = (): Page => (location.hash === "#scale" ? "scale" : "search");

export default function App() {
  const [page, setPage] = useState<Page>(pageFromHash);
  const config = useQuery({ queryKey: ["config"], queryFn: api.config, staleTime: Infinity });
  const [backend, setBackend] = useState<string | undefined>(undefined);

  useEffect(() => {
    const onHash = () => setPage(pageFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const go = (p: Page) => {
    location.hash = p === "search" ? "" : p;
    setPage(p);
  };

  const backends = config.data?.backends ?? [];
  const active = backend ?? config.data?.default_backend;

  return (
    <div className="min-h-screen">
      <header className="reef-wave sticky top-0 z-10 bg-surface/85 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-2.5 sm:px-6">
          <a href="#" onClick={() => go("search")} className="flex items-center gap-2">
            <img src="/logo.svg" alt="" className="puffer-bob h-8 w-auto" />
            <span className="text-[15px] font-semibold tracking-tight">temupuffer-search</span>
          </a>
          <span aria-hidden className="h-6 w-0.5 rounded-full bg-line" />
          <nav className="flex gap-1">
            {(
              [
                ["search", "Search", <SearchIcon key="s" size={15} />],
                ["scale", "Scale", <Gauge key="g" size={15} />],
              ] as const
            ).map(([p, label, icon]) => (
              <button
                key={p}
                onClick={() => go(p)}
                aria-current={page === p ? "page" : undefined}
                className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[13.5px] ${
                  page === p ? "bg-accent-soft font-medium text-accent" : "text-muted hover:bg-surface-2 hover:text-text"
                }`}
              >
                {icon}
                {label}
              </button>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            {backends.length > 1 ? (
              <select
                aria-label="Database"
                value={active}
                onChange={(e) => setBackend(e.target.value)}
                className="rounded-md border border-line bg-surface px-2 py-1 text-[13px]"
              >
                {backends.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            ) : (
              active && (
                <span className="hidden text-[12.5px] text-muted sm:inline">
                  on <span className="font-medium text-text">{active}</span> · {config.data?.namespace}
                </span>
              )
            )}
            <ThemeToggle />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
        {page === "search" ? <SearchPage config={config.data} backend={active} /> : <ScalePage config={config.data} backend={active} />}
      </main>
    </div>
  );
}

function ThemeToggle() {
  const [dark, setDark] = useState(() => {
    const t = document.documentElement.dataset.theme;
    return t ? t === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  });
  const flip = () => {
    const next = dark ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("tp-theme", next);
    } catch {
      /* private mode: the toggle still works for this page */
    }
    setDark(!dark);
  };
  return (
    <button onClick={flip} aria-label="Toggle theme" className="rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-text">
      {dark ? <Sun size={16} /> : <Moon size={16} />}
    </button>
  );
}
