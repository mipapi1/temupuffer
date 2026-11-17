"""Text → 384-dim vectors with all-MiniLM-L6-v2 (ONNX via fastembed). No API keys, no per-call cost.

The model was trained on inputs of up to 128 tokens, so we truncate there: it's
faithful to the model and about 2x faster than the library's 256 default on
LaTeX-heavy arXiv abstracts. Vectors come out unit-length, so cosine distance
is the natural metric.
"""

from __future__ import annotations

import threading
import time

import httpx

DIMS = 384


class LocalEmbedder:
    def __init__(self, model: str, max_tokens: int = 128, threads: int | None = None):
        from fastembed import TextEmbedding

        self.model_name = model
        self.model = TextEmbedding(model, threads=threads)
        self.model.model.tokenizer.enable_truncation(max_length=max_tokens)
        self._lock = threading.Lock()  # one ONNX session; it already uses every core

    def embed(self, texts: list[str], batch_size: int = 32) -> list[list[float]]:
        with self._lock:
            return [v.tolist() for v in self.model.embed(texts, batch_size=batch_size)]


class RemoteEmbedder:
    """Client for the embedder service (POST /embed)."""

    def __init__(self, url: str):
        self.http = httpx.Client(base_url=url, timeout=60)

    def embed(self, texts: list[str], batch_size: int = 32) -> list[list[float]]:
        r = self.http.post("/embed", json={"texts": texts})
        r.raise_for_status()
        return r.json()["vectors"]


def make(settings) -> LocalEmbedder | RemoteEmbedder:
    if settings.embedder_url:
        return RemoteEmbedder(settings.embedder_url)
    return LocalEmbedder(settings.embed_model, settings.embed_max_tokens, threads=settings.embed_threads)


def timed_embed(embedder, text: str) -> tuple[list[float], float]:
    t0 = time.perf_counter()
    v = embedder.embed([text])[0]
    return v, (time.perf_counter() - t0) * 1000
