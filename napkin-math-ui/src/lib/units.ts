// Parsing and formatting of napkin quantities. Bytes are binary (KiB = 1024) like the reference
// tables; cost tables quote "GB" which we treat as 10^9 bytes.

export const KiB = 1024;
export const MiB = KiB ** 2;
export const GiB = KiB ** 3;
export const TiB = KiB ** 4;
export const PiB = KiB ** 5;
export const GB = 1e9;
export const SECONDS_PER_MONTH = 730 * 3600; // 2.628M, the README rounds to 2.6M

const BYTE_UNITS: [string, number][] = [
  ['pib', PiB], ['tib', TiB], ['gib', GiB], ['mib', MiB], ['kib', KiB],
  ['pb', 1e15], ['tb', 1e12], ['gb', 1e9], ['mb', 1e6], ['kb', 1e3],
  ['p', PiB], ['t', TiB], ['g', GiB], ['m', MiB], ['k', KiB], ['b', 1], ['', 1],
];
const TIME_UNITS: [string, number][] = [
  ['ns', 1], ['us', 1e3], ['μs', 1e3], ['µs', 1e3], ['ms', 1e6], ['s', 1e9], ['sec', 1e9],
  ['min', 60e9], ['m', 60e9], ['h', 3600e9], ['hr', 3600e9], ['d', 86400e9], ['day', 86400e9],
];
const COUNT_SUFFIX: Record<string, number> = { '': 1, k: 1e3, m: 1e6, b: 1e9, g: 1e9, t: 1e12 };

function splitNum(input: string): [number, string] | null {
  const m = input.trim().replace(/,/g, '').match(/^([-+]?\d*\.?\d+(?:e[-+]?\d+)?)\s*(.*)$/i);
  if (!m) return null;
  return [Number(m[1]), m[2].trim()];
}

/** "1.5 GiB", "500MB", "8k" → bytes. Trailing "/s" is ignored. */
export function parseBytes(input: string): number | null {
  const s = splitNum(input.replace(/\/s(ec)?$/i, ''));
  if (!s) return null;
  const u = s[1].toLowerCase().replace(/ytes?$/, '').replace(/^byte$/, 'b');
  const hit = BYTE_UNITS.find(([k]) => k === u);
  return hit ? s[0] * hit[1] : null;
}

/** "100us", "2 ms", "1.5s" → nanoseconds. Bare numbers are nanoseconds. */
export function parseDuration(input: string): number | null {
  const s = splitNum(input);
  if (!s) return null;
  const u = s[1].toLowerCase();
  if (!u) return s[0];
  const hit = TIME_UNITS.find(([k]) => k === u);
  return hit ? s[0] * hit[1] : null;
}

/** "10k", "2.5M", "1e6" → number. */
export function parseCount(input: string): number | null {
  const s = splitNum(input);
  if (!s) return null;
  const u = s[1].toLowerCase().replace(/\/s$|rps$|qps$/, '').trim();
  return u in COUNT_SUFFIX ? s[0] * COUNT_SUFFIX[u] : null;
}

export function parseMoney(input: string): number | null {
  const n = Number(input.replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** Round to `sig` significant figures and drop trailing zeros. */
export function sig(n: number, digits = 3): string {
  if (n === 0) return '0';
  if (!Number.isFinite(n)) return '∞';
  const a = Math.abs(n);
  if (a >= 1e15 || a < 1e-6) return n.toExponential(1);
  const p = Number(n.toPrecision(digits));
  return p.toLocaleString('en-US', { maximumFractionDigits: 12 });
}

export function formatBytes(b: number, digits = 3): string {
  if (!Number.isFinite(b)) return '∞';
  const units: [string, number][] = [['PiB', PiB], ['TiB', TiB], ['GiB', GiB], ['MiB', MiB], ['KiB', KiB]];
  for (const [u, f] of units) if (Math.abs(b) >= f * 0.9995) return `${sig(b / f, digits)} ${u}`;
  return `${sig(b, digits)} B`;
}

export function formatRate(bps: number): string {
  return `${formatBytes(bps)}/s`;
}

export function formatDuration(ns: number, digits = 3): string {
  if (!Number.isFinite(ns)) return '∞';
  const a = Math.abs(ns);
  if (a < 1e3) return `${sig(ns, digits)} ns`;
  if (a < 1e6) return `${sig(ns / 1e3, digits)} μs`;
  if (a < 1e9) return `${sig(ns / 1e6, digits)} ms`;
  if (a < 120e9) return `${sig(ns / 1e9, digits)} s`;
  if (a < 7200e9) return `${sig(ns / 60e9, digits)} min`;
  if (a < 172800e9) return `${sig(ns / 3600e9, digits)} h`;
  if (a < 86400e9 * 365) return `${sig(ns / 86400e9, digits)} days`;
  return `${sig(ns / (86400e9 * 365), digits)} years`;
}

export function formatCount(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e12) return `${sig(n / 1e12)}T`;
  if (a >= 1e9) return `${sig(n / 1e9)}B`;
  if (a >= 1e6) return `${sig(n / 1e6)}M`;
  if (a >= 1e4) return `${sig(n / 1e3)}k`;
  return sig(n);
}

export function formatMoney(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a === 0) return '$0';
  if (a < 0.01) return `$${sig(n, 2)}`;
  if (a < 100) return `$${sig(n, 3)}`;
  if (a < 1e4) return `$${Math.round(n).toLocaleString('en-US')}`;
  if (a < 1e6) return `$${sig(n / 1e3, 3)}k`;
  if (a < 1e9) return `$${sig(n / 1e6, 3)}M`;
  return `$${sig(n / 1e9, 3)}B`;
}

/** Napkin form: n ≈ c × 10^e with a single-digit coefficient. */
export function napkin(n: number): { c: number; e: number } {
  if (n === 0 || !Number.isFinite(n)) return { c: 0, e: 0 };
  let e = Math.floor(Math.log10(Math.abs(n)));
  let c = Math.round(n / 10 ** e);
  if (Math.abs(c) === 10) {
    c = c / 10;
    e += 1;
  }
  return { c, e };
}

const SUP: Record<string, string> = { '-': '⁻', 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' };
export const superscript = (n: number) => String(n).split('').map((ch) => SUP[ch] ?? ch).join('');
