"""Object storage: the only durable state in temupuffer.

turbopuffer (Guarantees docs): "Object storage is the only stateful
dependency" and "all concurrency control is delegated to object storage".
This module is that dependency. The rest of the code only does five things to
a bucket: get, put, conditional put, list and delete.

There are three implementations behind one interface:

* ``S3Store``: boto3 against AWS S3, MinIO or SILO.
* ``AzureBlobStore``: Azure Blob Storage (or the Azurite emulator).
* ``MemoryStore``: a dict guarded by a lock, with the same conditional-write
  rules. The unit tests use it, so they run in milliseconds without a server.

Both count every request. The console's "object storage requests" panel and
each query's ``performance`` block both read those counts.

Two kinds of compare-and-swap (CAS) are used, the same as in the lab:

  put(key, body, if_none_match=True)   -> If-None-Match: *
      "create only if nothing is there yet". Used to claim a WAL sequence number.
  put(key, body, if_match=etag)        -> If-Match: <etag>
      "replace only if nobody changed it since I read it". Used for queue.json,
      manifest.json and meta.json.

Losing either race raises ``PreconditionFailed``. S3 returns 412 when the
precondition fails and 409 when a conflicting write is still in flight (AWS
S3 "conditional writes" docs). We treat both as "you lost, re-read and retry".
"""

from __future__ import annotations

import contextvars
import hashlib
import threading
import time
from collections import Counter
from dataclasses import dataclass, field


class PreconditionFailed(Exception):
    """A conditional write lost its race (HTTP 412 or 409)."""


class NotFound(Exception):
    """The key does not exist (HTTP 404)."""


class NotModified(Exception):
    """A conditional GET found the object unchanged (HTTP 304)."""


@dataclass
class ObjectInfo:
    key: str
    size: int
    etag: str
    last_modified: float  # unix seconds


# --- Request accounting -------------------------------------------------------
#
# Each query runs inside a RequestStats context. Every storage call adds to
# the current context, which is how a query can report exactly how many
# object storage round trips it cost. contextvars works across threads only
# when copied explicitly, so code that fans out to a thread pool uses
# ``run_in_context``.


@dataclass
class RequestStats:
    round_trips: int = 0
    by_op: Counter = field(default_factory=Counter)
    bytes_read: int = 0
    lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def add(self, op: str, nbytes: int = 0) -> None:
        with self.lock:
            self.round_trips += 1
            self.by_op[op] += 1
            self.bytes_read += nbytes


current_stats: contextvars.ContextVar[RequestStats | None] = contextvars.ContextVar(
    "current_stats", default=None
)


