// Parse the reference tables out of upstream/README.md (sirupsen/napkin-math) into data/reference/*.json.
// Re-run after `git submodule update --remote upstream` to pick up newly measured numbers.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const readme = await readFile(path.join(root, 'upstream', 'README.md'), 'utf8');
const out = path.join(root, 'data', 'reference');
await mkdir(out, { recursive: true });

/** Line number of the first occurrence of `needle` (tables are searched from there). */
const lineOf = (needle: string) => readme.slice(0, readme.indexOf(needle)).split('\n').length - 1;
const clean = (s: string) => s.replace(/\\\$/g, '$').replace(/\\\*/g, '*').trim();

/** Return the rows of the first markdown table whose header's first cell matches. */
function table(firstHeader: RegExp, startAfter = 0): string[][] {
  const lines = readme.split('\n');
  for (let i = startAfter; i < lines.length; i++) {
    const cells = splitRow(lines[i]);
    if (cells && firstHeader.test(cells[0] ?? '') && /^\s*\|?\s*-{3}/.test(lines[i + 1] ?? '')) {
      const rows: string[][] = [cells];
      for (let j = i + 2; j < lines.length; j++) {
        const r = splitRow(lines[j]);
        if (!r) break;
        rows.push(r);
      }
      return rows;
    }
  }
  throw new Error(`table ${firstHeader} not found in upstream README`);
}
function splitRow(line: string): string[] | null {
  const t = line.trim();
  if (!t.startsWith('|')) return null;
  return t.replace(/^\|/, '').replace(/\|$/, '').split('|').map(clean);
}

const UNIT_NS: Record<string, number> = { ns: 1, 'μs': 1e3, us: 1e3, ms: 1e6, s: 1e9 };
const UNIT_B: Record<string, number> = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4 };
const ns = (s: string) => {
  const m = s.match(/([\d.]+)\s*(ns|μs|us|ms|s)\b/);
  return m ? Number(m[1]) * UNIT_NS[m[2]] : null;
};
const bps = (s: string) => {
  const m = s.match(/([\d.]+)\s*(B|KiB|MiB|GiB|TiB)\/s/);
  return m ? Number(m[1]) * UNIT_B[m[2]] : null;
};
const slug = (s: string) => s.toLowerCase().replace(/\(.*?\)/g, (m) => m.replace(/[^a-z0-9]+/g, ' ')).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function category(name: string) {
  if (/^GPU/.test(name)) return 'gpu';
  if (/^L[123] Cache/.test(name)) return 'cache';
  if (/^Memory/.test(name)) return 'memory';
  if (/^CPU (Hash|Encrypt|Serialize|Deserialize|Compress|Decompress|Sort|Encode|Decode)/.test(name)) return 'cpu';
  if (/^CPU/.test(name)) return 'os';
  if (/^SSD/.test(name)) return 'ssd';
  if (/^HDD/.test(name)) return 'hdd';
  if (/^Network Disk/.test(name)) return 'network-disk';
  if (/^Network/.test(name)) return 'network';
  if (/^Blob Storage/.test(name)) return 'blob';
  return 'service';
}

// ── Operations ────────────────────────────────────────────────────────────────
const opRows = table(/^Operation$/).slice(1);
const operations = opRows.map(([rawName, lat, thr]) => {
  const footnotes = [...rawName.matchAll(/[†‡*]/g)].map((m) => m[0]);
  const name = rawName.replace(/[†‡*]+$/g, '').trim();
  const size = name.match(/\((?:[^()]*?,\s*)?(\d+(?:\.\d+)?)\s*(B|KiB|MiB|GiB)(?: page)?\)/);
  const keys = name.match(/\((\d+) keys\)/);
  const scope = name.match(/,\s*(1 thread|all cores|1 connection|other socket, all cores|other socket, 1 thread)$/)?.[1] ?? null;
  return {
    id: slug(name),
    name,
    category: category(name),
    latencyNs: ns(lat),
    throughputBps: bps(thr),
    blockBytes: size ? Number(size[1]) * UNIT_B[size[2]] : null,
    unitLabel: keys ? `${keys[1]} keys` : null,
    scope,
    perThread: /1 thread$/.test(name),
    // README: "CPU and memory rows marked 1 thread scale with cores until memory bandwidth runs out".
    // Disk rows are already one thread with 32 in flight, i.e. the device's limit.
    scalesWithThreads: /1 thread$/.test(name) && ['cpu', 'memory', 'cache'].includes(category(name)),
    plusRtt: /\+1 RTT/.test(name),
    footnotes,
  };
});

