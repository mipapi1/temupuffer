"""The arXiv dataset: source files, the document shape, and the embedding chunks.

Source: Hugging Face `librarian-bots/arxiv-metadata-snapshot` (CC0), 11 parquet
shards, about 3.2M papers. We never need all of it: the embed job reads shards
in order until it has the requested number of documents.

Work is split into chunks of up to CHUNK_ROWS rows: chunk "SS-KKK" is rows
[KKK*CHUNK_ROWS, (KKK+1)*CHUNK_ROWS) of shard SS. Each chunk becomes one
parquet file with text, attributes and vectors. A chunk that already exists is
skipped, so the embed job is resumable and can run on several pods at once.

Document ids are integers: shard * 1,000,000 + row, stable across runs.
"""

from __future__ import annotations

import io
import os
import re
import urllib.parse
import urllib.request

import pyarrow as pa
import pyarrow.fs as pafs
import pyarrow.parquet as pq

from .embed import DIMS

HF_REPO = "librarian-bots/arxiv-metadata-snapshot"
SHARDS = 11
CHUNK_ROWS = int(os.environ.get("CHUNK_ROWS", "10000"))  # override only for tests
SOURCE_COLUMNS = ["id", "title", "abstract", "authors", "categories", "versions"]


def shard_url(shard: int) -> str:
    return f"https://huggingface.co/datasets/{HF_REPO}/resolve/main/data/train-{shard:05d}-of-{SHARDS:05d}.parquet"


# Top-level arXiv archive → a human-friendly field, used as a filter.
FIELDS = {
    "cs": "Computer Science", "math": "Mathematics", "stat": "Statistics",
    "eess": "Electrical Engineering", "econ": "Economics", "q-bio": "Biology", "q-fin": "Finance",
    "astro-ph": "Astrophysics", "cond-mat": "Condensed Matter", "quant-ph": "Quantum Physics",
    "gr-qc": "General Relativity", "hep-ph": "High Energy Physics", "hep-th": "High Energy Physics",
    "hep-ex": "High Energy Physics", "hep-lat": "High Energy Physics", "nucl-th": "Nuclear Physics",
    "nucl-ex": "Nuclear Physics", "physics": "Physics", "math-ph": "Physics", "nlin": "Physics",
}
FIELD_NAMES = sorted(set(FIELDS.values()))

_ws = re.compile(r"\s+")


def clean(s: str | None) -> str:
    return _ws.sub(" ", s or "").strip()


def field_of(category: str) -> str:
    return FIELDS.get(category.split(".")[0], "Other")


def year_of(versions) -> int | None:
    """versions[0].created looks like 'Mon, 2 Apr 2007 19:18:42 GMT'."""
    try:
        return int(versions[0]["created"].split()[3])
    except (TypeError, IndexError, KeyError, ValueError):
        return None


def embed_text(title: str, abstract: str) -> str:
    return f"{title}. {abstract}"


def to_doc(shard: int, row: int, rec: dict) -> dict | None:
    title, abstract = clean(rec.get("title")), clean(rec.get("abstract"))
    if not title or not abstract:
        return None
    category = (rec.get("categories") or "").split(" ")[0] or "unknown"
    return {
        "id": shard * 1_000_000 + row,
        "arxiv_id": rec.get("id") or "",
        "title": title[:500],
        "abstract": abstract[:4000],
        "authors": clean(rec.get("authors"))[:300],
        "category": category,
        "field": field_of(category),
        "year": year_of(rec.get("versions")) or 0,
    }


# The schema we write to temupuffer/turbopuffer. title + abstract get BM25.
SCHEMA = {
    "title": {"type": "string", "full_text_search": True},
    "abstract": {"type": "string", "full_text_search": True},
    "authors": {"type": "string", "filterable": False},
    "arxiv_id": {"type": "string", "filterable": False},
    "category": {"type": "string", "filterable": True},
    "field": {"type": "string", "filterable": True},
    "year": {"type": "int", "filterable": True},
}