class ObjectStore:
    """Base class: public methods count the request, then call the backend."""

    def __init__(self) -> None:
        self.totals: Counter = Counter()  # lifetime counts per operation, for the console
        self._lock = threading.Lock()
        self.recent: list[tuple[float, str]] = []  # (time, op) for request-rate sparklines

    def describe(self) -> dict:
        """Which store this is, for the console. Never includes credentials."""
        return {"kind": "unknown"}

    # The backend-specific parts, implemented by subclasses.
    def _get(self, key: str, if_none_match: str | None) -> tuple[bytes, str]: ...
    def _head(self, key: str) -> ObjectInfo: ...
    def _put(self, key: str, body: bytes, if_none_match: bool, if_match: str | None) -> str: ...
    def _list(self, prefix: str, start_after: str | None, delimiter: str | None, max_keys: int | None
              ) -> tuple[list[ObjectInfo], list[str]]: ...
    def _delete(self, key: str) -> None: ...

    def _count(self, op: str, nbytes: int = 0) -> None:
        now = time.time()
        with self._lock:
            self.totals[op] += 1
            self.recent.append((now, op))
            if len(self.recent) > 5000:
                del self.recent[:1000]
        stats = current_stats.get()
        if stats is not None:
            stats.add(op, nbytes)

    # --- public API ---------------------------------------------------------

    def get(self, key: str, if_none_match: str | None = None) -> tuple[bytes, str]:
        """Return (body, etag). With if_none_match=etag, raise NotModified if unchanged.

        That conditional GET is how a strong query re-checks a small object
        (manifest.json) cheaply: if nothing changed, S3 sends 304 with no body.
        """
        try:
            body, etag = self._get(key, if_none_match)
        except NotModified:
            self._count("GET_304")
            raise
        except NotFound:
            self._count("GET_404")
            raise
        self._count("GET", len(body))
        return body, etag

    def head(self, key: str) -> ObjectInfo:
        self._count("HEAD")
        return self._head(key)

    def put(self, key: str, body: bytes, *, if_none_match: bool = False, if_match: str | None = None) -> str:
        """Write an object and return its new etag. Conditional forms raise PreconditionFailed."""
        op = "PUT_IF_NONE_MATCH" if if_none_match else "PUT_IF_MATCH" if if_match else "PUT"
        try:
            etag = self._put(key, body, if_none_match, if_match)
        except PreconditionFailed:
            self._count(op + "_412")
            raise
        self._count(op)
        return etag

    def list(self, prefix: str, start_after: str | None = None, delimiter: str | None = None,
             max_keys: int | None = None) -> tuple[list[ObjectInfo], list[str]]:
        """List keys under prefix, sorted. Returns (objects, common_prefixes).

        One S3 LIST returns at most 1000 keys. The S3 backend pages through all
        of them (each page is a separate request and is counted), the same as
        the paginator fix in labs/c-wal/wal.py.
        """
        objs, prefixes = self._list(prefix, start_after, delimiter, max_keys)
        return objs, prefixes

    def delete(self, key: str) -> None:
        self._count("DELETE")
        self._delete(key)

    def delete_prefix(self, prefix: str) -> int:
        objs, _ = self.list(prefix)
        for o in objs:
            self.delete(o.key)
        return len(objs)

    def request_rate(self, window_s: float = 10.0) -> Counter:
        cutoff = time.time() - window_s
        with self._lock:
            return Counter(op for t, op in self.recent if t >= cutoff)


# --- In-memory fake -------------------------------------------------------------


class MemoryStore(ObjectStore):
    """A dict with S3's conditional-write rules. Used by the tests."""

    def __init__(self, honour_if_match: bool = True, honour_if_none_match: bool = True) -> None:
        super().__init__()
        self.objects: dict[str, tuple[bytes, str, float]] = {}
        self.mu = threading.Lock()
        # Switches that let a test simulate a store that ignores a header,
        # so we can check that the startup self-test catches it.
        self.honour_if_match = honour_if_match
        self.honour_if_none_match = honour_if_none_match
        self._version = 0

    def describe(self) -> dict:
        return {"kind": "memory", "label": "In-memory (not durable)"}

    def _etag(self, body: bytes) -> str:
        # Real S3 uses an MD5 of the body for single-part uploads. We add a
        # version counter so identical bodies still get distinct etags,
        # which makes ABA problems visible in tests rather than hidden.
        self._version += 1
        return hashlib.md5(body + str(self._version).encode()).hexdigest()

    def _get(self, key, if_none_match):
        with self.mu:
            if key not in self.objects:
                raise NotFound(key)
            body, etag, _ = self.objects[key]
        if if_none_match is not None and if_none_match == etag:
            raise NotModified(key)
        return body, etag

    def _head(self, key):
        with self.mu:
            if key not in self.objects:
                raise NotFound(key)
            body, etag, mtime = self.objects[key]
            return ObjectInfo(key, len(body), etag, mtime)

    def _put(self, key, body, if_none_match, if_match):
        with self.mu:  # the lock makes check-then-write atomic, which is what S3 guarantees
            exists = key in self.objects
            if if_none_match and self.honour_if_none_match and exists:
                raise PreconditionFailed(key)
            if if_match is not None and self.honour_if_match:
                if not exists or self.objects[key][1] != if_match:
                    raise PreconditionFailed(key)
            etag = self._etag(body)
            self.objects[key] = (bytes(body), etag, time.time())
            return etag

    def _list(self, prefix, start_after, delimiter, max_keys):
        self._count("LIST")
        with self.mu:
            keys = sorted(k for k in self.objects if k.startswith(prefix) and (start_after is None or k > start_after))
            objs, prefixes = [], []
            seen = set()
            for k in keys:
                rest = k[len(prefix):]
                if delimiter and delimiter in rest:
                    p = prefix + rest.split(delimiter, 1)[0] + delimiter
                    if p not in seen:
                        seen.add(p)
                        prefixes.append(p)
                    continue
                body, etag, mtime = self.objects[k]
                objs.append(ObjectInfo(k, len(body), etag, mtime))
                if max_keys and len(objs) >= max_keys:
                    break
            return objs, prefixes

    def _delete(self, key):
        with self.mu:
            self.objects.pop(key, None)


