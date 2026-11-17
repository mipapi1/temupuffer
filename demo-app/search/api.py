"""The search API (FastAPI). The UI calls this; this calls the database through SearchBackend.

    GET  /api/config            backends, namespace, fields, years: what the UI needs to draw itself
    POST /api/search            one search (mode keyword|vector|hybrid, filters, consistency, backend)
    POST /api/compare           the same search on every mode, or on both backends
    POST /api/demo/cold-warm    the same query twice: cache temperature before and after
    POST /api/demo/write-read   upsert a probe doc, read it back eventual then strong, delete it
    GET  /api/stats             namespace size + history, ingest progress, live latency percentiles
    POST /api/bench             start a load test;  GET /api/bench  its progress and results
    POST /api/ingest/progress   the load job reports here (shown on the Scale page)
    GET  /api/jobs              embed/load Job status + embeddings in object storage
    GET  /api/jobs/commands     what a button runs behind the scenes (the (i) popovers)
    POST /api/jobs/{kind}/start|stop    start or stop the embed or load Job (ADMIN_ACTIONS=1)
    POST /api/reset             delete the search namespace (and optionally the embeddings)

Run locally:  uvicorn search.api:app --port 8090
"""

from __future__ import annotations

import os
import threading
import time

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from . import backends as B
from . import config, dataset, embed
from . import jobs as J
from . import queries as Q
from .service import SearchService


class FiltersIn(BaseModel):
    field: str | None = None
    category: str | None = None
    year_min: int | None = None
    year_max: int | None = None


class SearchIn(BaseModel):
    q: str = Field(min_length=1, max_length=500)
    mode: str = "hybrid"
    filters: FiltersIn = FiltersIn()
    consistency: str = "strong"
    limit: int = Field(10, ge=1, le=50)
    backend: str | None = None


class CompareIn(SearchIn):
    across: str = "modes"   # modes | backends


class JobIn(BaseModel):
    docs: int = Field(100_000, ge=1_000, le=J.MAX_DOCS)
    skip: int = Field(0, ge=0)
    backend: str = "temupuffer"


class ResetIn(BaseModel):
    confirm: str                      # must equal the namespace name
    delete_embeddings: bool = False
    backend: str = "temupuffer"


class BenchIn(BaseModel):
    seconds: int = Field(30, ge=5, le=300)
    concurrency: int = Field(4, ge=1, le=16)   # turbopuffer: 16 concurrent queries per unpinned namespace
    modes: list[str] = ["hybrid", "keyword", "vector"]
    consistency: str = "strong"
    backend: str | None = None
    recall_samples: int = Field(20, ge=0, le=50)


def to_req(body: SearchIn) -> Q.SearchRequest:
    if body.mode not in Q.MODES:
        raise HTTPException(400, f"mode must be one of {Q.MODES}")
    if body.consistency not in ("strong", "eventual"):
        raise HTTPException(400, "consistency must be strong or eventual")
    return Q.SearchRequest(q=body.q.strip(), mode=body.mode, filters=Q.Filters(**body.filters.model_dump()),
                           consistency=body.consistency, limit=body.limit)


