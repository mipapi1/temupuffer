// Small shared building blocks. Panels are "stickers" and buttons press in
// (the Reef look, index.css); hierarchy still comes from type and spacing.

import type { ReactNode } from "react";

export function Panel({ title, aside, children, className = "" }: { title?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`sticker min-w-0 bg-surface ${className}`}>
      {title && (
        <header className="flex items-baseline justify-between gap-4 border-b border-line px-4 py-3">
          <h2>{title}</h2>
          {aside && <div className="text-[12px] text-muted">{aside}</div>}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Button({ children, onClick, kind = "primary", disabled, type = "button", title }: {
  children: ReactNode; onClick?: () => void; kind?: "primary" | "quiet" | "danger"; disabled?: boolean; type?: "button" | "submit"; title?: string;
}) {
  const styles = {
    primary: "btn-pop bg-accent text-on-accent",
    quiet: "btn-pop bg-surface text-text hover:bg-surface-2",
    danger: "btn-pop bg-surface text-red hover:bg-red-soft",
  }[kind];
  return (
    <button type={type} title={title} disabled={disabled} onClick={onClick}
      className={`inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[13px] font-medium transition-colors disabled:opacity-50 ${styles}`}>
      {children}
    </button>
  );
}

export function Pill({ tone, children }: { tone: "amber" | "teal" | "neutral" | "red" | "accent"; children: ReactNode }) {
  const styles = {
    amber: "bg-amber-soft text-amber",
    teal: "bg-teal-soft text-teal",
    neutral: "bg-surface-2 text-muted",
    red: "bg-red-soft text-red",
    accent: "bg-accent-soft text-accent",
  }[tone];
  return <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[12px] font-medium ${styles}`}>{children}</span>;
}

export function IndexStatus({ status, rows }: { status: string; rows?: number }) {
  return status === "up-to-date" ? (
    <Pill tone="teal">Indexed</Pill>
  ) : (
    <Pill tone="amber">{rows ? `${rows.toLocaleString()} rows to index` : "Indexing"}</Pill>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: "amber" | "teal" | "red" }) {
  const color = tone ? { amber: "text-amber", teal: "text-teal", red: "text-red" }[tone] : "text-text";
  return (
    <div className="min-w-0">
      <div className="text-[12px] text-muted">{label}</div>
      <div className={`tabular text-[20px] font-semibold leading-tight ${color}`}>{value}</div>
      {hint && <div className="mt-0.5 text-[12px] text-faint">{hint}</div>}
    </div>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  const msg = error instanceof Error ? error.message : String(error);
  return <div className="rounded-md border border-red/30 bg-red-soft px-3 py-2 text-[13px] text-red">{msg}</div>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-line px-6 py-10 text-center">
      <div className="font-medium">{title}</div>
      {children && <div className="mx-auto mt-1 max-w-md text-[13px] text-muted">{children}</div>}
    </div>
  );
}

export function Code({ children }: { children: ReactNode }) {
  return <code className="rounded bg-surface-2 px-1 py-px font-mono text-[12.5px]">{children}</code>;
}

export function JsonBlock({ value, maxHeight = 360 }: { value: unknown; maxHeight?: number }) {
  return (
    <pre className="overflow-auto rounded-md bg-surface-2 p-3 font-mono text-[12px] leading-relaxed" style={{ maxHeight }}>
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}
