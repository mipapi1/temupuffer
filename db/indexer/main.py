"""temupuffer indexer process: the indexing loop plus a tiny HTTP server.

The HTTP server exists for Kubernetes probes and for the console's "Under the
hood" page (current job, passes, compactions, request counts). It serves no
data. The indexer's real work is the loop in temupuffer/indexer.py.

Run locally:  cd db && ../.venv/bin/python -m indexer.main
"""

from __future__ import annotations

import hmac
import os
import sys
import threading

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from temupuffer import config, selftest, storage
from temupuffer.indexer import Indexer


def create_app(settings: config.Settings | None = None, store: storage.ObjectStore | None = None,
               start_loop: bool = True) -> FastAPI:
    s = settings or config.load()
    try:
        st, log = selftest.connect(s, store, role="indexer")
        for line in log:
            print(f"[selftest] {line}", flush=True)
    except selftest.SelfTestFailed as e:
        print("\n" + "=" * 78 + "\nFATAL: object storage CAS self-test failed\n" + str(e) + "\n" + "=" * 78,
              file=sys.stderr, flush=True)
        raise SystemExit(1)
    idx = Indexer(s, st, worker_id=os.environ.get("WORKER_ID") or f"indexer-{s.node_id}")
    if start_loop:
        threading.Thread(target=idx.run_forever, daemon=True, name="indexer").start()

    app = FastAPI(title="temupuffer indexer")
    app.state.indexer = idx

    @app.get("/healthz")
    def healthz():
        return {"ok": True}

    @app.get("/readyz")
    def readyz():
        # Not ready when the loop hasn't completed a step for READY_STALE_S,
        # e.g. object storage went away after startup. /healthz stays 200, so
        # Kubernetes marks the pod NotReady without restarting it (a restart
        # wouldn't bring the store back).
        ok, body = idx.readiness(s.indexer_ready_stale_s)
        return JSONResponse(body, status_code=200 if ok else 503)

    @app.get("/debug/node")
    def node(request: Request):
        header = request.headers.get("authorization", "")
        token = header[7:] if header.lower().startswith("bearer ") else ""
        if not hmac.compare_digest(token.encode(), s.api_key.encode()):
            raise HTTPException(401, "missing or invalid API key")
        return idx.stats()

    return app


def main() -> None:
    import uvicorn

    port = int(os.environ.get("PORT", "8081"))
    uvicorn.run(create_app(), host="0.0.0.0", port=port, log_level=os.environ.get("LOG_LEVEL", "info"),
                access_log=False)


if __name__ == "__main__":
    main()
