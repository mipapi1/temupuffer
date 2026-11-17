"""Start, watch and stop the ingest Jobs from the API (the Data card on the Scale page).

The same YAML templates as `make search-embed` / `make search-load` (search/jobs/*.yaml),
with the same substitutions, so a Job started from the UI is the Job you'd get from make,
including its CPU limits. The API talks to the Kubernetes API with its ServiceAccount
token; the Role (deploy/search/base/rbac.yaml) only allows Jobs and Pods in its own
namespace.

Outside Kubernetes (docker compose, local dev) `available` is False and the UI shows
the equivalent commands instead of buttons.
"""

from __future__ import annotations

import math
import os
import threading
import time
from pathlib import Path

import httpx
import pyarrow.parquet as pq

from . import dataset

TEMPLATES = Path(__file__).parent / "jobs"
SA_DIR = Path("/var/run/secrets/kubernetes.io/serviceaccount")
JOB_NAMES = {"embed": "search-embed", "load": "search-load"}
MAX_DOCS = int(os.environ.get("INGEST_MAX_DOCS", "1000000"))
TURBOPUFFER_UI_MAX = 50_000  # bigger writes to the paid account go through make + --yes-large


class JobError(Exception):
    def __init__(self, status: int, msg: str):
        super().__init__(msg)
        self.status = status


def render(kind: str, image: str, docs: int, skip: int = 0, backend: str = "temupuffer") -> str:
    """A Job manifest from its template: exactly what the Makefile's sed does."""
    text = (TEMPLATES / f"{kind}.yaml").read_text()
    text = text.replace("__DOCS__", str(docs)).replace("__SKIP__", str(skip)).replace("__BACKEND__", backend)
    return text.replace("image: temupuffer-search\n", f"image: {image}\n")


def commands(kind: str, ns: str, namespace: str, docs: int, skip: int = 0, backend: str = "temupuffer",
             embeddings_uri: str = "s3://temupuffer-search/embeddings") -> list[dict]:
    """What runs behind each button, for the (i) popovers: the make target, the Job, and the I/O."""
    if kind == "embed":
        return [
            {"label": "Same as", "code": f"make search-embed DOCS={docs}"},
            {"label": "Creates", "code": f"kubectl -n {ns} apply -f demo-app/search/jobs/embed.yaml   # Indexed Job, 3 pods × 2 CPU"},
            {"label": "Each pod runs", "code": f"python -m search.ingest embed --docs {docs} --workers 3 --tmp /shards"},
            {"label": "Reads", "code": "GET https://huggingface.co/datasets/librarian-bots/arxiv-metadata-snapshot/…/train-000NN-of-00011.parquet"},
            {"label": "Writes", "code": f"PUT {embeddings_uri}/chunk-SS-KKK.parquet   # 10,000 papers + 384-dim vectors each"},
        ]
    if kind == "load":
        return [
            {"label": "Same as", "code": f"make search-load DOCS={docs} SKIP={skip}" + (f" BACKEND={backend}" if backend != "temupuffer" else "")},
            {"label": "Creates", "code": f"kubectl -n {ns} apply -f demo-app/search/jobs/load.yaml"},
            {"label": "The pod runs", "code": f"python -m search.ingest load --docs {docs} --skip {skip} --backend {backend} --batch 2000 --concurrency 4 --wait-index 3600"},
            {"label": "Per batch", "code": f'POST /v2/namespaces/{namespace}  {{"upsert_rows": [2,000 rows]}}   # 429 → back off, retry'},
            {"label": "At the end", "code": f"GET /v1/namespaces/{namespace}/metadata   # until index.status = up-to-date"},
        ]
    if kind == "stop":
        return [
            {"label": "Same as", "code": f"kubectl -n {ns} delete job search-embed   # or search-load"},
            {"label": "Resume", "code": "Start it again: finished embedding chunks are skipped; a load continues with SKIP"},
        ]
    if kind == "reset":
        return [
            {"label": "Same as", "code": "make search-cleanup" + (f" BACKEND={backend}" if backend != "temupuffer" else "")},
            {"label": "Which runs", "code": f"python -m search.ingest cleanup --backend {backend}"},
            {"label": "Which sends", "code": f"DELETE /v2/namespaces/{namespace}"},
            {"label": "Optionally", "code": f"DELETE {embeddings_uri}/chunk-*.parquet   # then the next load needs a new embed"},
        ]
    raise ValueError(kind)


