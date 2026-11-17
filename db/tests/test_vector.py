"""Vector search: distances, and ANN recall against brute force."""

import numpy as np
import pytest

from temupuffer import vector
from conftest import drain


def test_cosine_and_euclidean():
    a = vector.prepare(np.array([[1.0, 0.0], [0.0, 2.0]]), "cosine_distance")
    assert vector.distances(a, np.array([1.0, 0.0]), "cosine_distance") == pytest.approx([0.0, 1.0])
    b = vector.prepare(np.array([[1.0, 0.0], [3.0, 4.0]]), "euclidean_squared")
    assert vector.distances(b, np.array([0.0, 0.0]), "euclidean_squared") == pytest.approx([1.0, 25.0])


def clustered_data(n, dims, seed=0):
    rng = np.random.default_rng(seed)
    centers = rng.normal(size=(30, dims)) * 4
    pts = centers[rng.integers(0, 30, n)] + rng.normal(size=(n, dims))
    return pts.astype(np.float32), rng


@pytest.mark.parametrize("metric", ["cosine_distance", "euclidean_squared"])
def test_ann_recall_against_brute_force(engine, indexer, metric):
    """recall@10 of ANN (clustered index) vs kNN (exhaustive) over 50 queries."""
    pts, rng = clustered_data(3000, 16)
    engine.write("vec", {"distance_metric": metric, "upsert_rows": [
        {"id": i, "vector": pts[i].tolist()} for i in range(3000)]})
    indexer.s.indexer_max_rows_per_pass = 5000
    drain(indexer)
    recalls = []
    for _ in range(50):
        q = (pts[rng.integers(3000)] + rng.normal(size=16) * 0.5).tolist()
        ann = engine.query("vec", {"rank_by": ["vector", "ANN", q], "limit": 10})
        knn = engine.query("vec", {"rank_by": ["vector", "kNN", q], "limit": 10})
        assert ann["performance"]["exhaustive_search_count"] == 0  # all indexed
        recalls.append(len({r["id"] for r in ann["rows"]} & {r["id"] for r in knn["rows"]}) / 10)
    # Limits docs: turbopuffer reports recall@10 of 90-100%.
    assert np.mean(recalls) >= 0.9, np.mean(recalls)


def test_ann_with_filter_still_fills_the_limit(engine, indexer):
    pts, rng = clustered_data(2000, 8, seed=3)
    engine.write("vf", {"distance_metric": "euclidean_squared", "upsert_rows": [
        {"id": i, "vector": pts[i].tolist(), "rare": i % 100 == 0} for i in range(2000)]})
    indexer.s.indexer_max_rows_per_pass = 5000
    drain(indexer)
    r = engine.query("vf", {"rank_by": ["vector", "ANN", pts[5].tolist()], "limit": 10,
                            "filters": ["rare", "Eq", True]})
    assert len(r["rows"]) == 10  # only 20 docs match; probing expands until it finds 10
