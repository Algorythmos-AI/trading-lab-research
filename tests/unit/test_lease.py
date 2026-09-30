"""The primary lease (wt.ops.lease): one holder at a time, the store's clock, and every doubt refuses."""
from __future__ import annotations

import datetime as dt
import json

import pytest

from wt.ops import lease
from wt.ops.r2 import Response

T0 = dt.datetime(2026, 10, 20, 12, 30, tzinfo=dt.UTC)


class FakeR2:
    """An in-memory bucket with real conditional-write semantics and a settable server clock."""

    configured = True

    def __init__(self):
        self.obj: bytes | None = None
        self.etag_n = 0
        self.now = T0
        self.fail: Exception | None = None

    def _etag(self):
        return f'"e{self.etag_n}"'

    def get(self, bucket, key):
        if self.fail:
            raise self.fail
        if self.obj is None:
            return Response(404, b"", None, self.now)
        return Response(200, self.obj, self._etag(), self.now)

    def put(self, bucket, key, body, if_match=None, if_none_match=None, content_type=""):
        if if_none_match == "*" and self.obj is not None:
            return Response(412, b"", None, self.now)
        if if_match is not None and if_match != self._etag():
            return Response(412, b"", None, self.now)
        self.obj, self.etag_n = body, self.etag_n + 1
        return Response(200, b"", self._etag(), self.now)


def test_first_host_takes_it_second_is_refused_until_expiry():
    s = FakeR2()
    assert lease.acquire(s, "oci-syd").ok
    r = lease.acquire(s, "mac")
    assert not r.ok and "held by oci-syd" in r.reason
    assert lease.acquire(s, "oci-syd").ok                               # renewal by the holder
    s.now = T0 + lease.TTL + dt.timedelta(minutes=1)
    assert lease.acquire(s, "mac").ok                                   # expired on the store's clock
    assert json.loads(s.obj)["holder"] == "mac"


def test_a_concurrent_writer_makes_ours_fail():
    s = FakeR2()
    lease.acquire(s, "oci-syd")
    s.now = T0 + lease.TTL + dt.timedelta(minutes=1)
    real_put = s.put

    def racing_put(*a, **k):
        s.etag_n += 1                                                    # someone else wrote after our read
        return real_put(*a, **k)
    s.put = racing_put
    r = lease.acquire(s, "mac")
    assert not r.ok and "lost a race" in r.reason


@pytest.mark.parametrize("fail", [ConnectionError("down"), TimeoutError()])
def test_an_unreachable_store_refuses(fail):
    s = FakeR2()
    s.fail = fail
    r = lease.acquire(s, "oci-syd")
    assert not r.ok and "unreachable" in r.reason


def test_a_malformed_lease_refuses_until_the_owner_breaks_it():
    s = FakeR2()
    s.obj = b"not json"
    assert "malformed" in lease.acquire(s, "oci-syd").reason
    assert lease.break_lease(s).ok
    assert lease.acquire(s, "oci-syd").ok


def test_not_configured_refuses():
    class Off(FakeR2):
        configured = False
    assert not lease.acquire(Off(), "x").ok
