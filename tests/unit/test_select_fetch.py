"""The selection's input bundles and their fetchers (wt.options.select_fetch, DEC-0046).

Offline: a fake HTTP session stands in for Alpaca behind a real `AlpacaREST`, so the run-time feed guard runs on
every request exactly as it would against the host. Every answer is synthetic; no key is read and nothing is sent.
"""
from __future__ import annotations

import datetime as dt
import json
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import pytest

from wt.data import alpaca as alpaca_data
from wt.data.alpaca import AlpacaREST, RateLimiter
from wt.data.feeds import feeds_for
from wt.options import levels as lv
from wt.options import select as sel
from wt.options import select_fetch as sf
from wt.options import select_stage2 as s2

P, _ = s2.load_params()
P1, _ = sel.load_params()
S, D = "2026-11-12", "2026-11-11"
NAMES = ["SPY", "QQQ", "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "PLTR", "AVGO", "AMD"]
T = s2.pass_time(S, "A", P)
HEADLINE = "ZZQHEADLINEQZZ"


class Resp:
    def __init__(self, status: int, body: Any, headers: dict[str, str] | None = None) -> None:
        self.status_code, self.body = status, body
        self.headers = {"X-RateLimit-Limit": "10000", **(headers or {})}

    def json(self) -> Any:
        return self.body


def z(t: dt.datetime) -> str:
    return s2.iso(t)


def _sessions(start: str, end: str) -> list[str]:
    out, d = [], dt.date.fromisoformat(start)
    while d.isoformat() <= end:
        if lv.is_session(d.isoformat()):
            out.append(d.isoformat())
        d += dt.timedelta(days=1)
    return out


def bar(t: dt.datetime, c: float = 100.0, v: int = 100) -> dict[str, Any]:
    return {"t": z(t), "o": c, "h": c + 0.5, "l": c - 0.5, "c": c, "v": v, "n": 3, "vw": c}


class Alpaca:
    """A fake data host: answers by path, records each request, and can be told to fail one kind of request."""

    def __init__(self, clock: Clock, step_s: float = 0.5) -> None:
        self.clock, self.step = clock, step_s
        self.sent: list[tuple[str, dict[str, Any]]] = []
        self.fail: dict[str, list[Resp]] = {}          # a request kind -> answers to give first
        self.page_size: dict[str, int] = {}
        self.news_items = 3

    def kind(self, url: str, params: dict[str, Any]) -> str:
        path = urlsplit(url).path
        if path.endswith("/bars"):
            return {"1Day": "daily", "1Min": "minute", "5Min": "premarket"}[params["timeframe"]]
        return {"/v2/stocks/snapshots": "snapshots", "/v1/corporate-actions": "corporate_actions",
                "/v1beta1/news": "news"}[path]

    def get(self, url: str, params: Any = None, timeout: float = 60) -> Resp:
        q = dict(params or {})
        self.sent.append((url, q))
        self.clock.t += dt.timedelta(seconds=self.step)
        k = self.kind(url, q)
        if self.fail.get(k):
            return self.fail[k].pop(0)
        syms = q["symbols"].split(",")
        if k in ("daily", "minute", "premarket"):
            rows = {s: self._bars(k, q) for s in syms}
            return self._page(k, q, rows)
        if k == "snapshots":
            return Resp(200, {s: {"latestQuote": {"bp": 99.9, "bs": 1, "ap": 100.1, "as": 2, "t": z(T)},
                                  "latestTrade": {"p": 100.0, "s": 5, "t": z(T), "c": ["@", "T"]},
                                  "prevDailyBar": bar(s2.ny_time(D, (0, 0)))} for s in syms})
        if k == "corporate_actions":
            return Resp(200, {"corporate_actions": {"cash_dividends": [
                {"symbol": "AAPL", "ex_date": S, "rate": 0.26, "id": "x1"}]}, "next_page_token": None})
        items = [{"id": i, "headline": f"{HEADLINE} {i}", "summary": f"{HEADLINE} summary", "author": "a b",
                  "url": f"https://example.invalid/{HEADLINE.lower()}-{i}", "symbols": ["AAPL", "XYZ"] if i % 2
                  else ["MSFT", "AAPL"], "created_at": z(T)} for i in range(self.news_items)]
        return self._page("news", q, {"news": items}, key="news")

    def _bars(self, k: str, q: dict[str, Any]) -> list[dict[str, Any]]:
        if k == "daily":
            return [bar(s2.ny_time(d, (0, 0))) for d in _sessions(q["start"], q["end"])]
        start, end = s2.parse_ts(q["start"]), s2.parse_ts(q["end"])
        assert start is not None and end is not None
        step = dt.timedelta(minutes=1 if k == "minute" else 5)
        out, t = [], start
        while t <= end:                                   # Alpaca's end is inclusive: the bar starting at T comes too
            out.append(bar(t))
            t += step
        return out

    def _page(self, k: str, q: dict[str, Any], rows: dict[str, Any], key: str = "bars") -> Resp:
        size = self.page_size.get(k)
        flat = rows["news"] if key == "news" else [(s, r) for s, v in rows.items() for r in v]
        if size is None:
            return Resp(200, {key: rows if key == "bars" else flat, "next_page_token": None})
        at = int(q.get("page_token", "0"))
        chunk = flat[at:at + size]
        token = str(at + size) if at + size < len(flat) else None
        if key == "news":
            return Resp(200, {"news": chunk, "next_page_token": token})
        body: dict[str, list[Any]] = {}
        for s, r in chunk:
            body.setdefault(s, []).append(r)
        return Resp(200, {"bars": body, "next_page_token": token})


class Clock:
    def __init__(self, t: dt.datetime) -> None:
        self.t = t
        self.slept: list[float] = []

    def __call__(self) -> dt.datetime:
        return self.t

    def sleep(self, s: float) -> None:
        self.slept.append(s)
        self.t += dt.timedelta(seconds=s)


def rest(fake: Alpaca) -> AlpacaREST:
    a = AlpacaREST.__new__(AlpacaREST)
    a.s, a.rl = fake, RateLimiter(100_000)                # type: ignore[assignment]
    return a


def stage1_doc() -> dict[str, Any]:
    rows = [{"symbol": s, "final_rank": i + 1, "eligible": True, "picked": i < 4, "shown": {"atr14": 2.0}}
            for i, s in enumerate(NAMES)]
    return {"schema": sel.OUTPUT_SCHEMA, "version": sel.OUTPUT_VERSION, "session": D, "next_session": S,
            "params_sha": "0" * 64, "picks": NAMES[:4], "names": rows}


def setup(at: dt.datetime | None = None, **kw: Any) -> tuple[Clock, Alpaca]:
    clock = Clock(at or T + dt.timedelta(seconds=61))
    return clock, Alpaca(clock, **kw)


def fetch2(clock: Clock, fake: Alpaca, **kw: Any) -> dict[str, Any]:
    return sf.fetch_stage2(rest(fake), stage1_doc(), "A", P, earnings_rows=[], macro_rows=[], clock=clock,
                           sleep=clock.sleep, **kw)


# ---------------------------------------------------------------- Stage 2

def test_a_stage2_fetch_makes_the_documented_requests_and_a_bundle_the_scorer_reads():
    clock, fake = setup()
    b = fetch2(clock, fake)
    s2.check_bundle(b)
    assert len(fake.sent) == 26 and len(b["requests"]) == 26
    kinds = [r["what"] for r in b["requests"]]
    assert kinds.count("premarket") == 21 and set(kinds) == set(s2.DATA_REQUESTS + s2.OTHER_REQUESTS)
    assert b["T"] == "2026-11-12T13:50:00Z" and b["fetched_at"] == "2026-11-12T13:51:01Z"
    assert b["entitlement"]["state"] == "unknown" and b["halt"] == {}
    assert b["plan_check"] == {"x_ratelimit_limit": 10000}
    assert sorted(b["data"]["AAPL"]["premarket"]) == sorted([S] + s2_baseline())
    assert b["data"]["AAPL"]["news_count"] == 3 and b["data"]["MSFT"]["news_count"] == 2
    assert b["data"]["AAPL"]["corporate_actions"] == [{"symbol": "AAPL", "ex_date": S, "rate": 0.26, "id": "x1",
                                                      "type": "cash_dividends"}]
    out = s2.confirm(stage1_doc(), b, "A", P, s2.Thresholds(), sha="x")
    assert out["degraded"] is True                                 # the entitlement probe is not built: unknown
    assert {r["status"] for r in out["names"]} == {"not_confirmed"}
    assert all("entitlement_not_passed" in r["reasons"] for r in out["names"])
    r = next(x for x in out["names"] if x["symbol"] == "MSFT")
    assert r["premarket"]["bars"] == 58                            # the bar starting at T came back and was dropped
    assert r["reference"]["kind"] == "bar" and r["reference"]["bar_age_s"] == 0


def s2_baseline() -> list[str]:
    out = [lv.prev_session(S)]
    while len(out) < 20:
        out.append(lv.prev_session(out[-1]))
    return out


def test_every_market_data_request_names_feed_sip_and_passes_the_runtime_guard(monkeypatch):
    calls: list[str] = []
    real = alpaca_data.require_feed

    def spy(url: object, params: object) -> None:
        calls.append(str(url))
        real(url, params)
    monkeypatch.setattr(alpaca_data, "require_feed", spy)
    clock, fake = setup()
    b = fetch2(clock, fake)
    assert len(calls) == len(fake.sent) == 26                    # the guard saw every request before it was sent
    data = [(u, q) for u, q in fake.sent if feeds_for(u) is not None]
    assert len(data) == 24 and all(q["feed"] == "sip" for _, q in data)
    assert all("feed" not in q for u, q in fake.sent if feeds_for(u) is None)   # news, corporate actions take none
    assert all(r["feed"] == "sip" for r in b["requests"] if r["what"] in s2.DATA_REQUESTS)
    assert {q["adjustment"] for u, q in fake.sent if q.get("timeframe") in ("1Day", "1Min")} == {"raw"}


def test_a_request_without_its_feed_is_refused_before_it_is_sent():
    clock, fake = setup()
    f = sf.Fetcher(rest(fake), max_requests=5, deadline=T + dt.timedelta(hours=1), clock=clock, sleep=clock.sleep)
    with pytest.raises(sf.FetchError) as e:
        f.paged("minute", None, "/v2/stocks/bars", {"symbols": "SPY", "timeframe": "1Min"})
    assert e.value.code == sf.EXIT_FEED and fake.sent == []
    with pytest.raises(sf.FetchError) as e:
        f.paged("minute", None, "/v2/stocks/bars", {"symbols": "SPY", "timeframe": "1Min", "feed": "iex",
                                                     "page_token": "x", "feed2": "sip"} | {"feed": None})
    assert e.value.code == sf.EXIT_FEED and fake.sent == []


def test_every_answer_is_paged_to_its_end():
    clock, fake = setup()
    fake.page_size = {"daily": 7, "news": 2}
    fake.news_items = 5
    b = fetch2(clock, fake)
    daily = next(r for r in b["requests"] if r["what"] == "daily_raw")
    news = next(r for r in b["requests"] if r["what"] == "news")
    assert daily["pages"] == 9 and news["pages"] == 3                  # 12 names x 5 bars = 60 in pages of 7
    assert all(len(b["data"][n]["daily_raw"]) == 5 for n in NAMES)
    assert b["data"]["AAPL"]["news_count"] == 5
    tokens = [q.get("page_token") for u, q in fake.sent if q.get("timeframe") == "1Day"]
    assert tokens == [None, "7", "14", "21", "28", "35", "42", "49", "56"]


def test_x_ratelimit_limit_is_read_as_given():
    clock, fake = setup()
    fake.fail["snapshots"] = [Resp(200, {}, {"X-RateLimit-Limit": "200"})]
    b = fetch2(clock, fake)
    assert b["plan_check"] == {"x_ratelimit_limit": 200}


@pytest.mark.parametrize("status,code", [(401, sf.EXIT_AUTH), (403, sf.EXIT_FORBIDDEN), (500, sf.EXIT_FETCH),
                                         (404, sf.EXIT_FETCH)])
def test_a_failed_answer_stops_the_fetch(status, code):
    clock, fake = setup()
    fake.fail["premarket"] = [Resp(status, {"message": "no"})]
    with pytest.raises(sf.FetchError) as e:
        fetch2(clock, fake)
    assert e.value.code == code


def test_a_429_is_honoured_by_its_retry_after():
    clock, fake = setup()
    fake.fail["minute"] = [Resp(429, {}, {"Retry-After": "2"})]
    b = fetch2(clock, fake)
    assert clock.slept == [2.0] and len(fake.sent) == 27
    assert next(r for r in b["requests"] if r["what"] == "minute")["pages"] == 1


@pytest.mark.parametrize("headers", [{}, {"Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT"}, {"Retry-After": "1000"}])
def test_a_429_that_cannot_be_honoured_cuts_the_fetch_short(headers):
    clock, fake = setup()
    fake.fail["minute"] = [Resp(429, {}, headers)]
    with pytest.raises(sf.FetchError) as e:
        fetch2(clock, fake)
    assert e.value.code == sf.EXIT_CUT_SHORT and clock.slept == []


def test_a_burst_of_429_answers_ends_at_the_request_budget():
    clock, fake = setup()
    fake.fail["daily"] = [Resp(429, {}, {"Retry-After": "1"}) for _ in range(200)]
    with pytest.raises(sf.FetchError) as e:
        fetch2(clock, fake)
    assert e.value.code == sf.EXIT_CUT_SHORT and len(fake.sent) == sf.STAGE2_REQUEST_BUDGET


def test_the_time_budget_stops_the_fetch_at_the_publish_by_time():
    clock, fake = setup(step_s=20.0)              # 26 requests x 20 s passes 08:56 from 08:51:01
    with pytest.raises(sf.FetchError) as e:
        fetch2(clock, fake)
    assert e.value.code == sf.EXIT_CUT_SHORT and "time budget" in str(e.value)
    assert clock() >= s2.ny_time(S, (8, 56))


def test_the_request_budget_stops_the_fetch():
    clock, fake = setup()
    with pytest.raises(sf.FetchError) as e:
        fetch2(clock, fake, max_requests=10)
    assert e.value.code == sf.EXIT_CUT_SHORT and len(fake.sent) == 10


def test_stage2_fetches_at_t_plus_60_s_or_later():
    clock, fake = setup(at=T + dt.timedelta(seconds=59))
    with pytest.raises(sf.FetchError) as e:
        fetch2(clock, fake)
    assert e.value.code == sf.EXIT_TOO_EARLY and fake.sent == []
    clock, fake = setup(at=T + dt.timedelta(seconds=60))
    assert fetch2(clock, fake)["fetched_at"] == "2026-11-12T13:51:00Z"


def test_no_headline_text_reaches_the_bundle():
    clock, fake = setup()
    text = sel.dumps(fetch2(clock, fake))
    assert HEADLINE.lower() not in text.lower() and "summary" not in text and "headline" not in text


def test_news_counts_read_only_the_symbols():
    pages = [{"news": [{"headline": HEADLINE, "symbols": ["AAPL", "MSFT"]}, {"symbols": ["AAPL"]}]}]
    assert sf.news_counts(pages, ["AAPL", "MSFT", "SPY"]) == {"AAPL": 2, "MSFT": 1, "SPY": 0}
    with pytest.raises(sf.FetchError):
        sf.news_counts([{"news": [{"headline": HEADLINE}]}], ["AAPL"])


def test_retry_after_reads_seconds_only():
    assert sf.retry_after({"Retry-After": "3"}) == 3.0 and sf.retry_after({"Retry-After": " 0.5 "}) == 0.5
    assert sf.retry_after({}) is None and sf.retry_after({"Retry-After": "soon"}) is None
    assert sf.retry_after({"Retry-After": "-1"}) is None


# ---------------------------------------------------------------- Stage 1

def test_a_stage1_fetch_writes_the_shape_select_reads():
    clock, fake = setup(at=dt.datetime(2026, 11, 11, 23, 0, tzinfo=s2.UTC))
    doc = sf.fetch_stage1(rest(fake), D, NAMES, min_bars=P1.min_bars, earnings_rows=[], macro_rows=[],
                          clock=clock, sleep=clock.sleep)
    sel.check_bundle(doc)
    assert len(fake.sent) == 1
    url, q = fake.sent[0]
    assert (q["feed"], q["adjustment"], q["timeframe"], q["end"]) == ("sip", "split", "1Day", D)
    assert q["start"] == sel.session_window(D, P1.min_bars)[0]
    assert all(len(doc["bars"][n]) == 260 and doc["bars"][n][-1]["d"] == D for n in NAMES)
    out = sel.run_bundle(doc, P1, sha="x", ref="s1-test")
    assert out["counts"]["data_valid"] == 12


def test_stage1_is_refused_before_the_close_is_final():
    clock, fake = setup(at=dt.datetime(2026, 11, 11, 21, 14, tzinfo=s2.UTC))     # 16:14 New York
    with pytest.raises(sf.FetchError) as e:
        sf.fetch_stage1(rest(fake), D, NAMES, min_bars=P1.min_bars, earnings_rows=[], macro_rows=[],
                        clock=clock, sleep=clock.sleep)
    assert e.value.code == sf.EXIT_TOO_EARLY and fake.sent == []


# ---------------------------------------------------------------- the command

def _main(tmp_path: Path, clock: Clock, fake: Alpaca, *args: str) -> int:
    return sf.main(list(args) + ["--root", str(tmp_path / "var")], client=lambda: rest(fake), clock=clock,
                   sleep=clock.sleep)


def _stage1_file(tmp_path: Path) -> Path:
    p = tmp_path / "stage1.json"
    p.write_text(json.dumps(stage1_doc()))
    return p


def test_the_command_writes_a_bundle_once_and_never_over_it(tmp_path, capsys):
    s1 = _stage1_file(tmp_path)
    clock, fake = setup()
    assert _main(tmp_path, clock, fake, "stage2", "--pass", "A", "--stage1", str(s1)) == sf.EXIT_OK
    path = tmp_path / "var" / S / "stage2-A-bundle.json"
    first = path.read_text()
    s2.check_bundle(json.loads(first))
    sent = len(fake.sent)
    assert _main(tmp_path, clock, fake, "stage2", "--pass", "A", "--stage1", str(s1)) == sf.EXIT_EXISTS
    assert len(fake.sent) == sent and path.read_text() == first        # refused before fetching anything
    assert _main(tmp_path, clock, fake, "stage2", "--pass", "A", "--stage1", str(s1), "--beside") == sf.EXIT_OK
    assert (tmp_path / "var" / S / "stage2-A-bundle.2.json").exists() and path.read_text() == first
    assert sorted(p.name for p in (tmp_path / "var" / S).iterdir()) == ["stage2-A-bundle.2.json",
                                                                        "stage2-A-bundle.json"]
    out = capsys.readouterr()
    assert HEADLINE.lower() not in (out.out + out.err).lower()


def test_stage1_is_not_re_run_once_a_confirmation_exists(tmp_path):
    clock, fake = setup(at=dt.datetime(2026, 11, 11, 23, 0, tzinfo=s2.UTC))
    assert _main(tmp_path, clock, fake, "stage1", "--session", D) == sf.EXIT_OK
    assert (tmp_path / "var" / S / "stage1-bundle.json").exists()
    assert _main(tmp_path, clock, fake, "stage1", "--session", D) == sf.EXIT_EXISTS
    (tmp_path / "var" / S / "stage2-A-bundle.json").write_text("{}")
    assert _main(tmp_path, clock, fake, "stage1", "--session", D, "--beside") == sf.EXIT_CONFIRMED


@pytest.mark.parametrize("case,code", [
    ("401", sf.EXIT_AUTH), ("403", sf.EXIT_FORBIDDEN), ("partial", sf.EXIT_FETCH), ("429", sf.EXIT_CUT_SHORT),
    ("time", sf.EXIT_CUT_SHORT), ("early", sf.EXIT_TOO_EARLY), ("stage1 unreadable", sf.EXIT_INPUT),
    ("usage", sf.EXIT_USAGE), ("not a session", sf.EXIT_INPUT)])
def test_a_failed_or_partial_fetch_writes_no_bundle(tmp_path, capsys, case, code):
    s1 = _stage1_file(tmp_path)
    clock, fake = setup(at=T + dt.timedelta(seconds=30) if case == "early" else None,
                        step_s=20.0 if case == "time" else 0.5)
    args = ["stage2", "--pass", "A", "--stage1", str(s1)]
    if case == "401":
        fake.fail["daily"] = [Resp(401, {"message": "unauthorized"})]
    elif case == "403":
        fake.fail["snapshots"] = [Resp(403, {"message": "subscription does not permit"})]
    elif case == "partial":
        fake.fail["news"] = [Resp(502, {})]                    # every other request already answered
    elif case == "429":
        fake.fail["corporate_actions"] = [Resp(429, {})]
    elif case == "stage1 unreadable":
        s1.write_text("{")
    elif case == "usage":
        args = ["stage3"]
    elif case == "not a session":
        args = ["stage1", "--session", "2026-11-14"]
    assert _main(tmp_path, clock, fake, *args) == code
    assert not (tmp_path / "var").exists() or not any((tmp_path / "var").rglob("*.json"))
    err = capsys.readouterr().err
    assert len(err.strip().splitlines()) == 1 and "Traceback" not in err
    assert HEADLINE.lower() not in err.lower()


def test_the_bundle_folder_is_git_ignored():
    root = s2.ROOT
    gi = (root / ".gitignore").read_text().splitlines()
    assert "/var/" in gi and sf.VAR_SELECT == root / "var" / "select"
