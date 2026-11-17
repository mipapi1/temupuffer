"""What the API does, independent of HTTP: searches, demos, stats, ingest progress, benchmarks."""

from __future__ import annotations

import copy
import random
import secrets
import statistics
import threading
import time
from collections import deque

from . import queries as Q
from .backends import BackendError, SearchBackend
from .embed import timed_embed

# Realistic questions across arXiv fields, used by the benchmark.
BENCH_QUERIES = [
    "vector databases on object storage", "approximate nearest neighbor search graph index",
    "retrieval augmented generation with large language models", "diffusion models for image synthesis",
    "reinforcement learning from human feedback", "transformer attention efficiency long context",
    "graph neural networks for molecules", "federated learning privacy", "contrastive self-supervised learning",
    "quantum error correction surface code", "variational quantum eigensolver", "topological insulators",
    "superconductivity in twisted bilayer graphene", "dark matter direct detection", "gravitational wave detection",
    "exoplanet atmospheres transmission spectroscopy", "black hole information paradox", "neutrino oscillations",
    "cosmic microwave background anisotropies", "galaxy formation simulations", "Higgs boson decay channels",
    "lattice QCD", "string theory compactification", "Bayesian inference Markov chain Monte Carlo",
    "high dimensional statistics sparse regression", "causal inference observational data",
    "time series forecasting deep learning", "prime numbers distribution", "elliptic curves rank",
    "random matrix theory", "optimal transport", "convex optimization first order methods",
    "stochastic differential equations", "protein structure prediction", "epidemic models COVID-19",
    "portfolio optimization", "speech recognition end to end", "image segmentation medical imaging",
    "autonomous driving perception", "recommender systems collaborative filtering",
    "compiler optimization", "distributed consensus protocols", "write-ahead logging durability",
    "cache replacement policies", "learned index structures", "full text search ranking BM25",
    "adversarial examples robustness", "knowledge graphs embeddings", "climate model downscaling",
    "machine translation low resource languages",
]


def percentile(xs: list[float], p: float) -> float | None:
    if not xs:
        return None
    s = sorted(xs)
    k = min(len(s) - 1, max(0, round(p / 100 * (len(s) - 1))))
    return round(s[k], 2)


def summarize(xs: list[float]) -> dict:
    return {"count": len(xs), "p50": percentile(xs, 50), "p90": percentile(xs, 90), "p99": percentile(xs, 99),
            "mean": round(statistics.fmean(xs), 2) if xs else None}


def redact_vectors(body):
    """Requests are shown in the UI; a 384-float vector is noise, so abbreviate it."""
    b = copy.deepcopy(body)

    def walk(x):
        if isinstance(x, list):
            if len(x) == 3 and x[0] == "vector" and isinstance(x[2], list):
                return ["vector", x[1], f"[{x[2][0]:.4f}, {x[2][1]:.4f}, … {len(x[2])} floats]"]
            return [walk(i) for i in x]
        if isinstance(x, dict):
            return {k: walk(v) for k, v in x.items()}
        return x

    return walk(b)


