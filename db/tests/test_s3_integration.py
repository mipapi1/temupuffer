"""The same CAS rules against real object stores: S3-compatible (MinIO/SILO/AWS) and Azure Blob.

Each backend is skipped unless its env var is set:
    S3_ENDPOINT=http://127.0.0.1:19000 AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... make test-s3
    AZURE_STORAGE_CONNECTION_STRING="UseDevelopmentStorage=true" make test-azure      # Azurite
    AZURE_STORAGE_CONNECTION_STRING="DefaultEndpointsProtocol=https;AccountName=...;AccountKey=...;EndpointSuffix=core.windows.net" make test-azure
    AZURE_STORAGE_ACCOUNT_URL=https://<account>.blob.core.windows.net make test-azure  # az login / workload identity
"""

import json
import os
import uuid

import pytest

from temupuffer import selftest, wal
from temupuffer.storage import AzureBlobStore, NotFound, NotModified, PreconditionFailed, S3Store


def _make(backend):
    if backend == "s3":
        if not os.environ.get("S3_ENDPOINT"):
            pytest.skip("S3_ENDPOINT not set")
        return S3Store(os.environ.get("S3_BUCKET", "temupuffer"), os.environ["S3_ENDPOINT"], create_bucket=True)
    if not (os.environ.get("AZURE_STORAGE_CONNECTION_STRING") or os.environ.get("AZURE_STORAGE_ACCOUNT_URL")):
        pytest.skip("AZURE_STORAGE_CONNECTION_STRING / AZURE_STORAGE_ACCOUNT_URL not set")
    return AzureBlobStore(os.environ.get("AZURE_STORAGE_CONTAINER", "temupuffer"),
                          os.environ.get("AZURE_STORAGE_CONNECTION_STRING"),
                          os.environ.get("AZURE_STORAGE_ACCOUNT_URL"),
                          os.environ.get("AZURE_STORAGE_ACCOUNT_KEY"), create_container=True)


@pytest.fixture(params=["s3", "azure"])
def s3(request):
    store = _make(request.param)
    prefix = f"itest/{uuid.uuid4().hex}/"
    yield store, prefix
    store.delete_prefix(prefix)


def test_selftest(s3):
    selftest.run(s3[0], "itest")


def test_conditional_get_and_put(s3):
    store, p = s3
    e1 = store.put(p + "k", b"a", if_none_match=True)
    with pytest.raises(PreconditionFailed):
        store.put(p + "k", b"b", if_none_match=True)
    with pytest.raises(NotModified):
        store.get(p + "k", if_none_match=e1)
    e2 = store.put(p + "k", b"c", if_match=e1)
    with pytest.raises(PreconditionFailed):
        store.put(p + "k", b"d", if_match=e1)
    assert store.get(p + "k") == (b"c", e2)


def test_if_match_on_missing_key_and_not_found(s3):
    store, p = s3
    with pytest.raises(PreconditionFailed):
        store.put(p + "missing", b"x", if_match='"0x1234"')
    with pytest.raises(NotFound):
        store.get(p + "missing")
    with pytest.raises(NotFound):
        store.head(p + "missing")
    store.delete(p + "missing")  # deleting a missing key is not an error


def test_etags_agree_across_put_get_head_list(s3):
    """The cache keys on key+etag, so every call must report the same etag string."""
    store, p = s3
    e = store.put(p + "k", b"hello")
    assert store.get(p + "k")[1] == e
    assert store.head(p + "k").etag == e
    objs, _ = store.list(p)
    assert [(o.key, o.size, o.etag) for o in objs] == [(p + "k", 5, e)]


def test_list_start_after_delimiter_and_paging(s3):
    store, p = s3
    for i in range(12):
        store.put(f"{p}wal/{i:020d}.json", b"x")
    store.put(f"{p}a/meta.json", b"x")
    store.put(f"{p}b/meta.json", b"x")
    objs, _ = store.list(p + "wal/", start_after=f"{p}wal/{4:020d}.json")
    assert [o.key for o in objs] == [f"{p}wal/{i:020d}.json" for i in range(5, 12)]
    assert len(store.list(p + "wal/", max_keys=3)[0]) == 3
    _, prefixes = store.list(p, delimiter="/")
    assert prefixes == [p + "a/", p + "b/", p + "wal/"]


def test_large_object_is_one_conditional_put(s3):
    """20 MB: bigger than the Azure SDK's 4 MiB block size, so this fails if it
    were chunked into Put Block calls (which ignore conditions)."""
    store, p = s3
    body = os.urandom(20 * 1024 * 1024)
    e1 = store.put(p + "big", body, if_none_match=True)
    with pytest.raises(PreconditionFailed):
        store.put(p + "big", body, if_none_match=True)
    store.put(p + "big", body[:10], if_match=e1)
    assert store.get(p + "big")[0] == body[:10]


def test_wal_race_on_real_store(s3):
    from concurrent.futures import ThreadPoolExecutor

    store, p = s3
    ns = p.strip("/").replace("/", "-")
    writers = [wal.WalWriter(store, ns, f"n{i}", 0.0, 1 << 25) for i in range(3)]
    with ThreadPoolExecutor(30) as pool:
        seqs = list(pool.map(lambda i: writers[i % 3].submit({"upserts": [{"id": i}], "deletes": []}, 10), range(60)))
    stored = [r["id"] for o in wal.list_entries(store, ns)
              for b in json.loads(store.get(o.key)[0])["batches"] for r in b["upserts"]]
    assert sorted(stored) == list(range(60)) and len(seqs) == 60
    store.delete_prefix(f"ns/{ns}/")
