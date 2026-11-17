import type { ReactNode } from "react";

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string; icon?: ReactNode }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-lg border border-line bg-surface-2 p-0.5">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.value)}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1 text-[13px] transition-colors ${
              active ? "bg-accent-soft font-medium text-accent shadow-sm" : "text-muted hover:text-text"
            }`}
          >
            {o.icon}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`sticker bg-surface ${className}`}>{children}</section>;
}

export function Chip({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "accent" | "teal" | "amber" | "red" }) {
  const tones = {
    neutral: "bg-surface-2 text-muted",
    accent: "bg-accent-soft text-accent",
    teal: "bg-teal-soft text-teal",
    amber: "bg-amber-soft text-amber",
    red: "bg-red-soft text-red",
  };
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[12px] font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <Card className="p-4">
      <div className="text-[12px] font-medium tracking-wide text-muted uppercase">{label}</div>
      <div className="tabular mt-1 text-[24px] font-semibold tracking-tight">{value}</div>
      {sub && <div className="mt-0.5 text-[12px] text-muted">{sub}</div>}
    </Card>
  );
}

export function Button({
  children,
  onClick,
  disabled,
  variant = "secondary",
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: "primary" | "secondary";
  type?: "button" | "submit";
}) {
  const v =
    variant === "primary"
      ? "btn-pop bg-accent text-on-accent"
      : "btn-pop bg-surface text-text hover:bg-surface-2";
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${v}`}
    >
      {children}
    </button>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <div className="rounded-lg border border-red/30 bg-red-soft px-3 py-2 text-[13px] text-red">
      {error instanceof Error ? error.message : String(error)}
    </div>
  );
}
