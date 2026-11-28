"""B9: every data request the code sends today, in the shape it sends it, passes `require_feed`.

One case per call site, named by file. Where the code can be run against a fake session it is, and the request it
would send is recorded; the two hand-run scripts (r3_run, options_clone_dry_run) are copied as literals, since
importing them sets up paths and caches. A change to any of these requests that drops or blanks its feed fails here
as well as in the static scan (test_feed_named.py).
"""
from __future__ import annotations

import datetime as dt
from pathlib import Path
from typing import Any

import pandas as pd
import pytest
import requests
import yaml

from wt.data import tape
from wt.data.alpaca import DATA, AlpacaREST, RateLimiter
from wt.data.feeds import OPTION_FEEDS, FeedNotNamed, require_feed
from wt.live.runner_b import LiveData
from wt.live import runner_o
from wt.live.runner_o import AlpacaFeeds
from wt.options import live, pipeline_check
from wt.options.live import OptionsAccount
from wt.scanner import features

Sent = list[tuple[str, Any]]


class _Resp:
    status_code = 200
    headers: dict[str, str] = {}

    def __init__(self, body: Any) -> None:
        self.body = body

    def json(self) -> Any:
        return self.body

    def raise_for_status(self) -> None:
        return None


class _Session:
    """Records every GET; answers each data path with an empty body of the right shape."""

    def __init__(self, sent: Sent) -> None:
        self.sent = sent

    def get(self, url: str, params: Any = None, **_: Any) -> _Resp:
        self.sent.append((url, params))
        if "/snapshots" in url:
            return _Resp({"snapshots": {}} if "options" in url else {})
        return _Resp({"bars": {}, "quotes": {}, "trades": {}, "news": []})


class _Rest:
    def __init__(self, sent: Sent) -> None:
        self.sent = sent

    def get(self, url: str, params: Any = None, tries: int = 8) -> Any:
        self.sent.append((url, params))
        return {"bars": {}, "quotes": {}, "trades": {}}


def _rest(sent: Sent) -> AlpacaREST:
    a = AlpacaREST.__new__(AlpacaREST)
    a.s, a.rl = _Session(sent), RateLimiter(100_000)      # type: ignore[assignment]
    return a


T0 = dt.datetime(2026, 11, 12, 15, 0, tzinfo=dt.UTC)
DAY = dt.date(2026, 11, 12)


def _alpaca_py(sent: Sent) -> None:
    a = _rest(sent)
    a.bars(["SPY"], "1Min", "2026-11-12T14:30:00Z", "2026-11-12T15:00:00Z")                       # the default feed
    a.bars(["SPY"], "1Day", "2026-01-01", "2026-11-11", feed="sip", adjustment="split")


def _runner_b(sent: Sent) -> None:
    d = LiveData(_Rest(sent))                            # type: ignore[arg-type]
    d.bars_today("QQQ", DAY)
    d.quote("QQQ")


def _runner_o(sent: Sent) -> None:
    for feed in ("indicative", "opra"):
        f = AlpacaFeeds("k", "s", feed, _Session(sent))  # type: ignore[arg-type]
        f.minutes(["SPY"], T0, T0)
        f.daily(["SPY"], T0, T0)
        f.chain("SPY", DAY)
        f.quotes(["SPY261112C00600000"])


def _options_live(sent: Sent) -> None:
    acct = OptionsAccount("k", "s", _Session(sent))      # type: ignore[arg-type]
    acct.closes(["SPY"])
    acct.bars(["SPY"], "30Min", T0, T0)


def _pipeline_check(sent: Sent) -> None:
    def get(url: str, params: Any = None, **_: Any) -> _Resp:
        return _Session(sent).get(url, params)
    pipeline_check.fetch_bars(["SPY"], "2026-11-12", get=get, sleep=lambda s: None)   # type: ignore[arg-type]
    pipeline_check.fetch_snapshot(["SPY"], get=get, sleep=lambda s: None)          # type: ignore[arg-type]