# --- S3 (AWS, MinIO, SILO) -------------------------------------------------------


class S3Store(ObjectStore):
    def __init__(self, bucket: str, endpoint: str | None = None, region: str = "us-east-1",
                 create_bucket: bool = False) -> None:
        super().__init__()
        import boto3
        from botocore.config import Config

        self.bucket = bucket
        self.endpoint = endpoint
        self.s3 = boto3.client(
            "s3",
            endpoint_url=endpoint,
            region_name=region,
            config=Config(
                # MinIO and SILO serve buckets at http://host/bucket/key, not
                # bucket.host, so use path-style addressing (same as the labs).
                s3={"addressing_style": "path"},
                # Newer boto3 adds CRC checksums to every PUT by default. Only
                # send them when an API requires it, for S3-compatible stores.
                request_checksum_calculation="when_required",
                response_checksum_validation="when_required",
                retries={"max_attempts": 3, "mode": "standard"},
                max_pool_connections=64,
                connect_timeout=5,
                read_timeout=30,
            ),
        )
        if create_bucket:
            self._ensure_bucket()

    def describe(self) -> dict:
        from urllib.parse import urlparse

        host = urlparse(self.endpoint).hostname if self.endpoint else "AWS S3"
        return {"kind": "s3", "host": host, "bucket": self.bucket, "label": f"S3 · {host.split('.')[0]} / {self.bucket}"}

    def _ensure_bucket(self) -> None:
        from botocore.exceptions import ClientError

        try:
            self.s3.head_bucket(Bucket=self.bucket)
        except ClientError as e:
            if e.response["ResponseMetadata"]["HTTPStatusCode"] != 404:
                raise
            try:
                self.s3.create_bucket(Bucket=self.bucket)
            except ClientError as e2:
                # Another pod created it between our HEAD and CREATE: fine.
                if e2.response.get("Error", {}).get("Code") not in ("BucketAlreadyOwnedByYou", "BucketAlreadyExists"):
                    raise

    @staticmethod
    def _status(e) -> int:
        return e.response.get("ResponseMetadata", {}).get("HTTPStatusCode", 0)

    def _get(self, key, if_none_match):
        from botocore.exceptions import ClientError

        kwargs = {"Bucket": self.bucket, "Key": key}
        if if_none_match:
            kwargs["IfNoneMatch"] = if_none_match
        try:
            r = self.s3.get_object(**kwargs)
        except ClientError as e:
            status = self._status(e)
            if status == 304:
                raise NotModified(key) from None
            if status == 404:
                raise NotFound(key) from None
            raise
        return r["Body"].read(), r["ETag"]

    def _head(self, key):
        from botocore.exceptions import ClientError

        try:
            r = self.s3.head_object(Bucket=self.bucket, Key=key)
        except ClientError as e:
            if self._status(e) == 404:
                raise NotFound(key) from None
            raise
        return ObjectInfo(key, r["ContentLength"], r["ETag"], r["LastModified"].timestamp())

    def _put(self, key, body, if_none_match, if_match):
        from botocore.exceptions import ClientError

        kwargs = {"Bucket": self.bucket, "Key": key, "Body": body}
        if if_none_match:
            kwargs["IfNoneMatch"] = "*"
        if if_match is not None:
            kwargs["IfMatch"] = if_match
        try:
            r = self.s3.put_object(**kwargs)
        except ClientError as e:
            status = self._status(e)
            # 412: precondition failed. 409: a concurrent conditional write is
            # in progress. 404: If-Match on a key that no longer exists (AWS
            # returns 404 for that). All three mean "you lost the race".
            if status in (409, 412) or (status == 404 and if_match is not None):
                raise PreconditionFailed(key) from None
            raise
        return r["ETag"]

    def _list(self, prefix, start_after, delimiter, max_keys):
        objs: list[ObjectInfo] = []
        prefixes: list[str] = []
        kwargs = {"Bucket": self.bucket, "Prefix": prefix}
        if start_after:
            kwargs["StartAfter"] = start_after
        if delimiter:
            kwargs["Delimiter"] = delimiter
        token = None
        while True:
            if token:
                kwargs["ContinuationToken"] = token
            self._count("LIST")
            r = self.s3.list_objects_v2(**kwargs)
            for o in r.get("Contents", []):
                objs.append(ObjectInfo(o["Key"], o["Size"], o["ETag"], o["LastModified"].timestamp()))
                if max_keys and len(objs) >= max_keys:
                    return objs, prefixes
            prefixes.extend(p["Prefix"] for p in r.get("CommonPrefixes", []))
            if not r.get("IsTruncated"):
                return objs, prefixes
            token = r["NextContinuationToken"]

    def _delete(self, key):
        self.s3.delete_object(Bucket=self.bucket, Key=key)


