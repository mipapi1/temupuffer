"""Index segments: immutable bundles of indexed documents.

The indexer folds a range of WAL entries into a *segment* and writes it under
``ns/<name>/index/seg-<id>/``. A segment is never modified after it's written,
which has two big consequences:

1. Caching is trivial. A segment's key always means the same bytes, so a node
   can cache a segment forever and never needs to ask "has it changed?". Only
   manifest.json (which segments exist) and the WAL head need re-checking.
2. Updates are layered, like an LSM tree. A newer segment can contain a new
   version of a document that's also in an older segment, or a *tombstone*
   for it (a delete marker). Queries resolve that by version: the highest
   version wins. Compaction later merges segments and drops what's been
   shadowed.

Files in a segment (each is one object, fetched in parallel on a cold query):

    docs.json      ids, versions, tombstone flags and the attributes of each row
    vectors.npy    one float32 row per document (cosine: already unit length)
    ann.npz        centroids + rows grouped by cluster (only for big enough segments)
    fts.json       per full-text attribute: tokenizer options and the term list
    postings.npz   per full-text attribute: every term's postings concatenated
                   (positions, tfs as int32) + per-term offsets + doc lengths.
                   Binary since segment format 2 (0.1.9): parsing JSON postings
                   cost ~15 Python objects per posting and OOMKilled query pods
                   on a 100k-row namespace. Format 1 kept postings in fts.json.
    filters.json   exact inverted index per filterable attribute (value -> rows),
                   and a sorted copy of numeric values for range filters
"""

from __future__ import annotations

import io
import json
import uuid
from concurrent.futures import ThreadPoolExecutor

import numpy as np

from . import bm25, keys, vector
from .schema import VECTOR_ATTR

FORMAT = 2
FILES_V1 = ("docs.json", "vectors.npy", "ann.npz", "fts.json", "filters.json")
FILES = FILES_V1 + ("postings.npz",)


def files_for(fmt: int) -> tuple[str, ...]:
    return FILES if fmt >= 2 else FILES_V1


class Postings:
    """term -> (positions, tfs) as views into two shared int32 arrays (no per-term copies)."""

    def __init__(self, terms: list[str], offsets: np.ndarray, pos: np.ndarray, tf: np.ndarray):
        self.index = {t: i for i, t in enumerate(terms)}
        self.offsets, self.pos, self.tf = offsets, pos, tf

    def __contains__(self, t) -> bool:
        return t in self.index

    def __getitem__(self, t) -> tuple[np.ndarray, np.ndarray]:
        i = self.index[t]
        a, b = self.offsets[i], self.offsets[i + 1]
        return self.pos[a:b], self.tf[a:b]

    def __len__(self) -> int:
        return len(self.index)

    def keys(self):
        return self.index.keys()

    def items(self):
        return ((t, self[t]) for t in self.index)


class Segment:
    """An in-memory, query-ready segment."""

    def __init__(self, seg_id: str, docs: dict, vectors: np.ndarray | None, clusters: dict | None,
                 fts: dict, filters_idx: dict):
        self.id = seg_id
        self.ids: list = docs["ids"]
        self.versions = np.asarray(docs["versions"], dtype=np.int64)
        self.deleted = np.asarray(docs["deleted"], dtype=bool)
        self.attrs: list[dict | None] = docs["attrs"]
        self.count = len(self.ids)
        self.vectors = vectors  # (count x dims) or None for namespaces without vectors
        self.clusters = clusters
        # fts[attr] = {"postings": {term: (positions, tfs)}, "lengths": np.array, "opts": {...}}
        self.fts = fts
        self.eq_index: dict[str, dict] = {}
        self.range_index: dict[str, tuple[list, np.ndarray]] = {}
        self.array_attrs: set[str] = set(filters_idx.get("array_attrs", []))
        for attr, pairs in filters_idx.get("eq", {}).items():
            self.eq_index[attr] = {v: np.asarray(p, dtype=np.int64) for v, p in pairs}
        for attr, (values, positions) in filters_idx.get("range", {}).items():
            self.range_index[attr] = (values, np.asarray(positions, dtype=np.int64))
        self.position = {doc_id: i for i, doc_id in enumerate(self.ids)}
        self.nbytes = 0  # set by the loader, for cache accounting

    def attr_value(self, i: int, attr: str):
        if attr == "id":
            return self.ids[i]
        row = self.attrs[i]
        return None if row is None else row.get(attr)

    def row(self, i: int, include: list[str] | bool) -> dict:
        out = {"id": self.ids[i]}
        attrs = self.attrs[i] or {}
        if include is True:
            out.update(attrs)  # every attribute except the vector, which is only returned by name
        elif include:
            for a in include:
                if a == VECTOR_ATTR and self.vectors is not None:
                    out[a] = self.vectors[i].tolist()
                elif a != "id" and a in attrs:
                    out[a] = attrs[a]
        return out


