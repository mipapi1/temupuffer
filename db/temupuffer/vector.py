"""Vector search: exact (brute force) and a clustered approximate index.

Exhaustive search compares the query with every vector. It always finds the
true nearest neighbours, and its cost grows linearly with the number of
documents. temupuffer uses it for the unindexed WAL tail, for kNN queries and
for small segments.

The clustered index (an IVF, or inverted file) is the approximate version:

    build:  k-means groups the vectors into k clusters, each with a centroid.
    query:  1. compare the query with the k centroids (cheap: k << n)
            2. "probe" the nearest few clusters
            3. compare the query only with the vectors in those clusters

    centroids:   c0 ●      c1 ●       c2 ●      ... (k ≈ sqrt(n))
    clusters:   [3,17,90] [5,8,41,77] [2,60]    ...

If the true neighbour sits in a cluster we didn't probe, we miss it. That's the
"approximate" part, measured as *recall* (the share of the true top-k that
we returned). Probing more clusters gives higher recall and a slower query.
test_vector.py checks recall against brute force.

turbopuffer's ANN index is "SPFresh-based": also centroid-based, but kept up
to date incrementally, with clusters split and merged as data changes
(Architecture docs). Ours is rebuilt from scratch whenever a segment is built
or compacted. That's simpler, and it's the main difference.

Distance metrics (Write docs):
    cosine_distance   = 1 - cos(a, b)       range 0..2, smaller is closer
    euclidean_squared = sum((a - b)^2)      smaller is closer
For cosine we normalise vectors to unit length when we store them, so the
distance is 1 - dot(a, b), which is one matrix-vector product.
"""

from __future__ import annotations

import math

import numpy as np


def prepare(vectors: np.ndarray, metric: str) -> np.ndarray:
    """Store-time transform: unit length for cosine, unchanged for euclidean."""
    v = np.asarray(vectors, dtype=np.float32)
    if metric == "cosine_distance" and len(v):
        norms = np.linalg.norm(v, axis=1, keepdims=True)
        norms[norms == 0] = 1.0
        v = v / norms
    return v


def distances(stored: np.ndarray, query: np.ndarray, metric: str) -> np.ndarray:
    """Distance from the query to every row of stored. stored must already be prepare()d."""
    if len(stored) == 0:
        return np.zeros(0, dtype=np.float32)
    if metric == "cosine_distance":
        q = prepare(query.reshape(1, -1), metric)[0]
        return 1.0 - stored @ q
    diff = stored - query.astype(np.float32)
    return np.einsum("ij,ij->i", diff, diff)


def top_k(dist: np.ndarray, positions: np.ndarray, k: int) -> list[tuple[float, int]]:
    """The k smallest distances, as (distance, position), sorted ascending."""
    if len(dist) == 0 or k <= 0:
        return []
    if len(dist) > k:
        idx = np.argpartition(dist, k - 1)[:k]  # O(n), faster than a full sort
    else:
        idx = np.arange(len(dist))
    idx = idx[np.argsort(dist[idx], kind="stable")]
    return [(float(dist[i]), int(positions[i])) for i in idx]


def kmeans(vectors: np.ndarray, k: int, iterations: int = 12, seed: int = 0) -> np.ndarray:
    """Plain Lloyd's k-means with k-means++ seeding. Returns the centroids (k x d)."""
    rng = np.random.default_rng(seed)
    n = len(vectors)
    sample = vectors if n <= 20_000 else vectors[rng.choice(n, 20_000, replace=False)]
    # k-means++: pick each new centroid far from the existing ones.
    centroids = [sample[rng.integers(len(sample))]]
    d2 = ((sample - centroids[0]) ** 2).sum(axis=1)
    for _ in range(1, k):
        probs = d2 / d2.sum() if d2.sum() > 0 else None
        centroids.append(sample[rng.choice(len(sample), p=probs)])
        d2 = np.minimum(d2, ((sample - centroids[-1]) ** 2).sum(axis=1))
    c = np.stack(centroids).astype(np.float32)
    for _ in range(iterations):
        assign = assign_clusters(sample, c)
        for j in range(k):
            members = sample[assign == j]
            if len(members):
                c[j] = members.mean(axis=0)
    return c


def assign_clusters(vectors: np.ndarray, centroids: np.ndarray) -> np.ndarray:
    # ||v - c||^2 = ||v||^2 - 2 v.c + ||c||^2. ||v||^2 is the same for every c, so skip it.
    scores = -2 * vectors @ centroids.T + (centroids ** 2).sum(axis=1)
    return scores.argmin(axis=1)


def build_clusters(vectors: np.ndarray, min_rows: int) -> dict | None:
    """Build the clustered index for one segment, or None if it's too small to bother."""
    n = len(vectors)
    if n < min_rows:
        return None
    k = max(2, int(round(math.sqrt(n))))
    centroids = kmeans(vectors, k)
    assign = assign_clusters(vectors, centroids)
    order = np.argsort(assign, kind="stable").astype(np.int64)  # positions grouped by cluster
    counts = np.bincount(assign, minlength=k)
    offsets = np.concatenate([[0], np.cumsum(counts)]).astype(np.int64)  # cluster j = order[offsets[j]:offsets[j+1]]
    return {"centroids": centroids, "order": order, "offsets": offsets}


def probe_order(clusters: dict, query: np.ndarray) -> np.ndarray:
    """Cluster ids sorted from nearest centroid to farthest."""
    c = clusters["centroids"]
    d = ((c - query.astype(np.float32)) ** 2).sum(axis=1)
    return np.argsort(d)


def n_probe(k: int, fraction: float, minimum: int) -> int:
    return min(k, max(minimum, int(math.ceil(k * fraction))))
