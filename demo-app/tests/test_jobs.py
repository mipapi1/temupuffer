"""The Data card: Jobs started from the API are the Makefile's Jobs, with the same guardrails."""

from __future__ import annotations

import json

import httpx
import pyarrow as pa
import pytest
from fastapi.testclient import TestClient

from search import api, dataset
from search import jobs as J
from search.service import SearchService

IMAGE = "git.example.com/temupuffer-search@sha256:abc"


class FakeKube:
    """An in-memory Kubernetes API: Jobs by name, plus the API's own pod."""

    def __init__(self):
        self.jobs: dict[str, dict] = {}
        self.created: list[str] = []

    def handler(self, req: httpx.Request) -> httpx.Response:
        path = req.url.path
        if path.endswith("/pods/search-api-0"):
            return httpx.Response(200, json={"spec": {"containers": [{"image": IMAGE}]}})
        if path.endswith("/pods"):
            return httpx.Response(200, json={"items": []})
        if req.method == "POST" and path.endswith("/jobs"):
            text = req.content.decode()
            assert req.headers["content-type"] == "application/yaml"
            self.created.append(text)
            name = "search-embed" if "name: search-embed" in text else "search-load"
            docs = text.split('"--docs", "')[1].split('"')[0]
            self.jobs[name] = {"spec": {"completions": 3, "template": {"spec": {"containers": [
                {"command": ["python", "-m", "search.ingest", "x", "--docs", docs]}]}}}, "status": {"active": 1}}
            return httpx.Response(201, json=self.jobs[name])
        name = path.rsplit("/", 1)[1]
        if req.method == "GET":
            return httpx.Response(200, json=self.jobs[name]) if name in self.jobs else httpx.Response(404, json={})
        if req.method == "DELETE":
            self.jobs.pop(name, None)
            return httpx.Response(200, json={})
        return httpx.Response(405)

    def finish(self, name):
        self.jobs[name]["status"] = {"succeeded": 3, "conditions": [{"type": "Complete", "status": "True"}]}


@pytest.fixture
def kube(monkeypatch):
    monkeypatch.setenv("POD_NAME", "search-api-0")
    return FakeKube()


@pytest.fixture
def ctl(settings, kube, tmp_path):
    k = J.K8s(sa_dir=tmp_path / "no-sa", transport=httpx.MockTransport(kube.handler))
    return J.Jobs(settings, k8s=k)


def add_chunk(settings, rows=3):
    store = dataset.ChunkStore(settings.embeddings_uri)
    t = pa.table({"id": list(range(rows))})
    store.write(dataset.chunk_name(0, 0), t)


def test_render_is_the_makefile_job():
    y = J.render("embed", IMAGE, 1_000_000)
    assert f"image: {IMAGE}\n" in y and "__DOCS__" not in y
    assert '"--docs", "1000000"' in y
    assert 'cpu: "2"' in y   # the CPU limit that protects the rest of the cluster comes along
    y = J.render("load", IMAGE, 900_000, skip=100_000)
    assert '"--skip", "100000"' in y and '"--backend", "temupuffer"' in y


def test_start_uses_own_image_and_refuses_a_second_job(ctl, kube):
    ctl.start("embed", 1_000_000)
    assert f"image: {IMAGE}" in kube.created[0]
    assert ctl.status()["embed"]["state"] == "running"
    assert ctl.status()["embed"]["chunks_total"] == 100
    with pytest.raises(J.JobError) as e:
        ctl.start("load", 1_000)
    assert e.value.status == 409


def test_a_finished_job_is_replaced(ctl, kube, settings):
    add_chunk(settings)
    ctl.start("load", 1_000)
    kube.finish("search-load")
    ctl.start("load", 2_000)
    assert len(kube.created) == 2
    assert ctl.status()["load"]["docs"] == 2_000


def test_load_needs_embeddings_and_turbopuffer_has_a_cap(ctl, settings):
    with pytest.raises(J.JobError, match="no embeddings"):
        ctl.start("load", 1_000)
    with pytest.raises(J.JobError, match="yes-large"):
        ctl.start("load", 60_000, backend="turbopuffer")
    with pytest.raises(J.JobError, match="between"):
        ctl.start("embed", 5_000_000)
    add_chunk(settings, rows=7)
    assert ctl.embeddings(fresh=True) == {"chunks": 1, "docs": 7, "uri": settings.embeddings_uri}


def test_outside_kubernetes_status_says_so(settings, tmp_path):
    ctl = J.Jobs(settings, k8s=J.K8s(sa_dir=tmp_path / "none"))
    st = ctl.status()
    assert st["available"] is False and "Kubernetes" in st["reason"]


def _client(settings, embedder, backend, ctl):
    return TestClient(api.create_app(SearchService(settings, embedder, {"temupuffer": backend}), jobs_ctl=ctl))


def test_actions_are_off_unless_enabled(settings, embedder, backend, ctl, monkeypatch):
    monkeypatch.delenv("ADMIN_ACTIONS", raising=False)
    c = _client(settings, embedder, backend, ctl)
    assert c.get("/api/jobs").json()["actions_enabled"] is False
    assert c.post("/api/jobs/embed/start", json={"docs": 1000}).status_code == 403
    assert c.post("/api/reset", json={"confirm": settings.namespace}).status_code == 403


def test_reset_needs_the_namespace_name_and_can_drop_embeddings(settings, embedder, backend, ctl, monkeypatch):
    monkeypatch.setenv("ADMIN_ACTIONS", "1")
    add_chunk(settings)
    c = _client(settings, embedder, backend, ctl)
    assert c.post("/api/reset", json={"confirm": "nope"}).status_code == 400
    r = c.post("/api/reset", json={"confirm": settings.namespace, "delete_embeddings": True})
    assert r.status_code == 200, r.text
    assert r.json()["embedding_chunks_deleted"] == 1
    assert ("delete", settings.namespace) in backend.calls
    assert dataset.ChunkStore(settings.embeddings_uri).names() == []


def test_commands_describe_what_runs(settings, embedder, backend, ctl):
    c = _client(settings, embedder, backend, ctl)
    cmds = c.get("/api/jobs/commands", params={"kind": "load", "docs": 900000, "skip": 100000}).json()["commands"]
    text = json.dumps(cmds)
    assert "make search-load DOCS=900000 SKIP=100000" in text
    assert f"/v2/namespaces/{settings.namespace}" in text
    assert c.get("/api/jobs/commands", params={"kind": "bogus"}).status_code == 400