# --- Building -------------------------------------------------------------------


def resolve_latest(ops: list[tuple[int, str, object]]) -> dict:
    """Keep only the newest op per id. ops are (version, kind, payload). Returns {id: (version, row|None)}."""
    latest: dict = {}
    for v, kind, payload in ops:
        doc_id = payload["id"] if kind == "upsert" else payload
        cur = latest.get(doc_id)
        if cur is None or v > cur[0]:
            latest[doc_id] = (v, payload if kind == "upsert" else None)
    return latest


def build(latest: dict, meta: dict, ann_min_rows: int, drop_tombstones: bool = False) -> dict:
    """Turn {id: (version, row-or-None)} into the five segment files (as bytes)."""
    items = sorted(latest.items(), key=lambda kv: kv[1][0])
    if drop_tombstones:
        items = [kv for kv in items if kv[1][1] is not None]
    schema = meta.get("schema", {})
    metric = meta.get("distance_metric")
    dims = meta.get("dims")

    ids, versions, deleted, attrs, vecs = [], [], [], [], []
    for doc_id, (v, row) in items:
        ids.append(doc_id)
        versions.append(v)
        deleted.append(row is None)
        if row is None:
            attrs.append(None)
            if dims:
                vecs.append(np.zeros(dims, dtype=np.float32))
            continue
        attrs.append({k: val for k, val in row.items() if k not in ("id", VECTOR_ATTR)})
        if dims:
            vecs.append(np.asarray(row[VECTOR_ATTR], dtype=np.float32))

    files: dict[str, bytes] = {}
    files["docs.json"] = json.dumps({"ids": ids, "versions": versions, "deleted": deleted, "attrs": attrs},
                                    separators=(",", ":")).encode()

    vectors = vector.prepare(np.stack(vecs), metric) if (dims and vecs) else np.zeros((0, dims or 0), np.float32)
    buf = io.BytesIO()
    np.save(buf, vectors)
    files["vectors.npy"] = buf.getvalue()

    clusters = None
    if dims and len(vectors):
        live = ~np.asarray(deleted, dtype=bool)
        if live.sum() >= ann_min_rows:
            live_pos = np.nonzero(live)[0]
            c = vector.build_clusters(vectors[live_pos], ann_min_rows)
            if c is not None:
                c["order"] = live_pos[c["order"]]  # map back to segment positions
                clusters = c
    buf = io.BytesIO()
    if clusters:
        np.savez(buf, **clusters)
    files["ann.npz"] = buf.getvalue()

    fts: dict = {}
    arrays: dict[str, np.ndarray] = {}
    for attr, spec in schema.items():
        opts = spec.get("full_text_search")
        if not opts:
            continue
        texts = [bm25.text_of(a.get(attr)) if a else None for a in attrs]
        postings, lengths = bm25.build_postings(texts, opts)
        del texts
        terms = list(postings)
        counts = np.fromiter((len(postings[t][0]) for t in terms), dtype=np.int64, count=len(terms))
        total = int(counts.sum())
        arrays[f"{attr}/offsets"] = np.concatenate([[0], np.cumsum(counts)]).astype(np.int64)
        arrays[f"{attr}/pos"] = np.fromiter((p for t in terms for p in postings[t][0]), dtype=np.int32, count=total)
        arrays[f"{attr}/tf"] = np.fromiter((c for t in terms for c in postings[t][1]), dtype=np.int32, count=total)
        arrays[f"{attr}/lengths"] = np.asarray(lengths, dtype=np.int32)
        fts[attr] = {"opts": opts, "terms": terms}
        del postings
    files["fts.json"] = json.dumps(fts, separators=(",", ":")).encode()
    buf = io.BytesIO()
    np.savez(buf, **arrays)
    files["postings.npz"] = buf.getvalue()
    del arrays

    eq: dict = {}
    rng: dict = {}
    array_attrs = []
    for attr, spec in schema.items():
        if attr in ("id", VECTOR_ATTR) or not spec.get("filterable", True):
            continue
        is_array = spec["type"].startswith("[]")
        if is_array:
            array_attrs.append(attr)
        index: dict = {}
        numeric: list[tuple] = []
        for pos, a in enumerate(attrs):
            if a is None or a.get(attr) is None:
                continue
            val = a[attr]
            for elem in (val if is_array else [val]):
                index.setdefault(elem, []).append(pos)
            if not is_array and isinstance(val, (int, float)) and not isinstance(val, bool):
                numeric.append((val, pos))
        eq[attr] = [[v, p] for v, p in index.items()]
        if spec["type"] in ("int", "float"):
            numeric.sort()
            rng[attr] = [[v for v, _ in numeric], [p for _, p in numeric]]
    # ids are filterable too.
    eq["id"] = [[doc_id, [pos]] for pos, doc_id in enumerate(ids)]
    files["filters.json"] = json.dumps({"eq": eq, "range": rng, "array_attrs": array_attrs},
                                       separators=(",", ":")).encode()
    return files


