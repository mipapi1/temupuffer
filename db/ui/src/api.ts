// A thin client for the temupuffer API. Every request goes to the current
// backend's prefix: /api/* by default, or /b/<id>/api/* when the console was
// started with several backends (BACKENDS, see backends.sh), e.g. one stack on
// SILO and one on Azure Blob. nginx (or the Vite dev server) forwards it to that
// stack's query nodes.

export type Backend = { id: string; label: string; prefix: string };

const KEY_STORAGE = "tp-api-key";
const BACKEND_STORAGE = "tp-backend";
const FALLBACK: Backend = { id: "default", label: "Default", prefix: "/api" };

let backends: Backend[] = [FALLBACK];
let current: Backend = FALLBACK;

function read(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}

function write(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* private mode: lasts for this page only */
  }
}

/** Load /backends.json (served by nginx) once, before the app renders. */
export async function loadBackends(): Promise<void> {
  try {
    const res = await fetch("/backends.json", { cache: "no-store" });
    const list = (await res.json()) as Backend[];
    if (Array.isArray(list) && list.length) backends = list;
  } catch {
    /* dev server or old console: just the default /api */
  }
  current = backends.find((b) => b.id === read(BACKEND_STORAGE)) ?? backends[0];
}

export function getBackends(): Backend[] {
  return backends;
}

export function getBackend(): Backend {
  return current;
}

/** Switch stacks. Reloads the page so every cached query starts fresh. */
export function setBackend(id: string) {
  write(BACKEND_STORAGE, id);
  window.location.reload();
}

// One key per backend, falling back to the shared one (same key on every stack).
export function getApiKey(): string {
  return read(`${KEY_STORAGE}:${current.id}`) ?? read(KEY_STORAGE) ?? "tpuf-dev-key";
}

export function setApiKey(key: string) {
  write(`${KEY_STORAGE}:${current.id}`, key);
  if (read(KEY_STORAGE) === null) write(KEY_STORAGE, key);
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`${current.prefix}${path}`, {
    method: init.method ?? (init.body ? "POST" : "GET"),
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const d = data as { error?: string; detail?: string } | null;
    throw new ApiError(res.status, d?.error ?? d?.detail ?? `HTTP ${res.status}`);
  }
  return data as T;
}

// --- Response shapes (the parts the console uses) ---

export type SchemaAttr = { type: string; filterable?: boolean; full_text_search?: false | Record<string, unknown>; ann?: boolean };

export type Metadata = {
  schema: Record<string, SchemaAttr>;
  approx_logical_bytes: number;
  approx_row_count: number;
  created_at: string;
  updated_at: string;
  last_write_at: string | null;
  index: { status: "updating" | "up-to-date"; unindexed_bytes?: number; unindexed_rows?: number };
  distance_metric: string | null;
  dims: number | null;
  temupuffer: { index_cursor: number; wal_head: number; segments: number; manifest_version: number };
};

export type Performance = {
  cache_hit_ratio: number;
  cache_temperature: "hot" | "warm" | "cold";
  server_total_ms: number;
  query_execution_ms: number;
  exhaustive_search_count: number;
  approx_namespace_size: number;
  object_storage_round_trips: number;
  object_storage_requests: Record<string, number>;
  consistency: "strong" | "eventual";
  view_age_ms: number;
  index_cursor: number;
  wal_head: number;
  unindexed_entries_scanned: number;
  unindexed_entries_skipped: number;
  segments_searched: number;
  node: string;
};

export type Row = { id: string | number; $dist?: number; [k: string]: unknown };
export type QueryResult = { rows?: Row[]; aggregations?: Record<string, number>; performance: Performance };

export type WalEntry = { seq: number; bytes: number; at: number; indexed: boolean; rows: number | null };
export type Segment = { id: string; min_seq: number; max_seq: number; rows: number; live_rows?: number; bytes: number; level: number; created_at: string };
export type WalState = {
  namespace: string;
  cursor: number;
  head: number;
  entries: WalEntry[];
  manifest: { version: number; cursor: number; segments: Segment[]; garbage: { id: string; since: number }[]; updated_at: string | null };
  unindexed_rows: number;
  unindexed_bytes: number;
};

export type NodeEvent = { t: number; node: string; kind: string; ns: string; [k: string]: unknown };

export type QueryNodeStats = {
  url: string;
  ok: boolean;
  error?: string;
  node: string;
  role: "query";
  uptime_s: number;
  store_totals: Record<string, number>;
  store_rate_10s: Record<string, number>;
  cache: { memory_bytes: number; memory_entries: number; disk_bytes: number; disk_entries: number; memory_hits: number; disk_hits: number; misses: number; memory_cap: number; disk_cap: number };
  writers: Record<string, { entries_written: number; lost_races: number; queue_depth: number; last_commit_ms: number; last_batch_requests: number }>;
  views: Record<string, { cursor: number; head: number; age_s: number; unindexed_rows: number }>;
  queries: number;
  writes: number;
  rejected_429: number;
  events: NodeEvent[];
  config: Record<string, number>;
};

export type IndexerStats = {
  url: string;
  ok: boolean;
  error?: string;
  node: string;
  role: "indexer";
  passes: number;
  compactions: number;
  lost_manifest_races: number;
  current: { ns: string; from_seq: number; to_seq: number; rows: number; stage: string; started: number } | null;
  last_pass: { ns: string; entries: number; rows: number; ms: number; cursor: number; at: number } | null;
  store_totals: Record<string, number>;
  store_rate_10s: Record<string, number>;
  events: NodeEvent[];
};

export type Cluster = { query_nodes: QueryNodeStats[]; indexers: IndexerStats[] };

export type QueueDoc = {
  etag: string | null;
  version: number;
  jobs: Record<string, { enqueued_at: number; claimed_by: string | null; heartbeat: number | null; rerun: boolean }>;
};

// --- Formatting helpers ---

export function fmtBytes(n: number | undefined): string {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function fmtNum(n: number | undefined): string {
  return (n ?? 0).toLocaleString("en-US");
}

export function ago(unixSeconds: number): string {
  const s = Math.max(0, Date.now() / 1000 - unixSeconds);
  if (s < 1) return "just now";
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}