def _tape(sent: Sent) -> None:
    tape.fetch_window(_Rest(sent), "SPY", pd.Timestamp(T0), pd.Timestamp(T0))


def _features(sent: Sent) -> None:
    features.last_quotes(_Rest(sent), ["SPY"], DAY)       # type: ignore[arg-type]


def _select_fetch(sent: Sent) -> None:
    from wt.options import select_fetch, select_stage2
    p, _ = select_stage2.load_params()
    at = select_stage2.pass_time("2026-11-12", "A", p) + dt.timedelta(seconds=61)
    stage1 = {"schema": "wt.options.select/stage1", "version": 1, "session": "2026-11-11",
              "next_session": "2026-11-12", "params_sha": "0" * 64, "picks": ["SPY"],
              "names": [{"symbol": "SPY"}, {"symbol": "QQQ"}]}
    select_fetch.fetch_stage2(_rest(sent), stage1, "A", p, earnings_rows=[], macro_rows=[], clock=lambda: at,
                              sleep=lambda s: None)
    select_fetch.fetch_stage1(_rest(sent), "2026-11-11", ["SPY", "QQQ"], min_bars=260, earnings_rows=[],
                              macro_rows=[], clock=lambda: dt.datetime(2026, 11, 12, 1, 0, tzinfo=dt.UTC),
                              sleep=lambda s: None)


def _r3_run(sent: Sent) -> None:                          # scripts/r3_run.py SpreadAt.__call__, as written there
    sent.append(("https://data.alpaca.markets/v2/stocks/quotes",
                 {"symbols": "SPY", "start": "x", "end": "y", "feed": "sip", "limit": 1000}))


def _options_clone_dry_run(sent: Sent) -> None:          # scripts/options_clone_dry_run.py option_bars: no feed taken
    sent.append((f"{DATA}/v1beta1/options/bars", {"symbols": "SPY261112C00600000", "timeframe": "1Min",
                                                  "limit": "10000", "start": "x", "end": "y"}))


SITES = {
    "src/wt/data/alpaca.py": _alpaca_py,
    "src/wt/live/runner_b.py": _runner_b,
    "src/wt/live/runner_o.py": _runner_o,
    "src/wt/options/live.py": _options_live,
    "src/wt/options/pipeline_check.py": _pipeline_check,
    "src/wt/data/tape.py": _tape,
    "src/wt/scanner/features.py": _features,
    "src/wt/options/select_fetch.py": _select_fetch,
    "scripts/r3_run.py": _r3_run,
    "scripts/options_clone_dry_run.py": _options_clone_dry_run,
}


@pytest.mark.parametrize("site", list(SITES))
def test_every_request_the_site_sends_names_its_feed(site: str) -> None:
    sent: Sent = []
    SITES[site](sent)
    data = [(u, p) for u, p in sent if "data.alpaca.markets" in u]
    assert data, f"{site}: no data request recorded"
    for url, params in data:
        require_feed(url, params)


def test_a_site_with_its_feed_dropped_is_refused() -> None:
    sent: Sent = []
    _runner_o(sent)
    url, params = sent[0]
    with pytest.raises(FeedNotNamed):
        require_feed(url, {k: v for k, v in params.items() if k != "feed"})