def new_id() -> str:
    return uuid.uuid4().hex[:12]


def write(store, ns: str, seg_id: str, files: dict) -> int:
    """Upload every file (with If-None-Match, so we never overwrite anything). Returns total bytes."""
    def put(item):
        name, body = item
        store.put(keys.segment_file(ns, seg_id, name), body, if_none_match=True)
        return len(body)

    with ThreadPoolExecutor(max_workers=len(files)) as pool:
        return sum(pool.map(put, files.items()))


def _posting_arrays(pl) -> tuple[np.ndarray, np.ndarray]:
    """Format 1: one term's postings as (positions, tfs). 0.1.8 wrote {"p": [...], "c": [...]};
    before that [[position, tf], ...]. Both still readable."""
    if isinstance(pl, dict):
        return np.asarray(pl["p"], dtype=np.int64), np.asarray(pl["c"], dtype=np.int64)
    return np.asarray([p for p, _ in pl], dtype=np.int64), np.asarray([c for _, c in pl], dtype=np.int64)


def parse(seg_id: str, files: dict[str, bytes]) -> Segment:
    docs = json.loads(files["docs.json"])
    vectors = np.load(io.BytesIO(files["vectors.npy"]))
    vectors = vectors if vectors.size else None
    clusters = None
    if files["ann.npz"]:
        with np.load(io.BytesIO(files["ann.npz"])) as z:
            clusters = {k: z[k] for k in z.files}
    fts_raw = json.loads(files["fts.json"])
    fts = {}
    if files.get("postings.npz"):  # format 2
        with np.load(io.BytesIO(files["postings.npz"])) as z:
            for attr, f in fts_raw.items():
                postings = Postings(f["terms"], z[f"{attr}/offsets"], z[f"{attr}/pos"], z[f"{attr}/tf"])
                fts[attr] = {"postings": postings, "lengths": z[f"{attr}/lengths"], "opts": f["opts"]}
    else:  # format 1
        for attr, f in fts_raw.items():
            postings = {t: _posting_arrays(pl) for t, pl in f["postings"].items()}
            fts[attr] = {"postings": postings, "lengths": np.asarray(f["lengths"], dtype=np.int64), "opts": f["opts"]}
    del fts_raw
    seg = Segment(seg_id, docs, vectors, clusters, fts, json.loads(files["filters.json"]))
    seg.nbytes = sum(len(b) for b in files.values())
    return seg
