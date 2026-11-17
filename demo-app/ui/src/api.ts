// Typed calls to the search API (served under /api by nginx, or the Vite dev proxy).

export type Mode = "hybrid" | "keyword" | "vector";
export type Level = "strong" | "eventual";

export interface Filters {
  field?: string;
  year_min?: number;
  year_max?: number;
}

export interface SearchParams {
  q: string;
  mode: Mode;
  filters: Filters;
  consistency: Level;
  backend?: string;
  limit?: number;
}

export interface Result {
  id: number;
  title: string;
  abstract: string;
  authors: string;
  arxiv_id: string;
  category: string;
  field: string;
  year: number;
  score: number | null;
  ranks: { vector?: number; keyword?: number };
}

export interface Performance {
  server_total_ms?: number;
  query_execution_ms?: number;
  cache_temperature?: string;
  cache_hit_ratio?: number;
  exhaustive_search_count?: number;
  approx_namespace_size?: number;
  object_storage_round_trips?: number;
  object_storage_requests?: Record<string, number>;
  consistency?: string;
  view_age_ms?: number;
  segments_searched?: number;
  node?: string;
}

export interface SearchResponse {
  backend: string;
  mode: Mode;
  results: Result[];
  timing: { embed_ms: number; database_ms: number | null; server_ms: number | null; total_ms: number };
  performance: Performance;
  request: unknown;
  routed_to?: string | null;
}

export interface Config {
  backends: string[];
  default_backend: string;
  namespace: string;
  turbopuffer_prefix: string | null;
  fields: string[];
  modes: Mode[];
  model: string;
  dataset: string;
}

export interface Summary {
  count: number;
  p50: number | null;
  p90: number | null;
  p99: number | null;
  mean: number | null;
}

export interface Bench {
  state: "idle" | "running" | "measuring recall" | "done" | "error";
  started?: number;
  seconds?: number;
  elapsed?: number;
  done_queries?: number;
  concurrency?: number;
  modes?: Mode[];
  consistency?: Level;
  backend?: string;
  error?: string;
  result?: {
    qps: number;
    by_mode: Record<string, { client: Summary; server: Summary }>;
    cache_temperature: Record<string, number>;
    errors: number;
    error_samples: string[];
    recall?: { samples: number; recall_at_10: number | null; ann_server_ms_p50: number | null; exact_server_ms_p50: number | null };
  };
}

export interface Ingest {
  backend: string;
  target: number;
  sent: number;
  acked: number;
  retries_429: number;
  errors: number;
  started_at: number;
  done: boolean;
  rows_per_s: number;
  received_at: number;
}

export interface Stats {
  namespace: string;
  backend: string;
  metadata: {
    approx_row_count?: number;
    approx_logical_bytes?: number;
    index?: { status: string; unindexed_rows?: number; unindexed_bytes?: number };
    temupuffer?: { index_cursor: number; wal_head: number; segments: number; manifest_version: number };
    error?: string;
  } | null;
  history: { t: number; rows: number; unindexed: number }[];
  ingest: Ingest | null;
  latency: ({ backend: string; mode: Mode } & Summary)[];
  bench: Bench;
}

export type JobKind = "embed" | "load";
export type InfoKind = JobKind | "stop" | "reset";

export interface JobState {
  state: "none" | "starting" | "running" | "succeeded" | "failed";
  active?: number;
  succeeded?: number;
  failed?: number;
  completions?: number;
  started_at?: string | null;
  finished_at?: string | null;
  docs?: number | null;
  skip?: number | null;
  chunks_total?: number;
  pods?: { name: string; phase: string; node: string | null }[];
}

export interface Jobs {
  available: boolean;
  actions_enabled: boolean;
  reason?: string;
  namespace: string;
  max_docs: number;
  embeddings: { chunks: number; docs: number; uri: string; error?: string };
  embed: JobState;
  load: JobState;
}

export interface Command {
  label: string;
  code: string;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`/api${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.detail ?? `${r.status} ${r.statusText}`);
  return body as T;
}

const post = <T,>(path: string, body: unknown) => call<T>(path, { method: "POST", body: JSON.stringify(body) });

export const api = {
  config: () => call<Config>("/config"),
  search: (p: SearchParams) => post<SearchResponse>("/search", p),
  compare: (p: SearchParams, across: "modes" | "backends") =>
    post<{ across: string; columns: Record<string, SearchResponse | { error: string }> }>("/compare", { ...p, across }),
  coldWarm: (p: SearchParams) =>
    post<{ backend: string; runs: { label: string; server_ms: number; total_ms: number; cache_temperature: string; cache_hit_ratio: number; round_trips?: number }[] }>(
      "/demo/cold-warm",
      p,
    ),
  writeRead: (backend?: string) =>
    post<{ backend: string; token: string; steps: { step: string; ms: number | null; found?: boolean; detail?: string; exhaustive_search_count?: number; view_age_ms?: number }[] }>(
      `/demo/write-read${backend ? `?backend=${backend}` : ""}`,
      {},
    ),
  stats: () => call<Stats>("/stats"),
  startBench: (b: { seconds: number; concurrency: number; modes: Mode[]; consistency: Level; backend?: string }) =>
    post<Bench>("/bench", b),
  jobs: () => call<Jobs>("/jobs"),
  jobCommands: (kind: InfoKind, docs: number, skip = 0, backend = "temupuffer") =>
    call<{ kind: string; commands: Command[] }>(`/jobs/commands?kind=${kind}&docs=${docs}&skip=${skip}&backend=${backend}`),
  startJob: (kind: JobKind, b: { docs: number; skip?: number; backend?: string }) => post<Jobs>(`/jobs/${kind}/start`, b),
  stopJob: (kind: JobKind) => post<Jobs>(`/jobs/${kind}/stop`, {}),
  reset: (b: { confirm: string; delete_embeddings: boolean; backend?: string }) =>
    post<{ ok: boolean; embedding_chunks_deleted: number }>("/reset", b),
};

export const fmtMs = (ms: number | null | undefined) =>
  ms == null ? "–" : ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : ms >= 10 ? `${Math.round(ms)} ms` : `${ms.toFixed(1)} ms`;

export const fmtInt = (n: number | null | undefined) => (n == null ? "–" : Math.round(n).toLocaleString("en-US"));
