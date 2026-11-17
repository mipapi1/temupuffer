"""Conditional writes and the startup self-test."""

import pytest

from temupuffer import selftest
from temupuffer.storage import MemoryStore, NotModified, PreconditionFailed


def test_if_none_match_creates_once():
    s = MemoryStore()
    s.put("k", b"a", if_none_match=True)
    with pytest.raises(PreconditionFailed):
        s.put("k", b"b", if_none_match=True)
    assert s.get("k")[0] == b"a"


def test_if_match_is_compare_and_swap():
    s = MemoryStore()
    e1 = s.put("k", b"a")
    e2 = s.put("k", b"b", if_match=e1)
    with pytest.raises(PreconditionFailed):
        s.put("k", b"c", if_match=e1)  # stale etag: someone changed it since we read it
    assert s.get("k") == (b"b", e2)


def test_if_match_on_missing_key_fails():
    with pytest.raises(PreconditionFailed):
        MemoryStore().put("nope", b"x", if_match="whatever")


def test_conditional_get_returns_304():
    s = MemoryStore()
    etag = s.put("k", b"a")
    with pytest.raises(NotModified):
        s.get("k", if_none_match=etag)
    assert s.totals["GET_304"] == 1


def test_selftest_passes_on_a_correct_store():
    log = selftest.run(MemoryStore())
    assert len(log) == 5


@pytest.mark.parametrize("broken", ["if_match", "if_none_match"])
def test_selftest_fails_loudly_when_a_header_is_ignored(broken):
    store = MemoryStore(honour_if_match=broken != "if_match", honour_if_none_match=broken != "if_none_match")
    with pytest.raises(selftest.SelfTestFailed, match="IGNORED"):
        selftest.run(store)


def test_connect_waits_for_store_then_fails_fast_on_cas(settings):
    """Unreachable store: retry. Store that ignores If-Match: fatal immediately."""
    calls = {"n": 0}

    class Flaky(MemoryStore):
        def _put(self, *a, **kw):
            calls["n"] += 1
            if calls["n"] < 3:
                raise ConnectionError("not up yet")
            return super()._put(*a, **kw)

    settings.selftest = True
    st, log = selftest.connect(settings, Flaky(), wait_s=30, retry_s=0.01)
    assert len(log) == 5 and calls["n"] >= 3
    with pytest.raises(selftest.SelfTestFailed):
        selftest.connect(settings, MemoryStore(honour_if_match=False), wait_s=30)
