"""Startup self-test: does this object store actually honour our CAS headers?

Everything in temupuffer depends on two promises from the store:

  1. If-None-Match: *  -> a second create of the same key is rejected.
     Without it, two nodes could both write WAL entry 42 and one write would
     be silently lost. (You saw this in labs/a-s3/race.py with blind_write.)
  2. If-Match: <etag>  -> a replace based on a stale read is rejected.
     Without it, two indexers could both "claim" the same job in queue.json,
     or both advance manifest.json, and one would overwrite the other.

Some S3-compatible servers accept these headers and quietly ignore them, so
the request succeeds even though it should not have. That is the worst failure
mode: everything looks fine until data goes missing. So every node runs this
check at startup and refuses to serve if it fails.

AWS S3 supports both headers on PutObject (If-None-Match since Aug 2024,
If-Match since Nov 2024). Azure Blob Storage supports If-Match and
If-None-Match: * on Put Blob. Google Cloud Storage uses generation numbers
(x-goog-if-generation-match) instead. See docs/object-storage.md.
"""

from __future__ import annotations

import uuid

from .storage import ObjectStore, PreconditionFailed


class SelfTestFailed(RuntimeError):
    pass


def run(store: ObjectStore, node_id: str = "node") -> list[str]:
    """Run the four checks. Return a log of what passed; raise SelfTestFailed on the first failure."""
    key = f"selftest/{node_id}/{uuid.uuid4().hex}"
    log: list[str] = []
    try:
        # 1. If-None-Match: * on a fresh key must succeed.
        etag1 = store.put(key, b"v1", if_none_match=True)
        log.append("If-None-Match: * on a new key -> created (ok)")

        # 2. ...and on an existing key must fail.
        try:
            store.put(key, b"v1-again", if_none_match=True)
        except PreconditionFailed:
            log.append("If-None-Match: * on an existing key -> 412/409 (ok)")
        else:
            raise SelfTestFailed(
                "The object store IGNORED If-None-Match: *. A second create of the same key "
                "succeeded, so two nodes could both write the same WAL entry and one write "
                "would be lost. temupuffer cannot run safely on this store."
            )

        # 3. If-Match with the current etag must succeed and return a new etag.
        etag2 = store.put(key, b"v2", if_match=etag1)
        if etag2 == etag1:
            raise SelfTestFailed("The store returned the same etag for different content after If-Match.")
        log.append("If-Match: <current etag> -> replaced (ok)")

        # 4. If-Match with a stale etag must fail.
        try:
            store.put(key, b"v3-stale", if_match=etag1)
        except PreconditionFailed:
            log.append("If-Match: <stale etag> -> 412 (ok)")
        else:
            raise SelfTestFailed(
                "The object store IGNORED If-Match. A replace with a stale etag succeeded, so "
                "two indexers could both claim one job in queue.json, or both advance "
                "manifest.json, and one would overwrite the other. temupuffer cannot run "
                "safely on this store."
            )

        body, _ = store.get(key)
        if body != b"v2":
            raise SelfTestFailed(f"Expected b'v2' after the CAS sequence, read back {body!r}.")
        log.append("Read back the winning value (ok)")
        return log
    finally:
        try:
            store.delete(key)
        except Exception:
            pass


def connect(settings, store=None, role: str = "node", wait_s: float | None = None, retry_s: float = 2.0):
    """Open the store and run the self-test, waiting for the store to come up.

    Two very different failures:
      * the store is unreachable (still starting, DNS not ready...): wait and retry,
        so pods started alongside a bundled S3 don't crash-loop;
      * the store answers but ignores a CAS header: stop immediately, because
        retrying won't fix it and running would risk losing data.
    Returns (store, log).
    """
    import os
    import time

    from . import storage

    wait_s = float(os.environ.get("STARTUP_WAIT_S", "180")) if wait_s is None else wait_s
    deadline = time.monotonic() + wait_s
    while True:
        try:
            st = store or storage.from_settings(settings)
            log = run(st, f"{role}-{settings.node_id}") if settings.selftest else []
            return st, log
        except SelfTestFailed:
            raise
        except Exception as e:
            if time.monotonic() > deadline:
                raise
            print(f"[startup] object storage not ready ({type(e).__name__}: {str(e)[:120]}); "
                  f"retrying in {retry_s:g} s", flush=True)
            time.sleep(retry_s)


def main() -> None:
    """`python -m temupuffer.selftest`: run against the store from env vars and print the result."""
    import sys

    from . import config, storage

    s = config.load()
    store = storage.from_settings(s)
    if s.store == "azure":
        account = (s.azure_account_url or "").split("//")[-1] or next(
            (p.split("=", 1)[1] for p in (s.azure_connection_string or "").split(";")
             if p.startswith(("BlobEndpoint=", "AccountName="))), "connection string")
        print(f"CAS self-test against Azure Blob {account}, container {s.azure_container!r}")
    else:
        print(f"CAS self-test against {s.s3_endpoint or 'AWS S3'}, bucket {s.s3_bucket!r}")
    try:
        for line in run(store, s.node_id):
            print("  " + line)
    except SelfTestFailed as e:
        print("\n  FAILED: " + str(e), file=sys.stderr)
        sys.exit(1)
    print("PASSED: both If-None-Match and If-Match are honoured.")


if __name__ == "__main__":
    main()
