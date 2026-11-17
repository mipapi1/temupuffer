import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Copy, Info, LoaderCircle } from "lucide-react";
import { api, type InfoKind } from "../api";

/** An (i) next to a button: what it does, and the exact commands that run behind it. */
export default function InfoPopover({
  kind,
  title,
  children,
  docs = 100_000,
  skip = 0,
  backend = "temupuffer",
  align = "left",
}: {
  kind: InfoKind;
  title: string;
  children: ReactNode;
  docs?: number;
  skip?: number;
  backend?: string;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const id = useId();
  const cmds = useQuery({
    queryKey: ["job-commands", kind, docs, skip, backend],
    queryFn: () => api.jobCommands(kind, docs, skip, backend),
    enabled: open,
    staleTime: Infinity,
  });

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <span ref={box} className="relative inline-flex">
      <button
        type="button"
        aria-label={`What does “${title}” do?`}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
        className={`grid h-6 w-6 place-items-center rounded-full transition-colors ${
          open ? "bg-accent-soft text-accent" : "text-faint hover:bg-surface-2 hover:text-text"
        }`}
      >
        <Info size={15} />
      </button>
      {open && (
        <div
          id={id}
          role="dialog"
          aria-label={title}
          className={`z-30 overflow-auto rounded-xl border border-line bg-surface p-4 text-left shadow-lg
            max-sm:fixed max-sm:inset-x-4 max-sm:bottom-4 max-sm:max-h-[75vh]
            sm:absolute sm:top-8 sm:max-h-[min(560px,70vh)] sm:w-[440px] ${align === "right" ? "sm:right-0" : "sm:left-0"}`}
        >
          <div className="text-[13.5px] font-semibold">{title}</div>
          <div className="mt-1 space-y-1.5 text-[13px] leading-relaxed text-muted">{children}</div>
          <div className="mt-3 border-t border-line pt-3">
            <div className="text-[11.5px] font-medium tracking-wide text-faint uppercase">What runs behind it</div>
            {cmds.isPending && (
              <div className="mt-2 flex items-center gap-1.5 text-[12.5px] text-muted">
                <LoaderCircle size={13} className="animate-spin" /> loading…
              </div>
            )}
            {cmds.error && <div className="mt-2 text-[12.5px] text-red">{String(cmds.error)}</div>}
            <dl className="mt-2 space-y-2">
              {cmds.data?.commands.map((c) => (
                <div key={c.label}>
                  <dt className="text-[12px] text-muted">{c.label}</dt>
                  <dd className="mt-0.5">
                    <CodeLine code={c.code} />
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      )}
    </span>
  );
}

function CodeLine({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code.split("   #")[0]);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard blocked (http, permissions): the text is still selectable */
    }
  };
  return (
    <div className="group flex items-start gap-1 rounded-lg bg-surface-2 px-2.5 py-1.5">
      <code className="min-w-0 flex-1 font-mono text-[12px] leading-relaxed break-words whitespace-pre-wrap text-text">{code}</code>
      <button
        type="button"
        onClick={copy}
        aria-label="Copy command"
        className="mt-0.5 shrink-0 rounded p-0.5 text-faint opacity-60 transition hover:text-text group-hover:opacity-100"
      >
        {copied ? <Check size={13} className="text-teal" /> : <Copy size={13} />}
      </button>
    </div>
  );
}
