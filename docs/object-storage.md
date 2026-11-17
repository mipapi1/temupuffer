# Compare-and-swap on object storage: S3, GCS and Azure Blob

temupuffer needs two primitives from its object store:

| Primitive | Header | Used for |
|---|---|---|
| create-if-absent | `If-None-Match: *` | claiming WAL sequence numbers, writing segment files |
| replace-if-unchanged | `If-Match: <etag>` | `queue.json`, `manifest.json`, `meta.json` |

`selftest.py` checks both at startup. Here's how each cloud provides them.

## AWS S3 (verified against the docs, 2026-11-09)

Source: [Conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html).

- "To conditionally write objects, add the HTTP `If-None-Match` or `If-Match` header." This works on
  PutObject, CompleteMultipartUpload and CopyObject. `If-None-Match` takes `*`, and `If-Match` takes an ETag.
- `If-None-Match` on an existing object: **412 Precondition Failed**.
- `If-Match` with a different ETag: **412**. If there's no current object: **404 Not Found**.
  `S3Store._put` maps a 404 on a conditional PUT to `PreconditionFailed`.
- **409 Conflict** happens with concurrent requests, e.g. "if a delete request to an object succeeds
  before a conditional write operation on that object completes". "Uploads may be retried after
  receiving a `409 Conflict`." I treat 409 like 412: re-read, retry.
- "If multiple conditional writes … occur for the same object name, the first write operation to
  finish succeeds", and later ones get 412. That's exactly the WAL race from `labs/a-s3/race.py`.
- Permissions: `If-Match` needs `s3:GetObject` as well as `s3:PutObject`. Bucket policies can
  *require* conditional writes.
- Conditional reads (GET/HEAD with `If-None-Match`/`If-Match`) are supported. temupuffer uses
  `GET manifest.json If-None-Match: <etag>` → 304 on every strong query.

MinIO and SILO implement the same headers. temupuffer's self-test passed on SILO
`RELEASE.2026-09-16`, including `If-Match`.

## Azure Blob Storage (docs checked 2026-11-09; adapter + Azurite tests 2026-11-10)

