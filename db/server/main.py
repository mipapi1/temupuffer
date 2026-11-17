"""temupuffer query node: the HTTP API.

Routes follow turbopuffer's paths (docs: Write, Query, Metadata, Namespaces,
Delete namespace, Warm cache). turbopuffer mixes /v1 and /v2, and so do we:

    POST   /v2/namespaces/{ns}                    write (upsert_rows, upsert_columns, deletes, schema, ...)
    POST   /v2/namespaces/{ns}/query              query (rank_by, filters, limit/top_k, consistency, queries)
    DELETE /v2/namespaces/{ns}                    delete a namespace and all its data
    GET    /v1/namespaces                         list namespaces (prefix, cursor, page_size)
    GET    /v1/namespaces/{ns}/metadata           schema, row count, index status
    GET    /v1/namespaces/{ns}/hint_cache_warm    start loading a namespace into this node's cache

temupuffer only (the console's "Under the hood" page):

    GET /debug/node                    this node's counters, cache, writers, recent events
    GET /debug/cluster                 /debug/node from every query node and indexer
    GET /debug/namespaces/{ns}/wal     the WAL strip: every entry, indexed or not, + manifest
    GET /debug/queue                   queue.json as it is right now
    GET /healthz  /readyz              Kubernetes probes (no auth)

Auth: ``Authorization: Bearer <API_KEY>``, the same header turbopuffer uses.

Run locally:  cd db && STORE=memory ../.venv/bin/python -m server.main
"""

from __future__ import annotations

import hmac
import json
import os
import socket
import sys
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager

import anyio
import httpx
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from temupuffer import config, jobqueue, selftest, storage  # noqa: F401
from temupuffer.engine import Engine
from temupuffer.errors import ApiError


def create_app(settings: config.Settings | None = None, store: storage.ObjectStore | None = None) -> FastAPI:
    s = settings or config.load()
    # Wait for object storage (it may still be starting), then run the CAS
    # self-test. A store that ignores If-None-Match or If-Match is fatal.
    try:
        st, log = selftest.connect(s, store, role="query")
    except selftest.SelfTestFailed as e:
        print("\n" + "=" * 78 + "\nFATAL: object storage CAS self-test failed\n" + str(e) + "\n" + "=" * 78,
              file=sys.stderr, flush=True)
        raise SystemExit(1)
    for line in log:
        print(f"[selftest] {line}", flush=True)
    state = {"ready": False, "selftest": log}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        # Sync handlers run in a thread pool. A write blocks its thread for up
        # to ~1 s while it waits for the group commit, so allow plenty of threads.
        anyio.to_thread.current_default_thread_limiter().total_tokens = 256
        state["ready"] = True
        yield

    app = FastAPI(title="temupuffer", version="0.1.0", lifespan=lifespan)
    app.state.engine = engine = Engine(s, st)
    origins = [o for o in os.environ.get("CORS_ORIGINS", "").split(",") if o]
    if origins:
        app.add_middleware(CORSMiddleware, allow_origins=origins, allow_methods=["*"], allow_headers=["*"])

    @app.exception_handler(ApiError)
    async def api_error(_: Request, e: ApiError):
        return JSONResponse({"status": "error", "error": e.message}, status_code=e.status)

    def auth(request: Request) -> None:
        header = request.headers.get("authorization", "")
        token = header[7:] if header.lower().startswith("bearer ") else ""
        if not hmac.compare_digest(token.encode(), s.api_key.encode()):
            raise HTTPException(401, "missing or invalid API key (use Authorization: Bearer <key>)")

    async def json_body(request: Request) -> dict:
        length = int(request.headers.get("content-length") or 0)
        if length > s.max_request_bytes:
            raise HTTPException(413, f"request body over {s.max_request_bytes} bytes")
        raw = await request.body()
        try:
            return json.loads(raw or b"{}")
        except json.JSONDecodeError as e:
            raise HTTPException(400, f"invalid JSON: {e}") from None

    # --- turbopuffer-shaped API ---------------------------------------------------

    @app.post("/v2/namespaces/{ns}", dependencies=[Depends(auth)])
    async def write(ns: str, request: Request):
        return await run_in_threadpool(engine.write, ns, await json_body(request))

    @app.post("/v2/namespaces/{ns}/query", dependencies=[Depends(auth)])
    async def query(ns: str, request: Request):
        return await run_in_threadpool(engine.query, ns, await json_body(request))

    @app.delete("/v2/namespaces/{ns}", dependencies=[Depends(auth)])
    async def delete_namespace(ns: str):
        return await run_in_threadpool(engine.delete_namespace, ns)

    @app.get("/v1/namespaces", dependencies=[Depends(auth)])
    async def list_namespaces(prefix: str = "", cursor: str | None = None, page_size: int = 100):
        return await run_in_threadpool(engine.list_namespaces, prefix, cursor, page_size)

    @app.get("/v1/namespaces/{ns}/metadata", dependencies=[Depends(auth)])
    async def metadata(ns: str):
        return await run_in_threadpool(engine.metadata, ns)

    @app.get("/v1/namespaces/{ns}/hint_cache_warm", dependencies=[Depends(auth)])
    async def hint_cache_warm(ns: str):
        return await run_in_threadpool(engine.warm, ns)

    # --- the console ----------------------------------------------------------------

    @app.get("/debug/node", dependencies=[Depends(auth)])
    async def debug_node():
        return await run_in_threadpool(engine.node_stats)

    @app.get("/debug/cluster", dependencies=[Depends(auth)])
    async def debug_cluster():
        return await run_in_threadpool(cluster_stats, s, engine)

    @app.get("/debug/namespaces/{ns}/wal", dependencies=[Depends(auth)])
    async def debug_wal(ns: str, limit: int = 400):
        return await run_in_threadpool(engine.wal_state, ns, min(max(limit, 1), 2000))

    @app.get("/debug/queue", dependencies=[Depends(auth)])
    async def debug_queue():
        doc, etag = await run_in_threadpool(jobqueue.read, st)
        return {"etag": etag, **doc}

    @app.get("/healthz")
    async def healthz():
        return {"ok": True}

    @app.get("/readyz")
    async def readyz():
        if not state["ready"]:
            raise HTTPException(503, "starting")
        return {"ok": True, "node": s.node_id, "selftest": state["selftest"], "store": engine.store.describe()}

    return app