CHUNK_SCHEMA = pa.schema([
    ("id", pa.int64()), ("arxiv_id", pa.string()), ("title", pa.string()), ("abstract", pa.string()),
    ("authors", pa.string()), ("category", pa.string()), ("field", pa.string()), ("year", pa.int32()),
    ("vector", pa.list_(pa.float32(), DIMS)),
])


def chunk_name(shard: int, k: int) -> str:
    return f"chunk-{shard:02d}-{k:03d}.parquet"


def chunk_order(name: str) -> tuple[int, int]:
    """chunk-SS-KKK.parquet → (KKK, SS): chunk 0 of every shard first, then chunk 1, ..."""
    _, ss, kkk = name[: -len(".parquet")].split("-")
    return int(kkk), int(ss)


# --- where chunks live: s3://bucket/prefix or a local directory ------------------------------


class ChunkStore:
    def __init__(self, uri: str, s3_endpoint: str = ""):
        if uri.startswith("s3://"):
            u = urllib.parse.urlparse(s3_endpoint) if s3_endpoint else None
            self.fs = pafs.S3FileSystem(
                access_key=os.environ.get("AWS_ACCESS_KEY_ID"), secret_key=os.environ.get("AWS_SECRET_ACCESS_KEY"),
                region=os.environ.get("AWS_REGION", "us-east-1"),
                endpoint_override=u.netloc if u else None, scheme=(u.scheme if u else "https"),
                allow_bucket_creation=True)
            self.root = uri[len("s3://"):].rstrip("/")
            bucket = self.root.split("/")[0]
            try:
                self.fs.create_dir(bucket)  # creates the bucket if it's missing
            except OSError:
                pass
        else:
            self.fs = pafs.LocalFileSystem()
            self.root = os.path.abspath(uri)
            os.makedirs(self.root, exist_ok=True)
        self.uri = uri

    def _path(self, name: str) -> str:
        return f"{self.root}/{name}"

    def exists(self, name: str) -> bool:
        return self.fs.get_file_info(self._path(name)).type == pafs.FileType.File

    def names(self) -> list[str]:
        sel = pafs.FileSelector(self.root, allow_not_found=True)
        names = [i.base_name for i in self.fs.get_file_info(sel)
                 if i.type == pafs.FileType.File and i.base_name.startswith("chunk-") and i.base_name.endswith(".parquet")]
        return sorted(names, key=chunk_order)   # the same interleaved order the embed job planned

    def write(self, name: str, table: pa.Table) -> None:
        buf = io.BytesIO()
        pq.write_table(table, buf, compression="zstd")
        tmp = self._path(name + ".tmp")
        with self.fs.open_output_stream(tmp) as f:
            f.write(buf.getvalue())
        self.fs.move(tmp, self._path(name))  # a rename locally; copy + delete on S3

    def read(self, name: str) -> pa.Table:
        with self.fs.open_input_file(self._path(name)) as f:
            return pq.read_table(f)

    def rows(self, name: str) -> int:
        """Row count from the parquet footer (a ranged read, not the whole file)."""
        with self.fs.open_input_file(self._path(name)) as f:
            return pq.read_metadata(f).num_rows

    def delete_chunks(self) -> int:
        """Delete every chunk (and leftover .tmp) under the prefix; nothing else. Returns how many."""
        sel = pafs.FileSelector(self.root, allow_not_found=True)
        doomed = [i.path for i in self.fs.get_file_info(sel)
                  if i.type == pafs.FileType.File and i.base_name.startswith("chunk-")]
        for p in doomed:
            self.fs.delete_file(p)
        return len(doomed)


def download_shard(shard: int, dest_dir: str) -> str:
    path = os.path.join(dest_dir, f"train-{shard:05d}.parquet")
    if not os.path.exists(path):
        tmp = path + ".part"
        urllib.request.urlretrieve(shard_url(shard), tmp)
        os.replace(tmp, path)
    return path
