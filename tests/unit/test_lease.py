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


# ---- sleeve S's own lease (DEC-0066): the `key` argument ----------------------------------------------------------

class Bucket:
    """An in-memory bucket keyed by object name, with conditional writes and the store's own clock."""

    configured = True

    def __init__(self) -> None:
        self.objs: dict[str, tuple[bytes, int]] = {}
        self.now = T0
        self.seen: list[tuple[str, str, str]] = []

    def get(self, bucket, key):
        self.seen.append(("get", bucket, key))
        if key not in self.objs:
            return Response(404, b"", None, self.now)
        body, n = self.objs[key]
        return Response(200, body, f'"e{n}"', self.now)

    def put(self, bucket, key, body, if_match=None, if_none_match=None, content_type=""):
        self.seen.append(("put", bucket, key))
        have = self.objs.get(key)
        if if_none_match == "*" and have is not None:
            return Response(412, b"", None, self.now)
        if if_match is not None and (have is None or if_match != f'"e{have[1]}"'):
            return Response(412, b"", None, self.now)
        n = (have[1] if have else 0) + 1
        self.objs[key] = (body, n)
        return Response(200, b"", f'"e{n}"', self.now)


def test_the_default_lease_is_still_strategy_bs():
    s = Bucket()
    assert lease.KEY == "paper-b" and lease.KEY_S == "paper-s" and lease.KEYS == ("paper-b", "paper-s")
    assert lease.acquire(s, "gcp-use1").ok and lease.acquire(client=s, holder="gcp-use1").ok
    assert {k for _, _, k in s.seen} == {"paper-b"} and list(s.objs) == ["paper-b"]
    assert lease.break_lease(s).ok and json.loads(s.objs["paper-b"][0])["holder"] == "broken-by-owner"
    assert {k for _, _, k in s.seen} == {"paper-b"}


def test_sleeve_s_has_its_own_lease_and_neither_says_anything_about_the_other():
    s = Bucket()
    assert lease.acquire(s, "gcp-use1").ok                                # sleeve Q's, held by one host
    assert lease.acquire(s, "other-host", key="paper-s").ok               # sleeve S's, held by another
    assert json.loads(s.objs["paper-b"][0])["holder"] == "gcp-use1"
    assert json.loads(s.objs["paper-s"][0])["holder"] == "other-host"
    r = lease.acquire(s, "gcp-use1", key=lease.KEY_S)
    assert not r.ok and "held by other-host" in r.reason
    assert not lease.acquire(s, "other-host").ok                          # and the reverse
    q_before = s.objs["paper-b"]
    assert lease.break_lease(s, key="paper-s").ok
    assert s.objs["paper-b"] == q_before                                  # breaking one leaves the other
    assert lease.acquire(s, "gcp-use1", key="paper-s").ok
    s.now = T0 + lease.TTL + dt.timedelta(minutes=1)
    assert lease.acquire(s, "third", key="paper-s").ok                    # expiry, on the store's clock


@pytest.mark.parametrize("key", ["", "paper-o", "paper-b/../x", "PAPER-S"])
def test_a_lease_this_code_does_not_name_is_refused_before_the_store_is_asked(key):
    s = Bucket()
    assert not lease.acquire(s, "h", key=key).ok and not lease.break_lease(s, key=key).ok
    assert s.seen == [] and s.objs == {}


def test_the_command_line_names_a_lease_or_refuses_and_a_mistyped_name_never_acts_on_the_default(monkeypatch):
    calls: list[tuple[str, str]] = []
    monkeypatch.setattr(lease, "acquire", lambda client=None, holder=None, key=lease.KEY: (
        calls.append(("acquire", key)) or lease.Result(True, "ok")))
    monkeypatch.setattr(lease, "break_lease", lambda client=None, by="owner", key=lease.KEY: (
        calls.append(("break", key)) or lease.Result(True, "ok")))
    for args in ([], ["break"], ["paper-s"], ["break", "paper-s"], ["break", "paper-b"]):
        assert lease.main(args).ok
    assert calls == [("acquire", "paper-b"), ("break", "paper-b"), ("acquire", "paper-s"), ("break", "paper-s"),
                     ("break", "paper-b")]
    calls.clear()
    for args in (["break", "paper-x"], ["paper-x"], ["break", "paper-s", "extra"], ["paper-s", "break"], ["brake"]):
        r = lease.main(args)
        assert not r.ok and r.reason.startswith("usage:"), args
    assert calls == []