# ---------------------------------------------------------------- the three modules with their own HTTP session
# Each now calls `require_feed` in its one request helper (runner_o AlpacaFeeds._get, options.live
# OptionsAccount._get, pipeline_check._alpaca_get). Every request each helper sends is driven below through the real
# code path, pagination follow-ups, the paper host's listings and pipeline_check's retry included, once with the guard
# replaced by a no-op (the code as it was) and once with it in place: the requests that leave must be the same, in the
# same order and number, and the guard must have seen each one. What a refusal does in each module is tested beside
# that module's own failure handling (test_options_clone_session.py, test_options_live.py, test_pipeline_check.py).
class _PagedSession:
    """Records a copy of every GET; answers each path with the body shape its caller reads, and a next page once for
    each request that has not asked for one yet. `fail_first` raises a ConnectionError on the first call (a retry)."""

    def __init__(self, sent: Sent, fail_first: bool = False) -> None:
        self.sent, self.fail_first = sent, fail_first

    def get(self, url: str, params: Any = None, **_: Any) -> _Resp:
        self.sent.append((url, dict(params) if params is not None else None))
        if self.fail_first:
            self.fail_first = False
            raise requests.ConnectionError("blip")
        token = None if (params or {}).get("page_token") else "page-2"
        path = url.split("data.alpaca.markets", 1)[-1].split("paper-api.alpaca.markets", 1)[-1]
        if path == "/v2/positions":
            return _Resp([])
        if path == "/v2/clock":
            return _Resp({})
        if path == "/v2/stocks/snapshots":
            return _Resp({})
        if path == "/v2/stocks/bars":
            return _Resp({"bars": {"SPY": []}, "next_page_token": token})
        if path.startswith("/v1beta1/options/snapshots"):
            return _Resp({"snapshots": {}, "next_page_token": token})
        if path == "/v2/options/contracts":
            return _Resp({"option_contracts": [], "next_page_token": token})
        raise AssertionError(f"unexpected request: {url}")


def _clone_helper(sent: Sent) -> None:
    for feed in ("indicative", "opra"):
        f = AlpacaFeeds("k", "s", feed, _PagedSession(sent))   # type: ignore[arg-type]
        f.minutes(["SPY", "QQQ"], T0, T0)
        f.daily(["SPY"], T0, T0)
        f.chain("SPY", DAY)
        f.quotes(["SPY261112C00600000"])
        f.contracts("SPY", DAY)
        f.contracts("SPY", DAY, DAY + dt.timedelta(days=7))


def _options_live_helper(sent: Sent) -> None:
    acct = OptionsAccount("k", "s", _PagedSession(sent))        # type: ignore[arg-type]
    acct.positions()
    acct.clock()
    acct.closes(["SPY", "QQQ"])
    acct.bars(["SPY"], "1Day", T0, T0)
    acct.bars(["SPY"], "30Min", T0, T0)
    acct.contracts("SPY", 590.0, 610.0, DAY, DAY + dt.timedelta(days=35))


def _pipeline_check_helper(sent: Sent) -> None:
    s = _PagedSession(sent, fail_first=True)                    # the first call (daily bars) is retried once
    pipeline_check.fetch_bars(["SPY"], "2026-11-12", get=s.get, sleep=lambda x: None)
    pipeline_check.fetch_listings(["SPY", "QQQ"], "2026-11-12", get=s.get, sleep=lambda x: None)
    pipeline_check.fetch_snapshot(["SPY"], get=s.get, sleep=lambda x: None)


