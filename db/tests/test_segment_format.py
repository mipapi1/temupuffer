"""Segment formats: format 2 (0.1.9, binary postings.npz) and both format-1 layouts must read the same."""

import json

import numpy as np

from temupuffer import meta as meta_mod, segment


def _files():
    m = meta_mod.apply_write(None, "ns", [{"id": 1, "text": "a"}], None, {"text": {"type": "string", "full_text_search": True}})
    latest = {i: (i, {"id": i, "text": t}) for i, t in enumerate(["the cat sat", "the cat", "dog dog dog"])}
    return segment.build(latest, m, ann_min_rows=1000)


def _as_v1(files, layout):
    """Rewrite a format-2 segment the way 0.1.8 ("pc") or earlier versions ("pairs") stored it."""
    seg = segment.parse("x", files)
    fts = {}
    for attr, f in seg.fts.items():
        pl = {t: (p.tolist(), c.tolist()) for t, (p, c) in f["postings"].items()}
        enc = ({t: {"p": p, "c": c} for t, (p, c) in pl.items()} if layout == "pc"
               else {t: [[a, b] for a, b in zip(p, c)] for t, (p, c) in pl.items()})
        fts[attr] = {"postings": enc, "lengths": f["lengths"].tolist(), "opts": f["opts"]}
    out = {k: v for k, v in files.items() if k != "postings.npz"}
    out["fts.json"] = json.dumps(fts).encode()
    return out


def test_all_postings_formats_parse_the_same():
    files = _files()
    assert set(files) == set(segment.FILES)
    new = segment.parse("a", files).fts["text"]
    assert new["postings"]["dog"][1].tolist() == [3]
    assert new["postings"]["cat"][0].tolist() == [0, 1]
    for layout in ("pc", "pairs"):
        old = segment.parse("b", _as_v1(files, layout)).fts["text"]
        assert set(old["postings"].keys()) == set(new["postings"].keys())
        for t in new["postings"].keys():
            assert np.array_equal(old["postings"][t][0], new["postings"][t][0])
            assert np.array_equal(old["postings"][t][1], new["postings"][t][1])
        assert np.array_equal(old["lengths"], new["lengths"])


def test_format_1_segments_load_through_the_view_manager(engine, indexer, store):
    """A manifest entry without "format" loads only the format-1 files (no postings.npz)."""
    from temupuffer import keys, manifest
    from conftest import drain

    engine.write("old", {"upsert_rows": [{"id": 1, "text": "hello world"}],
                         "schema": {"text": {"type": "string", "full_text_search": True}}})
    drain(indexer)
    man, etag = manifest.read(store, "old")
    seg = man["segments"][0]
    files = {f: store.get(keys.segment_file("old", seg["id"], f))[0] for f in segment.FILES}
    v1 = _as_v1(files, "pairs")
    store.delete_prefix(keys.segment_prefix("old", seg["id"]))
    for name, body in v1.items():
        store.put(keys.segment_file("old", seg["id"], name), body)
    seg.pop("format")
    manifest.write(store, "old", man, etag)

    rows = engine.query("old", {"rank_by": ["text", "BM25", "hello"], "limit": 5})["rows"]
    assert [r["id"] for r in rows] == [1]
