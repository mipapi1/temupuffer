"""All settings come from environment variables (a K8s ConfigMap/Secret, or a gitignored .env locally)."""

from __future__ import annotations

import os
from dataclasses import dataclass, field


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


@dataclass
class Settings:
    # Which database the app uses by default. Compare mode can query both.
    backend: str = field(default_factory=lambda: _env("BACKEND", "temupuffer"))
    namespace: str = field(default_factory=lambda: _env("SEARCH_NAMESPACE", "arxiv"))

    temupuffer_url: str = field(default_factory=lambda: _env("TEMUPUFFER_URL", "http://localhost:8080").rstrip("/"))
    temupuffer_api_key: str = field(default_factory=lambda: _env("TEMUPUFFER_API_KEY", "tpuf-dev-key"))
    # Optional, temupuffer only: store SEARCH_NAMESPACE as several namespaces, comma-separated
    # (e.g. "arxiv-a,arxiv-b"). Docs go to shard id % n; queries fan out and merge. Pick names
    # that hash to different query pods (check the X-Temupuffer-Upstream header).
    temupuffer_shards: list[str] = field(default_factory=lambda: [
        x.strip() for x in _env("TEMUPUFFER_NAMESPACES").split(",") if x.strip()])

    # Real turbopuffer: optional. Every namespace the app touches there gets this prefix,
    # so it can never read, write or delete anything else in the account.
    turbopuffer_api_key: str = field(default_factory=lambda: _env("TURBOPUFFER_API_KEY"))
    turbopuffer_region: str = field(default_factory=lambda: _env("TURBOPUFFER_REGION"))
    turbopuffer_prefix: str = field(default_factory=lambda: _env("TURBOPUFFER_NAMESPACE_PREFIX", "demo-"))

    # Embeddings: an HTTP embedder service, or in-process when EMBEDDER_URL is empty.
    embedder_url: str = field(default_factory=lambda: _env("EMBEDDER_URL").rstrip("/"))
    embed_model: str = field(default_factory=lambda: _env("EMBED_MODEL", "sentence-transformers/all-MiniLM-L6-v2"))
    embed_max_tokens: int = field(default_factory=lambda: int(_env("EMBED_MAX_TOKENS", "128")))
    # ONNX threads. Unset = one per visible core. In a pod with a CPU limit, set it to
    # the limit: more threads than the quota get throttled by the kernel and run far slower.
    embed_threads: int | None = field(default_factory=lambda: int(_env("EMBED_THREADS")) if _env("EMBED_THREADS") else None)

    # Where the embed job leaves its output and the load job reads it:
    # s3://bucket/prefix (S3_ENDPOINT + AWS_* credentials) or a local directory.
    embeddings_uri: str = field(default_factory=lambda: _env("EMBEDDINGS_URI", "./.cache/embeddings"))
    s3_endpoint: str = field(default_factory=lambda: _env("S3_ENDPOINT"))

    # The load job reports progress to the API (shown on the Scale page).
    search_api_url: str = field(default_factory=lambda: _env("SEARCH_API_URL").rstrip("/"))

    @property
    def turbopuffer_enabled(self) -> bool:
        return bool(self.turbopuffer_api_key and self.turbopuffer_region)


def load() -> Settings:
    return Settings()