class K8s:
    """Just enough of the Kubernetes API, with the pod's ServiceAccount."""

    def __init__(self, sa_dir: Path = SA_DIR, base_url: str = "https://kubernetes.default.svc",
                 transport: httpx.BaseTransport | None = None):
        self.available = (sa_dir / "token").exists() or transport is not None
        self.ns = (sa_dir / "namespace").read_text().strip() if (sa_dir / "namespace").exists() else "temupuffer-search"
        self.http = None
        if self.available:
            token = (sa_dir / "token").read_text().strip() if (sa_dir / "token").exists() else "test"
            verify = str(sa_dir / "ca.crt") if (sa_dir / "ca.crt").exists() else True
            self.http = httpx.Client(base_url=base_url, headers={"Authorization": f"Bearer {token}"},
                                     verify=verify, timeout=15, transport=transport)

    def _req(self, method: str, path: str, **kw) -> httpx.Response:
        r = self.http.request(method, path, **kw)
        if r.status_code >= 400 and r.status_code != 404:
            raise JobError(502, f"Kubernetes API {r.status_code}: {r.text[:300]}")
        return r

    def get_job(self, name: str) -> dict | None:
        r = self._req("GET", f"/apis/batch/v1/namespaces/{self.ns}/jobs/{name}")
        return None if r.status_code == 404 else r.json()

    def create_job(self, manifest_yaml: str) -> dict:
        r = self._req("POST", f"/apis/batch/v1/namespaces/{self.ns}/jobs",
                      content=manifest_yaml, headers={"Content-Type": "application/yaml"})
        return r.json()

    def delete_job(self, name: str) -> None:
        self._req("DELETE", f"/apis/batch/v1/namespaces/{self.ns}/jobs/{name}",
                  params={"propagationPolicy": "Background"})

    def pods(self, job_name: str) -> list[dict]:
        r = self._req("GET", f"/api/v1/namespaces/{self.ns}/pods", params={"labelSelector": f"job-name={job_name}"})
        return [] if r.status_code == 404 else r.json().get("items", [])

    def own_image(self) -> str:
        """The image this API pod runs: Jobs use the same build (pinned digest)."""
        pod = os.environ.get("POD_NAME", "")
        r = self._req("GET", f"/api/v1/namespaces/{self.ns}/pods/{pod}")
        if r.status_code == 404:
            raise JobError(500, f"can't read my own pod {pod!r} (POD_NAME unset?)")
        return r.json()["spec"]["containers"][0]["image"]


def summarize(job: dict | None, pods: list[dict]) -> dict:
    if job is None:
        return {"state": "none"}
    st, spec = job.get("status", {}), job.get("spec", {})
    conds = {c["type"]: c["status"] for c in st.get("conditions", [])}
    if conds.get("Complete") == "True":
        state = "succeeded"
    elif conds.get("Failed") == "True":
        state = "failed"
    elif st.get("active"):
        state = "running"
    else:
        state = "starting"
    cmd = spec["template"]["spec"]["containers"][0].get("command", [])
    arg = lambda flag: int(cmd[cmd.index(flag) + 1]) if flag in cmd else None  # noqa: E731
    return {
        "state": state, "active": st.get("active", 0), "succeeded": st.get("succeeded", 0),
        "failed": st.get("failed", 0), "completions": spec.get("completions", 1),
        "started_at": st.get("startTime"), "finished_at": st.get("completionTime"),
        "docs": arg("--docs"), "skip": arg("--skip"),
        "pods": [{"name": p["metadata"]["name"], "phase": p["status"].get("phase"),
                  "node": p["spec"].get("nodeName")} for p in pods],
    }


