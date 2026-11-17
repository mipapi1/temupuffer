"""All tunables in one place, read from environment variables.

Every limit here has a turbopuffer counterpart. The comment next to each one
gives the real value and the docs page it comes from, so you can say which
numbers are scaled down for the demo and which ones match production.
"""

from __future__ import annotations

import os
import socket
from dataclasses import dataclass, field

MiB = 1024 * 1024


def _env(name: str, default: str) -> str:
    return os.environ.get(name, default)


def _int(name: str, default: int) -> int:
    return int(os.environ.get(name, default))


def _float(name: str, default: float) -> float:
    return float(os.environ.get(name, default))


def _bool(name: str, default: bool) -> bool:
    return os.environ.get(name, str(default)).lower() in ("1", "true", "yes", "on")


@dataclass
class Settings:
    # --- Object storage (the only durable state) -------------------------
    # "s3" talks to any S3-compatible store (AWS, MinIO, SILO). "memory" is an
    # in-process fake used by the unit tests.
    store: str = field(default_factory=lambda: _env("STORE", "s3"))
    s3_endpoint: str | None = field(default_factory=lambda: os.environ.get("S3_ENDPOINT"))
    s3_bucket: str = field(default_factory=lambda: _env("S3_BUCKET", "temupuffer"))
    s3_region: str = field(default_factory=lambda: _env("S3_REGION", "us-east-1"))
    create_bucket: bool = field(default_factory=lambda: _bool("CREATE_BUCKET", True))
    # STORE=azure: Azure Blob Storage (see AzureBlobStore in storage.py for auth order).
    # CREATE_BUCKET also controls creating the container.
    azure_container: str = field(default_factory=lambda: _env("AZURE_STORAGE_CONTAINER", "temupuffer"))
    azure_connection_string: str | None = field(
        default_factory=lambda: os.environ.get("AZURE_STORAGE_CONNECTION_STRING") or None)
    azure_account_url: str | None = field(default_factory=lambda: os.environ.get("AZURE_STORAGE_ACCOUNT_URL") or None)
    azure_account_key: str | None = field(default_factory=lambda: os.environ.get("AZURE_STORAGE_ACCOUNT_KEY") or None)

    # --- Node identity and auth ------------------------------------------
    node_id: str = field(default_factory=lambda: _env("NODE_ID", socket.gethostname()))
    api_key: str = field(default_factory=lambda: _env("API_KEY", "tpuf-dev-key"))
    # Startup check that the store honours If-None-Match and If-Match.
    selftest: bool = field(default_factory=lambda: _bool("SELFTEST", True))

    # --- Write path ---------------------------------------------------------
    # Architecture docs: "Each namespace can currently write 1 WAL entry per second."
    wal_min_gap_s: float = field(default_factory=lambda: _float("WAL_MIN_GAP_S", 1.0))
    # Not a documented turbopuffer limit. It keeps one group-commit entry from
    # growing without bound. (The real max request size is 512 MB, per Limits.)
    wal_max_entry_bytes: int = field(default_factory=lambda: _int("WAL_MAX_ENTRY_BYTES", 32 * MiB))
    max_request_bytes: int = field(default_factory=lambda: _int("MAX_REQUEST_BYTES", 64 * MiB))

    # Write docs (disable_backpressure): turbopuffer returns 429 when unindexed
    # data passes 2 GB or 1M rows. These defaults are small on purpose so
    # you can trigger a 429 in the demo.
    backpressure_max_unindexed_rows: int = field(
        default_factory=lambda: _int("BACKPRESSURE_MAX_UNINDEXED_ROWS", 25_000)
    )
    backpressure_max_unindexed_bytes: int = field(
        default_factory=lambda: _int("BACKPRESSURE_MAX_UNINDEXED_BYTES", 64 * MiB)
    )

    # --- Query path ---------------------------------------------------------
    # Query docs (consistency): eventual reuses the cached view for up to 60 s
    # and searches at most 128 MiB of unindexed writes.
    eventual_max_staleness_s: float = field(default_factory=lambda: _float("EVENTUAL_MAX_STALENESS_S", 60))
    eventual_max_unindexed_bytes: int = field(
        default_factory=lambda: _int("EVENTUAL_MAX_UNINDEXED_BYTES", 128 * MiB)
    )
    # Our choice, not documented: whether a node adds its own commits to its
    # cached view right away. The docs say queries "usually hit the writing
    # node", so an eventual read on that node usually sees the write.
    view_includes_own_writes: bool = field(default_factory=lambda: _bool("VIEW_INCLUDES_OWN_WRITES", True))

    # --- Cache (stands in for turbopuffer's NVMe SSD + memory tier) ---------
    cache_dir: str = field(default_factory=lambda: _env("CACHE_DIR", "/tmp/temupuffer-cache"))
    cache_disk_bytes: int = field(default_factory=lambda: _int("CACHE_DISK_BYTES", 1024 * MiB))
    cache_memory_bytes: int = field(default_factory=lambda: _int("CACHE_MEMORY_BYTES", 256 * MiB))

    # --- Indexer --------------------------------------------------------------
    indexer_poll_s: float = field(default_factory=lambda: _float("INDEXER_POLL_S", 0.5))
    indexer_max_rows_per_pass: int = field(default_factory=lambda: _int("INDEXER_MAX_ROWS_PER_PASS", 5_000))
    indexer_lease_s: float = field(default_factory=lambda: _float("INDEXER_LEASE_S", 30))
    indexer_sweep_s: float = field(default_factory=lambda: _float("INDEXER_SWEEP_S", 30))
    # /readyz on the indexer turns 503 when no loop step has succeeded for this long.
    indexer_ready_stale_s: float = field(default_factory=lambda: _float("INDEXER_READY_STALE_S", 30))
    # LSM-style: when a namespace has this many segments, merge them into one.
    indexer_compact_at: int = field(default_factory=lambda: _int("INDEXER_COMPACT_AT", 4))
    # A merge never produces a segment bigger than this, so indexer memory is bounded by
    # this many rows (~20 KiB each for 384-dim vectors + abstracts), not by namespace size.
    indexer_max_segment_rows: int = field(default_factory=lambda: _int("INDEXER_MAX_SEGMENT_ROWS", 50_000))
    # Wait before deleting replaced segment files, so in-flight queries that
    # still hold the old manifest can finish reading them.
    gc_delay_s: float = field(default_factory=lambda: _float("GC_DELAY_S", 120))
    # Artificial delay per pass, so the backlog drain is easy to watch. 0 in prod.
    indexer_pass_delay_s: float = field(default_factory=lambda: _float("INDEXER_PASS_DELAY_S", 0))

    # --- Vector index (centroid-based, in the spirit of SPFresh) -------------
    ann_min_rows: int = field(default_factory=lambda: _int("ANN_MIN_ROWS", 1_000))
    ann_probe_fraction: float = field(default_factory=lambda: _float("ANN_PROBE_FRACTION", 0.15))
    ann_min_probe: int = field(default_factory=lambda: _int("ANN_MIN_PROBE", 4))

    # --- Cluster view for the console ----------------------------------------
    # Comma-separated base URLs of every query node and indexer, or a DNS name
    # (a headless Service) that resolves to every query-node pod.
    peer_urls: str = field(default_factory=lambda: _env("PEER_URLS", ""))
    peer_dns: str = field(default_factory=lambda: _env("PEER_DNS", ""))
    peer_port: int = field(default_factory=lambda: _int("PEER_PORT", 8080))
    indexer_urls: str = field(default_factory=lambda: _env("INDEXER_URLS", ""))
    indexer_dns: str = field(default_factory=lambda: _env("INDEXER_DNS", ""))
    indexer_port: int = field(default_factory=lambda: _int("INDEXER_PORT", 8081))


def load() -> Settings:
    return Settings()