_fanout = ThreadPoolExecutor(max_workers=16)


def _peer_urls(urls: str, dns: str, port: int) -> list[str]:
    """Explicit URLs, or every IP behind a headless Service's DNS name."""
    if urls:
        return [u.rstrip("/") for u in urls.split(",") if u]
    if dns:
        try:
            ips = sorted({ai[4][0] for ai in socket.getaddrinfo(dns, port, proto=socket.IPPROTO_TCP)})
        except socket.gaierror:
            return []
        return [f"http://{ip}:{port}" for ip in ips]
    return []


def cluster_stats(s: config.Settings, engine: Engine) -> dict:
    """Ask every node for its stats. If no peers are configured, report just this one."""
    headers = {"authorization": f"Bearer {s.api_key}"}
    query_urls = _peer_urls(s.peer_urls, s.peer_dns, s.peer_port)
    indexer_urls = _peer_urls(s.indexer_urls, s.indexer_dns, s.indexer_port)

    def fetch(url: str) -> dict:
        try:
            r = httpx.get(f"{url}/debug/node", headers=headers, timeout=2.0)
            r.raise_for_status()
            return {"url": url, "ok": True, **r.json()}
        except Exception as e:
            return {"url": url, "ok": False, "error": str(e)}

    nodes = list(_fanout.map(fetch, query_urls)) if query_urls else [{"url": "self", "ok": True, **engine.node_stats()}]
    indexers = list(_fanout.map(fetch, indexer_urls))
    return {"query_nodes": nodes, "indexers": indexers}


def main() -> None:
    import uvicorn

    port = int(os.environ.get("PORT", "8080"))
    uvicorn.run(create_app(), host="0.0.0.0", port=port, log_level=os.environ.get("LOG_LEVEL", "info"),
                access_log=os.environ.get("ACCESS_LOG", "false") == "true")


if __name__ == "__main__":
    main()