def create_app(service: SearchService | None = None, jobs_ctl: "J.Jobs | None" = None) -> FastAPI:
    s = config.load()
    if service is None:
        backends = {"temupuffer": B.make("temupuffer", s)}
        if s.turbopuffer_enabled:
            backends["turbopuffer"] = B.make("turbopuffer", s)
        service = SearchService(s, embed.make(s), backends)
    svc = service
    app = FastAPI(title="temupuffer search")
    app.state.service = svc

    def call(fn, *a, **kw):
        try:
            return fn(*a, **kw)
        except B.Backpressure as e:
            raise HTTPException(429, f"database backpressure: {e}") from e
        except B.BackendError as e:
            raise HTTPException(502, str(e)) from e

    if os.environ.get("SAMPLE_METADATA", "1") == "1":
        def sampler():
            while True:
                svc.sample_metadata()
                time.sleep(5)
        threading.Thread(target=sampler, daemon=True, name="metadata-sampler").start()

    @app.get("/healthz")
    def healthz():
        return {"ok": True}

    @app.get("/api/config")
    def get_config():
        return {"backends": list(svc.backends), "default_backend": svc.s.backend, "namespace": svc.ns,
                "turbopuffer_prefix": svc.s.turbopuffer_prefix if "turbopuffer" in svc.backends else None,
                "fields": dataset.FIELD_NAMES, "modes": list(Q.MODES), "model": svc.s.embed_model,
                "dataset": dataset.HF_REPO}

    @app.post("/api/search")
    def search(body: SearchIn):
        return call(svc.search, to_req(body), body.backend)

    @app.post("/api/compare")
    def compare(body: CompareIn):
        req = to_req(body)
        if body.across == "backends":
            out = {}
            for name in svc.backends:
                try:
                    out[name] = svc.search(req, name)
                except (B.BackendError, B.Backpressure) as e:
                    out[name] = {"error": str(e)}
            return {"across": "backends", "columns": out}
        cols = {}
        for mode in Q.MODES:
            cols[mode] = call(svc.search, Q.SearchRequest(**{**req.__dict__, "mode": mode}), body.backend)
        return {"across": "modes", "columns": cols}

    @app.post("/api/demo/cold-warm")
    def cold_warm(body: SearchIn):
        return call(svc.cold_warm, to_req(body), body.backend)

    @app.post("/api/demo/write-read")
    def write_read(backend: str | None = None):
        return call(svc.write_then_read, backend)

    @app.get("/api/stats")
    def stats():
        meta = None
        try:
            meta = svc.backend(None).metadata(svc.ns)
        except Exception as e:  # noqa: BLE001 - shown in the UI instead
            meta = {"error": str(e)[:300]}
        return {"namespace": svc.ns, "backend": svc.s.backend, "metadata": meta,
                "history": list(svc.history), "ingest": svc.ingest, "latency": svc.latency_summary(),
                "bench": svc.bench}

    @app.post("/api/bench")
    def bench(body: BenchIn):
        bad = [m for m in body.modes if m not in Q.MODES]
        if bad or not body.modes:
            raise HTTPException(400, f"modes must be a non-empty subset of {Q.MODES}")
        return call(svc.start_bench, body.seconds, body.concurrency, body.modes, body.consistency,
                    body.backend, body.recall_samples)

    @app.get("/api/bench")
    def bench_status():
        return svc.bench

    @app.post("/api/ingest/progress")
    def ingest_progress(p: dict):
        svc.ingest_progress(p)
        return {"ok": True}

    # --- the Data card: start/stop Jobs, reset (only with ADMIN_ACTIONS=1) ---------------
    jobs = jobs_ctl if jobs_ctl is not None else J.Jobs(svc.s)
    actions = os.environ.get("ADMIN_ACTIONS", "") == "1"

    def guarded(fn, *a):
        if not actions:
            raise HTTPException(403, "actions are off on this deployment (ADMIN_ACTIONS=1 turns them on)")
        try:
            return fn(*a)
        except J.JobError as e:
            raise HTTPException(e.status, str(e)) from e

    @app.get("/api/jobs")
    def jobs_status():
        try:
            return {**jobs.status(), "actions_enabled": actions}
        except J.JobError as e:
            raise HTTPException(e.status, str(e)) from e

    @app.get("/api/jobs/commands")
    def jobs_commands(kind: str, docs: int = 100_000, skip: int = 0, backend: str = "temupuffer"):
        try:
            return {"kind": kind, "commands": J.commands(kind, jobs.k8s.ns, svc.ns, docs, skip, backend, svc.s.embeddings_uri)}
        except ValueError:
            raise HTTPException(400, f"unknown kind {kind!r}") from None

    @app.post("/api/jobs/{kind}/start")
    def job_start(kind: str, body: JobIn):
        if body.backend not in svc.backends:
            raise HTTPException(400, f"backend {body.backend!r} isn't configured")
        return guarded(jobs.start, kind, body.docs, body.skip, body.backend)

    @app.post("/api/jobs/{kind}/stop")
    def job_stop(kind: str):
        return guarded(jobs.stop, kind)

    @app.post("/api/reset")
    def reset(body: ResetIn):
        if body.confirm != svc.ns:
            raise HTTPException(400, f"type the namespace name ({svc.ns}) to confirm")
        if body.backend not in svc.backends:
            raise HTTPException(400, f"backend {body.backend!r} isn't configured")

        def do():
            if jobs.k8s.available and jobs.running():
                raise J.JobError(409, "a job is running; stop it first")
            svc.backends[body.backend].delete_namespace(svc.ns)
            svc.reset_state()
            deleted = jobs.delete_embeddings() if body.delete_embeddings else 0
            return {"ok": True, "namespace": svc.ns, "backend": body.backend, "embedding_chunks_deleted": deleted}

        return guarded(do)

    return app


def __getattr__(name):  # `uvicorn search.api:app` builds the app lazily
    if name == "app":
        globals()["app"] = create_app()
        return globals()["app"]
    raise AttributeError(name)
