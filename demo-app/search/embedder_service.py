"""The embedder service: POST /embed {"texts": [...]} → {"vectors": [[384 floats], ...]}.

One copy of the model, shared by the API (query embeddings). The embed job
loads its own copy in-process instead, so bulk embedding never competes with
interactive searches for this service.

Run locally:  uvicorn search.embedder_service:app --port 8091
"""

from __future__ import annotations

from fastapi import FastAPI
from pydantic import BaseModel, Field

from . import config
from .embed import LocalEmbedder

s = config.load()
model = LocalEmbedder(s.embed_model, s.embed_max_tokens, threads=s.embed_threads)
app = FastAPI(title="temupuffer search embedder")


class EmbedIn(BaseModel):
    texts: list[str] = Field(min_length=1, max_length=256)


@app.get("/healthz")
def healthz():
    return {"ok": True, "model": s.embed_model}


@app.post("/embed")
def embed(body: EmbedIn):
    return {"vectors": model.embed(body.texts), "model": s.embed_model}
