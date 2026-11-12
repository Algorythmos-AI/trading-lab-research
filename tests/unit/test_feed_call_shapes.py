"""B9: every data request the code sends today, in the shape it sends it, passes `require_feed`.

One case per call site, named by file. Where the code can be run against a fake session it is, and the request it
would send is recorded; the two hand-run scripts (r3_run, options_clone_dry_run) are copied as literals, since
importing them sets up paths and caches. A change to any of these requests that drops or blanks its feed fails here
as well as in the static scan (test_feed_named.py).
"""
from __future__ import annotations

import datetime as dt
from typing import Any

import pandas as pd
import pytest

from wt.data import tape
from wt.data.alpaca import DATA, AlpacaREST, HybridFeed, RateLimiter
from wt.data.feeds import FeedNotNamed, require_feed
from wt.live.runner_b import LiveData
from wt.live.runner_o import AlpacaFeeds
from wt.options import pipeline_check
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


def _hybrid(sent: Sent) -> None:
    HybridFeed(_rest(sent), now=lambda: pd.Timestamp(T0)).bars(["SPY"], "1Min", "2026-11-12T13:00:00Z",
                                                                  "2026-11-12T15:00:00Z", feed="hybrid")


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


def _r3_run(sent: Sent) -> None:                          # scripts/r3_run.py SpreadAt.__call__, as written there
    sent.append(("https://data.alpaca.markets/v2/stocks/quotes",
                 {"symbols": "SPY", "start": "x", "end": "y", "feed": "sip", "limit": 1000}))


def _options_clone_dry_run(sent: Sent) -> None:          # scripts/options_clone_dry_run.py option_bars: no feed taken
    sent.append((f"{DATA}/v1beta1/options/bars", {"symbols": "SPY261112C00600000", "timeframe": "1Min",
                                                  "limit": "10000", "start": "x", "end": "y"}))


SITES = {
    "src/wt/data/alpaca.py": _alpaca_py,
    "src/wt/data/alpaca.py (HybridFeed)": _hybrid,
    "src/wt/live/runner_b.py": _runner_b,
    "src/wt/live/runner_o.py": _runner_o,
    "src/wt/options/live.py": _options_live,
    "src/wt/options/pipeline_check.py": _pipeline_check,
    "src/wt/data/tape.py": _tape,
    "src/wt/scanner/features.py": _features,
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