class SearchService:
    def __init__(self, settings, embedder, backends: dict[str, SearchBackend]):
        self.s = settings
        self.embedder = embedder
        self.backends = backends
        self.ns = settings.namespace
        self.latency: dict[tuple[str, str], deque] = {}
        self.ingest: dict | None = None
        self.history: deque = deque(maxlen=1440)   # (t, rows, unindexed) every 5 s: 2 hours
        self.bench: dict = {"state": "idle"}
        self._bench_lock = threading.Lock()
        self._qvec_cache: dict[str, list[float]] = {}

    def backend(self, name: str | None) -> SearchBackend:
        name = name or self.s.backend
        if name not in self.backends:
            raise BackendError(f"backend {name!r} isn't configured")
        return self.backends[name]

    # --- search ------------------------------------------------------------------------------

    def _vec(self, text: str) -> tuple[list[float], float]:
        if text in self._qvec_cache:
            return self._qvec_cache[text], 0.0
        v, ms = timed_embed(self.embedder, text)
        if len(self._qvec_cache) > 2000:
            self._qvec_cache.clear()
        self._qvec_cache[text] = v
        return v, ms

    def search(self, req: Q.SearchRequest, backend: str | None = None, record: bool = True) -> dict:
        b = self.backend(backend)
        t0 = time.perf_counter()
        embed_ms = 0.0
        v = None
        if req.mode in ("vector", "hybrid"):
            v, embed_ms = self._vec(req.q)
        if req.mode == "keyword":
            body = Q.single_body(Q.keyword_rank(req.q), req, req.limit)
            resp = b.query(self.ns, body)
            results = Q.cards(resp.get("rows", []), "keyword")
            request = body
        elif req.mode == "vector":
            body = Q.single_body(Q.vector_rank(v), req, req.limit)
            resp = b.query(self.ns, body)
            results = Q.cards(resp.get("rows", []), "vector")
            request = body
        elif req.mode == "hybrid":
            subs = [Q.sub_query(Q.vector_rank(v), req, Q.HYBRID_DEPTH),
                    Q.sub_query(Q.keyword_rank(req.q), req, Q.HYBRID_DEPTH)]
            resp = b.multi_query(self.ns, subs, Q.consistency(req.consistency))
            res = resp.get("results", [])
            vec_rows = res[0].get("rows", []) if len(res) > 0 else []
            kw_rows = res[1].get("rows", []) if len(res) > 1 else []
            results = Q.rrf({"vector": vec_rows, "keyword": kw_rows}, req.limit)
            request = {"queries": subs, "consistency": Q.consistency(req.consistency)}
        else:
            raise BackendError(f"unknown mode {req.mode!r}")
        total_ms = (time.perf_counter() - t0) * 1000
        perf = resp.get("performance") or {}
        out = {
            "backend": b.name, "mode": req.mode, "results": results,
            "timing": {"embed_ms": round(embed_ms, 2), "database_ms": resp.get("client_ms"),
                       "server_ms": perf.get("server_total_ms"), "total_ms": round(total_ms, 2)},
            "performance": perf, "request": redact_vectors(request), "routed_to": resp.get("routed_to"),
        }
        if record:
            self.latency.setdefault((b.name, req.mode), deque(maxlen=1000)).append(total_ms)
        return out

    # --- demos ---------------------------------------------------------------------------------

    def cold_warm(self, req: Q.SearchRequest, backend: str | None = None) -> dict:
        """Run the same query twice. The first run pays for any cache misses; the second shouldn't."""
        runs = []
        for label in ("first run", "repeat"):
            r = self.search(req, backend, record=False)
            p = r["performance"]
            runs.append({"label": label, "server_ms": p.get("server_total_ms"), "total_ms": r["timing"]["total_ms"],
                         "cache_temperature": p.get("cache_temperature"), "cache_hit_ratio": p.get("cache_hit_ratio"),
                         "round_trips": p.get("object_storage_round_trips")})
        return {"backend": self.backend(backend).name, "runs": runs}

    def write_then_read(self, backend: str | None = None) -> dict:
        """Upsert one probe doc, then look for it with eventual and with strong consistency, then delete it."""
        b = self.backend(backend)
        token = "probe" + secrets.token_hex(4)
        probe_id = 9_000_000_000 + random.randrange(1_000_000)
        title = f"Write-then-read probe {token}"
        vec, _ = timed_embed(self.embedder, title)
        steps = []
        w = b.write(self.ns, upsert_rows=[{"id": probe_id, "title": title, "abstract": f"A temporary document ({token}).",
                                           "authors": "temupuffer search", "arxiv_id": "", "category": "demo",
                                           "field": "Demo", "year": 2026, "vector": vec}])
        steps.append({"step": "write", "ms": w.get("client_ms"), "detail": "acknowledged: durable in the WAL"})
        try:
            for level in ("eventual", "strong"):
                r = b.query(self.ns, {"rank_by": ["title", "BM25", token], "top_k": 1,
                                      "consistency": {"level": level}})
                found = any(row.get("id") == probe_id for row in r.get("rows", []))
                p = r.get("performance") or {}
                steps.append({"step": f"query ({level})", "ms": r.get("client_ms"), "found": found,
                              "exhaustive_search_count": p.get("exhaustive_search_count"),
                              "view_age_ms": p.get("view_age_ms")})
        finally:
            b.write(self.ns, deletes=[probe_id])
            steps.append({"step": "delete probe", "ms": None, "detail": "cleaned up"})
        return {"backend": b.name, "token": token, "steps": steps}

    # --- stats ---------------------------------------------------------------------------------

    def latency_summary(self) -> list[dict]:
        return [{"backend": k[0], "mode": k[1], **summarize(list(v))} for k, v in sorted(self.latency.items())]

    def sample_metadata(self) -> None:
        try:
            m = self.backend(None).metadata(self.ns)
        except Exception:
            return
        if m is None:
            return
        idx = m.get("index") or {}
        self.history.append({"t": round(time.time()), "rows": m.get("approx_row_count", 0),
                             "unindexed": idx.get("unindexed_rows", 0)})

    def reset_state(self) -> None:
        """After a namespace reset: forget the old run's progress and history (latency stats stay)."""
        self.ingest = None
        self.history.clear()

    def ingest_progress(self, p: dict) -> None:
        self.ingest = {**p, "received_at": time.time()}

    # --- benchmark -----------------------------------------------------------------------------

    def start_bench(self, seconds: int, concurrency: int, modes: list[str], level: str,
                    backend: str | None, recall_samples: int = 20) -> dict:
        with self._bench_lock:
            if self.bench.get("state") == "running":
                return self.bench
            self.bench = {"state": "running", "started": time.time(), "seconds": seconds,
                          "concurrency": concurrency, "modes": modes, "consistency": level,
                          "backend": self.backend(backend).name}
        threading.Thread(target=self._run_bench, args=(seconds, concurrency, modes, level, backend, recall_samples),
                         daemon=True).start()
        return self.bench

    def _run_bench(self, seconds, concurrency, modes, level, backend, recall_samples):
        try:
            for q in BENCH_QUERIES:   # embed up front so the measurement is the database, not the model
                self._vec(q)
            lat: dict[str, list[float]] = {m: [] for m in modes}
            server: dict[str, list[float]] = {m: [] for m in modes}
            temps: dict[str, int] = {}
            errors: list[str] = []
            deadline = time.time() + seconds
            lock = threading.Lock()

            def worker():
                rng = random.Random()
                while time.time() < deadline:
                    mode = rng.choice(modes)
                    req = Q.SearchRequest(q=rng.choice(BENCH_QUERIES), mode=mode, consistency=level)
                    try:
                        r = self.search(req, backend, record=False)
                        with lock:
                            lat[mode].append(r["timing"]["total_ms"] - r["timing"]["embed_ms"])
                            if r["timing"]["server_ms"] is not None:
                                server[mode].append(r["timing"]["server_ms"])
                            t = r["performance"].get("cache_temperature") or "?"
                            temps[t] = temps.get(t, 0) + 1
                    except Exception as e:  # noqa: BLE001 - every failure is a result here
                        with lock:
                            errors.append(str(e)[:200])

            threads = [threading.Thread(target=worker, daemon=True) for _ in range(concurrency)]
            for t in threads:
                t.start()
            while any(t.is_alive() for t in threads):
                self.bench["elapsed"] = round(time.time() - self.bench["started"], 1)
                self.bench["done_queries"] = sum(len(v) for v in lat.values())
                time.sleep(0.5)
            total = sum(len(v) for v in lat.values())
            result = {
                "qps": round(total / seconds, 1),
                "by_mode": {m: {"client": summarize(lat[m]), "server": summarize(server[m])} for m in modes},
                "cache_temperature": temps, "errors": len(errors), "error_samples": errors[:5],
            }
            self.bench.update(state="measuring recall", result=result)
            result["recall"] = self.recall_at_10(recall_samples, backend)
            self.bench.update(state="done", finished=time.time(), result=result)
        except Exception as e:  # noqa: BLE001
            self.bench.update(state="error", error=str(e)[:500])

    def recall_at_10(self, samples: int, backend: str | None) -> dict:
        """ANN vs exact kNN on the same snapshot: what fraction of the true top 10 did ANN find?"""
        b = self.backend(backend)
        qs = random.sample(BENCH_QUERIES, min(samples, len(BENCH_QUERIES)))
        recalls, knn_ms, ann_ms = [], [], []
        for q in qs:
            v, _ = self._vec(q)
            r = b.multi_query(self.ns, [{"rank_by": Q.vector_rank(v), "top_k": 10},
                                        {"rank_by": Q.vector_rank(v, exact=True), "top_k": 10}],
                              {"level": "strong"})
            ann = {row["id"] for row in r["results"][0].get("rows", [])}
            exact = {row["id"] for row in r["results"][1].get("rows", [])}
            if exact:
                recalls.append(len(ann & exact) / len(exact))
            # A separate exact run, to show what brute force costs at this size.
            t = b.query(self.ns, {"rank_by": Q.vector_rank(v, exact=True), "top_k": 10})
            knn_ms.append((t.get("performance") or {}).get("server_total_ms") or t["client_ms"])
            a = b.query(self.ns, {"rank_by": Q.vector_rank(v), "top_k": 10})
            ann_ms.append((a.get("performance") or {}).get("server_total_ms") or a["client_ms"])
        return {"samples": len(recalls), "recall_at_10": round(statistics.fmean(recalls), 3) if recalls else None,
                "ann_server_ms_p50": percentile(ann_ms, 50), "exact_server_ms_p50": percentile(knn_ms, 50)}