class Jobs:
    def __init__(self, settings, k8s: K8s | None = None, store=None):
        self.s = settings
        self.k8s = k8s if k8s is not None else K8s()
        self._store = store
        self._rows: dict[str, int] = {}   # chunk name -> rows (chunks are immutable)
        self._emb_cache: tuple[float, dict] | None = None
        self.lock = threading.Lock()      # one start/stop/reset at a time

    @property
    def store(self):
        if self._store is None:
            self._store = dataset.ChunkStore(self.s.embeddings_uri, self.s.s3_endpoint)
        return self._store

    # --- embeddings in object storage ---

    def embeddings(self, fresh: bool = False) -> dict:
        now = time.time()
        if not fresh and self._emb_cache and now - self._emb_cache[0] < 5:
            return self._emb_cache[1]
        try:
            names = self.store.names()
            for n in names:
                if n not in self._rows:
                    self._rows[n] = self.store.rows(n)
            out = {"chunks": len(names), "docs": sum(self._rows[n] for n in names), "uri": self.store.uri}
        except Exception as e:  # noqa: BLE001 - shown on the card
            out = {"chunks": 0, "docs": 0, "uri": self.s.embeddings_uri, "error": str(e)[:200]}
        self._emb_cache = (now, out)
        return out

    # --- status ---

    def status(self) -> dict:
        emb = self.embeddings()
        out = {"available": self.k8s.available, "namespace": self.k8s.ns, "max_docs": MAX_DOCS,
               "embeddings": emb, "embed": {"state": "none"}, "load": {"state": "none"}}
        if not self.k8s.available:
            out["reason"] = "Not running in Kubernetes, so the buttons are off"
            return out
        for kind, name in JOB_NAMES.items():
            job = self.k8s.get_job(name)
            out[kind] = summarize(job, self.k8s.pods(name) if job else [])
        e = out["embed"]
        if e.get("docs"):
            e["chunks_total"] = math.ceil(e["docs"] / dataset.CHUNK_ROWS)
        return out

    def running(self) -> str | None:
        for kind, name in JOB_NAMES.items():
            if summarize(self.k8s.get_job(name), [])["state"] in ("running", "starting"):
                return kind
        return None

    # --- actions ---

    def start(self, kind: str, docs: int, skip: int = 0, backend: str = "temupuffer") -> dict:
        if kind not in JOB_NAMES:
            raise JobError(400, f"unknown job {kind!r}")
        if not self.k8s.available:
            raise JobError(503, "not running in Kubernetes; use the make command instead")
        if not 1_000 <= docs <= MAX_DOCS:
            raise JobError(400, f"docs must be between 1,000 and {MAX_DOCS:,}")
        if skip < 0:
            raise JobError(400, "skip must be ≥ 0")
        if kind == "load" and backend == "turbopuffer" and docs > TURBOPUFFER_UI_MAX:
            raise JobError(400, f"more than {TURBOPUFFER_UI_MAX:,} docs to turbopuffer (paid) only via make with --yes-large")
        with self.lock:
            busy = self.running()
            if busy:
                raise JobError(409, f"the {busy} job is still running; stop it or wait")
            if kind == "load" and self.embeddings(fresh=True)["chunks"] == 0:
                raise JobError(409, "no embeddings yet: run Embed first")
            name = JOB_NAMES[kind]
            if self.k8s.get_job(name) is not None:   # a finished run with the same name: replace it, like make does
                self.k8s.delete_job(name)
                for _ in range(60):
                    if self.k8s.get_job(name) is None:
                        break
                    time.sleep(0.5)
                else:
                    raise JobError(504, f"old {name} Job is still being deleted; try again in a moment")
            self.k8s.create_job(render(kind, self.k8s.own_image(), docs, skip, backend))
        return self.status()

    def stop(self, kind: str) -> dict:
        if kind not in JOB_NAMES:
            raise JobError(400, f"unknown job {kind!r}")
        if not self.k8s.available:
            raise JobError(503, "not running in Kubernetes")
        with self.lock:
            self.k8s.delete_job(JOB_NAMES[kind])
        return self.status()

    def delete_embeddings(self) -> int:
        n = self.store.delete_chunks()
        self._rows.clear()
        self._emb_cache = None
        return n
