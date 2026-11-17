import { Readable } from 'node:stream';
import { createInterface } from 'node:readline';

const UA = 'napkin-math-ui/0.1 (pricing cache refresh)';

export function log(scope: string, ...msg: unknown[]) {
  const t = new Date().toISOString().slice(11, 19);
  console.log(`[${t}] ${scope.padEnd(6)}`, ...msg);
}

export async function getJson<T = any>(url: string, tries = 6): Promise<T> {
  let wait = 1500;
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' } });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} for ${url}: ${(await res.text()).slice(0, 200)}`), { fatal: true });
      return (await res.json()) as T;
    } catch (e: any) {
      if (e.fatal || i >= tries) throw e;
      await new Promise((r) => setTimeout(r, wait));
      wait *= 2;
    }
  }
}

export async function getText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

/** Stream a (large) remote text file line by line without buffering it in memory. */
export async function* streamLines(url: string): AsyncGenerator<string> {
  const res = await fetch(url, { headers: { 'user-agent': UA } });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`);
  const rl = createInterface({ input: Readable.fromWeb(res.body as any), crlfDelay: Infinity });
  for await (const line of rl) yield line;
}

/** Minimal RFC4180 line parser (AWS price CSVs never embed newlines in fields). */
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

export function round(n: number, digits = 6) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
