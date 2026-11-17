import { useEffect, useRef, useState } from 'react';
import { formatBytes, formatCount, formatDuration, formatRate, parseBytes, parseCount, parseDuration, parseMoney, sig } from '../lib/units.ts';

type Kind = 'bytes' | 'rate' | 'duration' | 'count' | 'money' | 'number' | 'percent';

const PARSE: Record<Kind, (s: string) => number | null> = {
  bytes: parseBytes,
  rate: parseBytes,
  duration: parseDuration,
  count: parseCount,
  money: parseMoney,
  number: (s) => (s.trim() === '' ? null : Number.isFinite(Number(s)) ? Number(s) : null),
  percent: (s) => {
    const n = Number(s.replace('%', '').trim());
    return Number.isFinite(n) ? n / 100 : null;
  },
};
const FORMAT: Record<Kind, (n: number) => string> = {
  bytes: (n) => formatBytes(n),
  rate: (n) => formatRate(n),
  duration: (n) => formatDuration(n),
  count: (n) => formatCount(n),
  money: (n) => `$${sig(n, 4)}`,
  number: (n) => sig(n, 4),
  percent: (n) => `${sig(n * 100, 3)}%`,
};

const HINT: Record<Kind, string> = {
  bytes: 'e.g. 8 KiB, 1.5 GiB, 500 MB',
  rate: 'e.g. 3 GiB/s, 500 MiB/s',
  duration: 'e.g. 100us, 2 ms, 1.5s',
  count: 'e.g. 10k, 2.5M',
  money: 'e.g. 0.02',
  number: 'a number',
  percent: 'e.g. 5%',
};

/**
 * Free-text quantity field: type "1.5 GiB", "100us" or "10k"; it parses on Enter/blur and
 * re-formats. Arrow up/down scales by 2x (shift: 10x), which is how napkin math moves.
 */
export function Quantity({
  value, onChange, kind, className = '', label, min, placeholder, nullable,
}: {
  value: number | null | undefined;
  onChange: (n: number | null) => void;
  kind: Kind;
  className?: string;
  label: string;
  min?: number;
  placeholder?: string;
  nullable?: boolean;
}) {
  const fmt = (v: number | null | undefined) => (v == null ? '' : FORMAT[kind](v));
  const [text, setText] = useState(fmt(value));
  const [invalid, setInvalid] = useState(false);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(fmt(value));
  }, [value, kind]);

  const commit = (t: string) => {
    if (t.trim() === '' && nullable) {
      setInvalid(false);
      onChange(null);
      return;
    }
    const n = PARSE[kind](t);
    if (n == null || (min != null && n < min)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    onChange(n);
    setText(fmt(n));
  };

  return (
    <input
      className={`qty ${invalid ? 'invalid' : ''} ${className}`}
      aria-label={label}
      aria-invalid={invalid}
      title={invalid ? `Couldn't read that. Try ${HINT[kind]}` : `${label} — ${HINT[kind]}; ↑/↓ doubles or halves`}
      value={text}
      placeholder={placeholder}
      spellCheck={false}
      onFocus={(e) => {
        focused.current = true;
        e.currentTarget.select();
      }}
      onBlur={(e) => {
        focused.current = false;
        commit(e.currentTarget.value);
      }}
      onChange={(e) => {
        setText(e.target.value);
        setInvalid(false);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          setText(fmt(value));
          (e.currentTarget as HTMLInputElement).blur();
        }
        if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && value != null && kind !== 'percent') {
          e.preventDefault();
          const f = e.shiftKey ? 10 : 2;
          let n = e.key === 'ArrowUp' ? value * f : value / f;
          if (kind === 'count' || kind === 'number') n = Math.max(min ?? 0, n >= 1 ? Math.round(n) : n);
          if (min != null) n = Math.max(min, n);
          onChange(n);
          setText(fmt(n));
        }
      }}
    />
  );
}
