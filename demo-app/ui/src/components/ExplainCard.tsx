import { useState } from "react";
import { ChevronDown, Cpu, Database, Search } from "lucide-react";
import { Card } from "./ui";

const KEY = "explain-open";

function readOpen() {
  try {
    return localStorage.getItem(KEY) !== "0";
  } catch {
    return true;
  }
}

const STEPS = [
  {
    n: "1",
    icon: <Cpu size={16} />,
    title: "Embed",
    what: "Read each paper's title + abstract and turn it into 384 numbers (a vector) that capture what it's about. Similar papers get similar numbers.",
    why: "That's what makes search by meaning possible, not just by matching words.",
    note: "Slow on these small CPUs (~20 papers/s per pod), so it's done once and saved in object storage.",
  },
  {
    n: "2",
    icon: <Database size={16} />,
    title: "Load",
    what: "Send papers + vectors to temupuffer in batches of 2,000. Each batch lands in the write-ahead log first: safe, and searchable right away.",
    why: "An indexer then builds the search index in the background. If it falls behind, the database answers 429 (“slow down”) and the loader waits.",
    note: "Watch it below: amber = not indexed yet, teal = indexed.",
  },
  {
    n: "3",
    icon: <Search size={16} />,
    title: "Search & measure",
    what: "Search by words, by meaning, or both. Then a load test: speed (p50/p99), searches per second, and recall (how often the fast index finds the true best matches).",
    why: "Plus the database's memory per paper, which decides how big it can get.",
    note: "At 100k papers this already found memory bugs, since fixed. 1M is 10× that.",
  },
];

/** "What's happening here?" in plain words, for the Scale page. */
export default function ExplainCard() {
  const [open, setOpen] = useState(readOpen);
  const toggle = () => {
    setOpen(!open);
    try {
      localStorage.setItem(KEY, open ? "0" : "1");
    } catch {
      /* private mode: just don't remember */
    }
  };

  return (
    <Card className="p-4">
      <button onClick={toggle} aria-expanded={open} className="flex w-full items-center justify-between gap-2 text-left">
        <h2>What's happening here?</h2>
        <ChevronDown size={16} className={`shrink-0 text-muted transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <>
          <p className="mt-1 max-w-3xl text-[13.5px] text-muted">
            We're building a search engine for <span className="font-medium text-text">1 million research papers</span> (arXiv) on temupuffer, a small
            database that works like turbopuffer, and checking how it holds up at that size: is it fast, is it accurate, and how much memory does it need?
          </p>
          <ol className="mt-3 grid gap-3 md:grid-cols-3">
            {STEPS.map((s) => (
              <li key={s.n} className="rounded-lg border border-line p-3">
                <div className="flex items-center gap-2">
                  <span className="grid h-6 w-6 place-items-center rounded-full bg-accent-soft text-[12px] font-semibold text-accent">{s.n}</span>
                  <span className="text-muted">{s.icon}</span>
                  <span className="text-[13.5px] font-semibold">{s.title}</span>
                </div>
                <p className="mt-2 text-[13px] leading-relaxed">{s.what}</p>
                <p className="mt-1.5 text-[13px] leading-relaxed text-muted">{s.why}</p>
                <p className="mt-1.5 text-[12.5px] leading-relaxed text-faint">{s.note}</p>
              </li>
            ))}
          </ol>
          <p className="mt-3 text-[12.5px] text-muted">
            The data flows: Hugging Face → <span className="text-text">Embed</span> → vectors in object storage →{" "}
            <span className="text-text">Load</span> → temupuffer (log → indexer → index) → <span className="text-text">Search</span>. Each button below has an
            (i) with the exact commands it runs.
          </p>
        </>
      )}
    </Card>
  );
}