Sources: [Conditional headers](https://learn.microsoft.com/en-us/rest/api/storageservices/specifying-conditional-headers-for-blob-service-operations),
[Lease Blob](https://learn.microsoft.com/en-us/rest/api/storageservices/lease-blob).

- Put Blob accepts `If-Match`, `If-None-Match`, `If-Modified-Since`, `If-Unmodified-Since` and `x-ms-if-tags`.
- `If-None-Match: *`: "perform the operation only if the resource doesn't exist, and fail the operation if it does exist."
- A failed write precondition returns **412 Precondition Failed** per the docs. In practice
  `If-None-Match: *` on an existing blob returned **409 BlobAlreadyExists** (Azurite); see below.
- Azure also has **leases**: "exclusive write and delete access to the blob" for 15-60 s or
  infinite. That's an alternative to an etag CAS for something like `queue.json`, but it adds a
  lease-id to every write and a 409 when the wrong lease is used.

turbopuffer's docs list Azure as a region/BYOC cloud but don't say which object store they use there.

### temupuffer's `AzureBlobStore` (added 2026-11-10, `STORE=azure`)

Built on `azure-storage-blob` 12.31.1. Behaviour below was checked in the SDK source and on Azurite
(the [official emulator](https://learn.microsoft.com/en-us/azure/storage/common/storage-use-azurite))
and on a **real account** (StorageV2, Standard_LRS, HNS off) on 2026-11-10: identical status codes and etag quoting.

| temupuffer call | SDK call | What came back (Azurite and real Azure) |
|---|---|---|
| `put(if_none_match=True)` | `upload_blob(overwrite=True, match_condition=IfMissing)` → `If-None-Match: *` | exists: **409 `BlobAlreadyExists`** (not 412) |
| `put(if_match=e)` | `upload_blob(overwrite=True, etag=e, match_condition=IfNotModified)` → `If-Match: e` | stale: **412 `ConditionNotMet`**; blob missing: **412** (S3 says 404) |
| `get(if_none_match=e)` | `download_blob(etag=e, match_condition=IfModified)` | unchanged: **304** |
| `list(prefix, start_after, delimiter)` | `list_blobs` / `walk_blobs(...).by_page()` | sorted names, 5,000 per page |

Differences from S3 that the code handles:

- **Etag quoting.** Put/Get/Properties return `"0x8DC…"` (quoted); List Blobs returns `0x8DC…`
  (unquoted). The cache keys on key+etag, so `AzureBlobStore._q` always quotes.
- **One request per PUT/GET.** Above `max_single_put_size` (SDK default 64 MiB) `upload_blob`
  switches to Put Block + Put Block List, and **Put Block takes no conditional headers**. The store
  raises both single-request limits to 256 MiB and refuses bigger objects. (One Put Blob can be up to
  5,000 MiB on current API versions.) `test_large_object_is_one_conditional_put` uses 20 MB.
- **No S3 `StartAfter`.** List Blobs has `startFrom` (API 2023-05-03+) but the SDK documents it as
  "only one entity level", so the store filters `start_after` client-side. Correct, but a strong
  query lists the whole WAL prefix (temupuffer never deletes WAL entries): 1 extra LIST page per
  5,000 entries.
- **Azurite** rejects the SDK's newest API version (2026-10-06) unless started with
  `--skipApiVersionCheck` (`make azurite-up` does).

Auth (first match wins): `AZURE_STORAGE_CONNECTION_STRING` · `AZURE_STORAGE_ACCOUNT_URL` +
`AZURE_STORAGE_ACCOUNT_KEY` · `AZURE_STORAGE_ACCOUNT_URL` alone → `DefaultAzureCredential`
(service principal env vars, workload identity, `az login`), which needs the data-plane role
**Storage Blob Data Contributor**. Container: `AZURE_STORAGE_CONTAINER` (default `temupuffer`).

Verified on Azurite: `make test-azure` (7 tests incl. a 3-writer WAL race), CAS self-test from the
Docker image, and an end-to-end run: 2 query nodes + indexer, 2 concurrent 15k loads into one
namespace (15 lost WAL claims retried, 2 stale manifest/queue CAS retried), count = 30,000,
BM25/filter/eventual queries on both nodes, strong re-query = `GET_304 + LIST`, namespace delete
left only `queue.json`.

Verified on the real account (2026-11-10, client on a home connection): CAS self-test, `make test-azure`
7/7, and end-to-end with 2 query nodes + indexer: 2 concurrent 5k loads (4 WAL claims lost and
retried), count = 10,000 on both nodes, ids 0/4999/5000/9999 present, indexed ~4 s after the last
write. Latency from the client: small GET / 304 / If-Match PUT / LIST all p50 19-25 ms. Cold strong
query ~550 ms (17 GETs), warm strong query ~50 ms (`GET_304 + LIST`), eventual ~1 ms (0 requests).

## Google Cloud Storage (NOT verified in this session; the docs fetch was blocked)

From general knowledge, to be checked against
[Request preconditions](https://cloud.google.com/storage/docs/request-preconditions) before relying on it:

- GCS uses **generation numbers** rather than ETags: `x-goog-if-generation-match: <generation>`
  (XML API) or `ifGenerationMatch` (JSON API). A generation of `0` means "only if the object doesn't
  exist", which is GCS's create-if-absent. Failure is 412.
- turbopuffer's queue blog post notes GCS allows about **1 write per second to the same object**,
  which caps how often a single-file queue can change. That's one reason the queue holds one job per
  namespace rather than one per write.

A `GCSStore` would map `if_none_match=True` → generation-match 0, and `if_match=<etag>` → generation
match on the generation returned by the last read.
