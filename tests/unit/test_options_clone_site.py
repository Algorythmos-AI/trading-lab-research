"""The options clone and the dashboard (DEC-0030): the signed focus read, and the background publisher. No network."""
from __future__ import annotations

import hashlib
import hmac
import threading
from typing import Any

import requests

from wt.options import clone_site

ENV = {"DASHBOARD_INGEST_URL": "https://lab.example/api/ingest", "DASHBOARD_INGEST_SECRET": "focus-test-secret",
       "DASHBOARD_KEY_ID": "gcp-use1", "VERCEL_AUTOMATION_BYPASS_SECRET": "bypass"}


class Resp:
    def __init__(self, status: int, body: Any = None, bad_json: bool = False) -> None:
        self.status_code, self._body, self._bad = status, body, bad_json

    def json(self) -> Any:
        if self._bad:
            raise ValueError("not json")
        return self._body


class Session:
    def __init__(self, resp: Resp | Exception) -> None:
        self.resp = resp
        self.calls: list[dict[str, Any]] = []

    def get(self, url: str, **kw: Any) -> Resp:
        self.calls.append({"url": url, **kw})
        if isinstance(self.resp, Exception):
            raise self.resp
        return self.resp


GOOD = {"session": "2026-10-20", "items": [{"symbol": "NVDA", "rank": 2, "bias": "support"},
                                           {"symbol": "SPY", "rank": 1, "bias": "breakout"}]}


def test_the_read_is_a_signed_get_to_the_focus_route_with_the_hosts_key():
    s = Session(Resp(200, GOOD))
    focus, session = clone_site.read_focus(ENV, s, now=lambda: 1760284800)
    assert session == "2026-10-20" and [i["symbol"] for i in focus["items"]] == ["NVDA", "SPY"]
    (call,) = s.calls
    assert call["url"] == "https://lab.example/api/focus" and call["allow_redirects"] is False
    h = call["headers"]
    assert h["x-wt-timestamp"] == "1760284800" and h["x-wt-key-id"] == "gcp-use1"
    assert h["x-vercel-protection-bypass"] == "bypass"
    want = hmac.new(b"focus-test-secret", b"1760284800.GET /api/focus", hashlib.sha256).hexdigest()
    assert h["x-wt-signature"] == f"sha256={want}"
    # The same vector the dashboard's own test checks (dashboard/test/options-clone.test.ts).
    assert want == "3b3922dd0b5aa7bdb9ab043108a69e08b8aadf44c48617bf54e7897143320e11"


def test_the_runner_ranks_what_the_route_gives_it(monkeypatch):
    from wt.options import session as sess
    focus, edition = clone_site.read_focus(ENV, Session(Resp(200, GOOD)))
    assert sess.names(focus, edition, "2026-10-20", ["SPY", "QQQ"], 6) == (["SPY", "NVDA"], "focus")
    assert sess.names(focus, edition, "2026-10-21", ["SPY", "QQQ"], 6) == (["SPY", "QQQ"], "fallback")


def test_any_failure_is_none_and_the_runner_falls_back():
    bad = [
        Session(Resp(401, {"error": "unauthorized"})),
        Session(Resp(404, {"error": "no options edition"})),
        Session(Resp(200, bad_json=True)),
        Session(Resp(200, ["not", "an", "object"])),
        Session(Resp(200, {"session": "yesterday", "items": []})),
        Session(Resp(200, {"session": "2026-10-20", "items": "SPY"})),
        Session(requests.ConnectionError("down")),
        Session(requests.Timeout("slow")),
    ]
    for s in bad:
        assert clone_site.read_focus(ENV, s) == (None, None)
    nothing = Session(Resp(200, GOOD))
    assert clone_site.read_focus({}, nothing) == (None, None)
    assert clone_site.read_focus({**ENV, "DASHBOARD_INGEST_SECRET": ""}, nothing) == (None, None)
    assert clone_site.read_focus({**ENV, "DASHBOARD_INGEST_URL": "https://lab.example/other"}, nothing) == (None, None)
    assert nothing.calls == []


def test_a_malformed_name_is_dropped_and_a_bad_rank_or_bias_is_neutralised():
    body = {"session": "2026-10-20", "items": [{"symbol": "spy; rm", "rank": 1, "bias": "breakout"},
                                              {"symbol": "QQQ", "rank": True, "bias": "moon"}, "SPY"]}
    focus, _ = clone_site.read_focus(ENV, Session(Resp(200, body)))
    assert focus == {"items": [{"symbol": "QQQ", "rank": 99, "bias": None}]}


def test_the_publisher_sends_the_newest_and_never_raises():
    gate = threading.Event()
    seen: list[bytes] = []

    def send(data: bytes) -> tuple[bool, str]:
        gate.wait(5)
        seen.append(data)
        if data == b"boom":
            raise RuntimeError("x")
        return data != b"refused", "HTTP 422: no" if data == b"refused" else "HTTP 200"

    p = clone_site.Publisher(send)
    p.post(b"first")
    for b in (b"second", b"refused", b"boom", b"last"):    # while the first is in flight: only the last waits
        p.post(b)
    gate.set()
    p.close(5)
    assert seen[0] in (b"first", b"last") and seen[-1] == b"last" and len(seen) <= 2
    assert p.sent == len(seen) and p.failed == 0


def test_the_publisher_counts_failures_and_stops_on_close():
    p = clone_site.Publisher(lambda data: (_ for _ in ()).throw(RuntimeError("down")))
    p.post(b"x")
    p.close(5)
    assert (p.sent, p.failed, p.last) == (0, 1, "network_RuntimeError")
    assert not p._t.is_alive()


def test_no_publisher_without_a_url_a_secret_or_a_shadow_hosts_own_key():
    assert clone_site.publisher_from_env({}) is None
    assert clone_site.publisher_from_env({**ENV, "DASHBOARD_INGEST_SECRET": ""}) is None
    assert clone_site.publisher_from_env({**ENV, "WT_ROLE": "shadow", "DASHBOARD_KEY_ID": ""}) is None
    p = clone_site.publisher_from_env(ENV)
    assert p is not None
    p.close(1)