# --- Azure Blob Storage ---------------------------------------------------------


class AzureBlobStore(ObjectStore):
    """Azure Blob Storage (block blobs) with the same CAS rules as S3.

    Azure's REST API isn't S3, but it has the same two conditions natively
    (docs: "Specifying conditional headers for Blob service operations"):

      put(if_none_match=True)  -> Put Blob with If-None-Match: *
      put(if_match=etag)       -> Put Blob with If-Match: <etag>
      get(if_none_match=etag)  -> Get Blob with If-None-Match: <etag>  (304 if unchanged)

    In the Python SDK those are ``match_condition=MatchConditions.IfMissing``,
    ``etag=..., match_condition=MatchConditions.IfNotModified`` and
    ``etag=..., match_condition=MatchConditions.IfModified``.

    Two things are set on purpose:

    * Every PUT and GET must be ONE request. Above ``max_single_put_size`` the
      SDK switches to Put Block + Put Block List, and Put Block takes no
      conditions; above ``max_single_get_size`` it downloads in ranged chunks.
      Both limits are raised to 256 MiB (one Put Blob can be up to 5,000 MiB),
      and put() refuses anything bigger rather than silently losing atomicity.
    * A lost race comes back as 409 BlobAlreadyExists (If-None-Match: * on an
      existing blob) or 412 ConditionNotMet (stale If-Match, or If-Match on a
      missing blob). We also accept 404 for the latter. All mean "you lost, re-read".
    * Etags are normalised to the quoted form (see _q).

    Auth, first match wins:
      AZURE_STORAGE_CONNECTION_STRING             account key, SAS, or Azurite
      AZURE_STORAGE_ACCOUNT_URL + AZURE_STORAGE_ACCOUNT_KEY
      AZURE_STORAGE_ACCOUNT_URL alone             DefaultAzureCredential (workload
                                                  identity, AZURE_CLIENT_ID/SECRET, az login).
                                                  Needs role "Storage Blob Data Contributor".
    """

    SINGLE_REQUEST_MAX = 256 * 1024 * 1024

    def __init__(self, container: str, connection_string: str | None = None, account_url: str | None = None,
                 account_key: str | None = None, create_container: bool = False) -> None:
        super().__init__()
        from azure.storage.blob import BlobServiceClient

        opts = dict(max_single_put_size=self.SINGLE_REQUEST_MAX, max_single_get_size=self.SINGLE_REQUEST_MAX,
                    connection_timeout=5, read_timeout=30)
        if connection_string:
            service = BlobServiceClient.from_connection_string(connection_string, **opts)
        elif account_url:
            if account_key:
                from azure.core.credentials import AzureNamedKeyCredential

                account = account_url.split("//", 1)[-1].split(".", 1)[0]
                credential = AzureNamedKeyCredential(account, account_key)
            else:
                from azure.identity import DefaultAzureCredential

                credential = DefaultAzureCredential()
            service = BlobServiceClient(account_url, credential=credential, **opts)
        else:
            raise ValueError("STORE=azure needs AZURE_STORAGE_CONNECTION_STRING or AZURE_STORAGE_ACCOUNT_URL")
        self.container = service.get_container_client(container)
        if create_container:
            self._ensure_container()

    def describe(self) -> dict:
        account, container = self.container.account_name, self.container.container_name
        return {"kind": "azure", "account": account, "container": container,
                "label": f"Azure Blob · {account} / {container}"}

    def _ensure_container(self) -> None:
        from azure.core.exceptions import ResourceExistsError

        try:
            self.container.create_container()
        except ResourceExistsError:
            pass  # already there, or another pod created it first

    @staticmethod
    def _status(e) -> int:
        return getattr(e, "status_code", None) or 0

    @staticmethod
    def _q(etag: str) -> str:
        """Azure returns etags quoted from Put/Get/Properties but UNQUOTED from List
        Blobs (seen on Azurite). The cache keys on key+etag, so always quote."""
        return etag if etag.startswith('"') else f'"{etag}"'

    def _get(self, key, if_none_match):
        from azure.core import MatchConditions
        from azure.core.exceptions import HttpResponseError

        kwargs = {}
        if if_none_match:
            kwargs = {"etag": if_none_match, "match_condition": MatchConditions.IfModified}
        try:
            d = self.container.get_blob_client(key).download_blob(**kwargs)
            body = d.readall()
        except HttpResponseError as e:
            if self._status(e) == 304:
                raise NotModified(key) from None
            if self._status(e) == 404:
                raise NotFound(key) from None
            raise
        return body, self._q(d.properties.etag)

    def _head(self, key):
        from azure.core.exceptions import ResourceNotFoundError

        try:
            p = self.container.get_blob_client(key).get_blob_properties()
        except ResourceNotFoundError:
            raise NotFound(key) from None
        return ObjectInfo(key, p.size, self._q(p.etag), p.last_modified.timestamp())

    def _put(self, key, body, if_none_match, if_match):
        from azure.core import MatchConditions
        from azure.core.exceptions import HttpResponseError

        if len(body) > self.SINGLE_REQUEST_MAX:
            raise ValueError(f"{key}: {len(body)} bytes is too big for one conditional Put Blob")
        kwargs = {}
        if if_none_match:
            kwargs = {"match_condition": MatchConditions.IfMissing}
        elif if_match is not None:
            kwargs = {"etag": if_match, "match_condition": MatchConditions.IfNotModified}
        try:
            # overwrite=True: the explicit conditions above decide; without
            # them this is a plain unconditional PUT, like S3.
            r = self.container.get_blob_client(key).upload_blob(body, overwrite=True, **kwargs)
        except HttpResponseError as e:
            status = self._status(e)
            if status in (409, 412) or (status == 404 and if_match is not None):
                raise PreconditionFailed(key) from None
            raise
        return self._q(r["etag"])

    def _list(self, prefix, start_after, delimiter, max_keys):
        # List Blobs returns names in sorted order, up to 5,000 per page. It has
        # no S3-style StartAfter (startFrom exists but is limited), so filter
        # here: correct, but a long WAL costs extra pages per strong query.
        from azure.storage.blob import BlobPrefix

        objs: list[ObjectInfo] = []
        prefixes: list[str] = []
        if delimiter:
            pages = self.container.walk_blobs(name_starts_with=prefix, delimiter=delimiter).by_page()
        else:
            pages = self.container.list_blobs(name_starts_with=prefix).by_page()
        for page in pages:
            self._count("LIST")
            for b in page:
                if isinstance(b, BlobPrefix):
                    prefixes.append(b.name)
                    continue
                if start_after and b.name <= start_after:
                    continue
                objs.append(ObjectInfo(b.name, b.size, self._q(b.etag), b.last_modified.timestamp()))
                if max_keys and len(objs) >= max_keys:
                    return objs, prefixes
        return objs, prefixes

    def _delete(self, key):
        from azure.core.exceptions import ResourceNotFoundError

        try:
            self.container.delete_blob(key)
        except ResourceNotFoundError:
            pass  # S3 DELETE of a missing key also succeeds


def from_settings(settings) -> ObjectStore:
    if settings.store == "memory":
        return MemoryStore()
    if settings.store == "azure":
        return AzureBlobStore(settings.azure_container, settings.azure_connection_string,
                              settings.azure_account_url, settings.azure_account_key, settings.create_bucket)
    return S3Store(settings.s3_bucket, settings.s3_endpoint, settings.s3_region, settings.create_bucket)