D, P = DATA, "https://paper-api.alpaca.markets"
# (module, driver, the URL of every request sent, in order). The params are compared whole with the unguarded run.
OWN_SESSIONS = {
    "src/wt/live/runner_o.py": (runner_o, _clone_helper, 2 * [
        f"{D}/v2/stocks/bars", f"{D}/v2/stocks/bars",                          # minutes, page 1 and 2 (sip)
        f"{D}/v2/stocks/bars", f"{D}/v2/stocks/bars",                          # daily (sip)
        f"{D}/v1beta1/options/snapshots/SPY", f"{D}/v1beta1/options/snapshots/SPY",   # chain (the option feed)
        f"{D}/v1beta1/options/snapshots", f"{D}/v1beta1/options/snapshots",    # quotes (the option feed)
        f"{P}/v2/options/contracts", f"{P}/v2/options/contracts",              # one expiry (paper host, no feed)
        f"{P}/v2/options/contracts", f"{P}/v2/options/contracts"]),            # a range of expiries
    "src/wt/options/live.py": (live, _options_live_helper, [
        f"{P}/v2/positions", f"{P}/v2/clock",                                  # paper host, no params
        f"{D}/v2/stocks/snapshots",                                            # closes (sip)
        f"{D}/v2/stocks/bars", f"{D}/v2/stocks/bars",                          # daily bars, two pages (sip)
        f"{D}/v2/stocks/bars", f"{D}/v2/stocks/bars",                          # half-hour bars, two pages (sip)
        f"{P}/v2/options/contracts", f"{P}/v2/options/contracts"]),            # listings, two pages
    "src/wt/options/pipeline_check.py": (pipeline_check, _pipeline_check_helper, [
        f"{D}/v2/stocks/bars", f"{D}/v2/stocks/bars", f"{D}/v2/stocks/bars",   # bars: a blip, its retry, page 2 (sip)
        f"{P}/v2/options/contracts", f"{P}/v2/options/contracts",              # one listing per name
        f"{D}/v2/stocks/snapshots"]),                                          # the snapshot (sip)
}


@pytest.mark.parametrize("site", list(OWN_SESSIONS))
def test_the_own_session_guard_lets_every_request_out_unchanged(site: str, monkeypatch: pytest.MonkeyPatch) -> None:
    module, drive, urls = OWN_SESSIONS[site]
    before: Sent = []
    with monkeypatch.context() as m:
        m.setattr(module, "require_feed", lambda url, params: None)          # the helper as it was
        drive(before)
    checked: Sent = []

    def spy(url: Any, params: Any) -> None:
        checked.append((url, dict(params) if params is not None else None))
        require_feed(url, params)
    monkeypatch.setattr(module, "require_feed", spy)
    after: Sent = []
    drive(after)
    assert [u for u, _ in after] == urls                                 # every request, in order, none added or lost
    assert after == before                                               # same URL, same params, same count
    retried = 1 if site.endswith("pipeline_check.py") else 0             # a retry resends the call already checked
    assert len(checked) == len(after) - retried and all(c in after for c in checked)
    pages = [p for _, p in after if p and "page_token" in p]
    assert pages and all(p["page_token"] == "page-2" for p in pages)     # the follow-ups were sent and checked too


def test_the_clones_committed_option_feed_is_exactly_one_the_guard_accepts() -> None:
    """runner_o passes `feeds.option` through str() unchanged and require_feed matches exactly: `Indicative`, a stray
    space or an empty value would be refused before every chain and quote request. A bad edit fails here, not in a
    session (the clone is not changed to tidy the value: that would be a new behaviour in a live job)."""
    cfg = yaml.safe_load((Path(__file__).resolve().parents[2] / "config" / "options_clone.yaml").read_text())
    assert str(cfg["feeds"]["option"]) in OPTION_FEEDS


def test_robot_b_reads_its_bars_and_quotes_from_the_consolidated_tape() -> None:
    """DEC-0064 point 8: both of B's live requests name sip, and its armed line can say so."""
    from wt.live import runner_b
    sent: Sent = []
    _runner_b(sent)
    assert [p["feed"] for _, p in sent] == ["sip", "sip"] and runner_b.STOCK_FEED == "sip"
    assert [u.rsplit("/v2/stocks/", 1)[1] for u, _ in sent] == ["bars", "quotes/latest"]


def test_paper_positions_and_the_pipeline_check_read_their_snapshots_from_the_consolidated_tape() -> None:
    """DEC-0064 point 10: no stock request of either module names another feed than sip."""
    for drive in (_options_live, _pipeline_check):
        sent: Sent = []
        drive(sent)
        stock = [(u, p) for u, p in sent if "/v2/stocks/" in u]
        assert stock and all(dict(p)["feed"] == "sip" for _, p in stock), [dict(p).get("feed") for _, p in stock]