// ── Cost numbers ──────────────────────────────────────────────────────────────
const costRows = table(/^What$/).slice(1);
let group = '';
const costs = costRows.flatMap(([rawWhat, amount, month, year, spot]) => {
  const child = rawWhat.startsWith('├');
  const what = rawWhat.replace(/^├\s*/, '').replace(/\s*[‖†¶♣]+$/g, '').trim();
  const money = (s: string) => (s && s.includes('$') ? Number(s.replace(/[$,]/g, '')) : null);
  if (!amount && !month) {
    group = what;
    return [];
  }
  if (!child) group = '';
  const g = child ? group : '';
  return [{
    id: slug((g ? g + ' ' : '') + what),
    group: g || null,
    name: what,
    amount,
    monthly: money(month),
    commit1y: money(year),
    spot: money(spot),
  }];
});

// Blob request pricing (per 1M)
const blobRows = table(/^$/, lineOf('Regional, 1M') - 1).filter((r) => r.length >= 3);
const blobRequests = blobRows.slice(1).map(([what, regional, zonal]) => ({
  id: slug(what),
  name: what,
  regionalPerMillion: Number(regional.replace(/[$,]/g, '')),
  zonalPerMillion: Number(zonal.replace(/[$,]/g, '')),
}));

// ── Instance shapes ───────────────────────────────────────────────────────────
const shapeRows = table(/^Shape$/);
const num = (s: string) => (s ? Number(s.replace(/[$,]/g, '')) : 0);
const shapes = shapeRows.slice(1).map(([name, vcpu, mem, vram, ssd, hdd, net, month, y1, spot, max]) => ({
  id: slug(name),
  name,
  vcpu: num(vcpu),
  memoryGiB: num(mem),
  vramGB: num(vram),
  ssdGB: num(ssd),
  hddGB: num(hdd),
  networkGBps: num(net),
  monthlyPerVcpu: num(month),
  commit1yPerVcpu: num(y1),
  spotPerVcpu: num(spot),
  maxVcpu: num(max),
}));

// ── Cost to read 1 TiB ────────────────────────────────────────────────────────
const readRows = table(/^What$/, lineOf('/ TiB read') - 1);
const readCost = readRows.slice(1).map(([what, od, y1, spot]) => ({ name: what.replace(/§$/, ''), perTiB: num(od), commit1y: num(y1), spot: num(spot) }));

// ── Compression ───────────────────────────────────────────────────────────────
const compRows = table(/^What$/, lineOf('## Compression Ratios'));
const compression = compRows.slice(1).map(([what, ratio]) => {
  const m = ratio.match(/([\d.]+)(?:-([\d.]+))?x/);
  return { id: slug(what), name: what, low: m ? Number(m[1]) : 1, high: m ? Number(m[2] ?? m[1]) : 1 };
});
const structRows = table(/^What$/, lineOf('Structured data, against'));
const encodings = structRows.slice(1).map(([what, encoding, ratio]) => ({ id: slug(what), name: what, encoding, ratio }));

// ── Techniques (prose, shown in the UI) ───────────────────────────────────────
const techSection = readme.split('## Techniques')[1]?.split('## Resources')[0] ?? '';
const techniques = [...techSection.matchAll(/\*\s+\*\*(.+?)\*\*\s+([\s\S]*?)(?=\n\*\s+\*\*|$)/g)].map((m) => ({
  title: m[1].replace(/\.$/, ''),
  body: m[2].replace(/\s+/g, ' ').replace(/\[(.+?)\]\(.+?\)/g, '$1').trim(),
}));

const measured = readme.match(/Last measured\s+in ([^,]+),/)?.[1]?.replace(/\s+/g, ' ') ?? null;
const meta = { source: 'https://github.com/sirupsen/napkin-math', measured, syncedAt: new Date().toISOString() };

const files: Record<string, unknown> = { operations, costs, 'blob-requests': blobRequests, shapes, 'read-cost': readCost, compression, encodings, techniques, meta };
for (const [k, v] of Object.entries(files)) await writeFile(path.join(out, `${k}.json`), JSON.stringify(v, null, 2) + '\n');
console.log(`synced ${operations.length} operations, ${costs.length} cost rows, ${shapes.length} shapes, ${compression.length} compression ratios, ${techniques.length} techniques`);
