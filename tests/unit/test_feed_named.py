"""B9: every Alpaca market-data request names its feed (docs/runbooks/keys-and-feeds.md).

Alpaca's default for an omitted `feed` is the best one the subscription allows (IEX on the free plan, SIP on a paid
one, IEX again after a lapse), so a request that leaves it out changes its data source with the plan. Two guards:
`AlpacaREST.get` refuses such a request at run time (wt.data.feeds.require_feed), and the static scan
(tests/unit/feed_scan.py) checks every call in src/, scripts/ and deploy/ that sends one, including the modules with
their own HTTP session (runner_o, options.live, pipeline_check: the scan is their only guard for now), and every
alpaca-py data request class, whose `feed=None` is left out of the query.

Known limits of the scan, each covered as stated:
- A URL whose data base and path both come from elsewhere (a function parameter, or a constant imported from another
  module and joined to nothing visible): the scan cannot see it is a data request. Anything sent through
  `AlpacaREST.get` is still refused at run time; the three own-session modules are not, until they call
  `require_feed` (scheduled after #386).
- A params dict built in another function, returned and passed in: the scan sees a name with no visible feed and
  flags it (a false positive is preferred to a miss); the runtime guard covers it through `AlpacaREST.get`.
- Anything dynamic (getattr, eval, a dict built in a loop from data): not followed.
"""
from __future__ import annotations

import inspect
from pathlib import Path

import pytest

import alpaca.data.requests as sdk_requests
from feed_scan import scan
from wt.data import alpaca as alpaca_data
from wt.data.alpaca import AlpacaREST, HybridFeed, RateLimiter
from wt.data.feeds import FeedNotNamed, feeds_for, require_feed

ROOT = Path(__file__).resolve().parents[2]
SCAN = ("src", "scripts", "deploy")
EXEMPT = {"src/wt/data/feeds.py"}          # the rule's own home names the paths it checks
# The alpaca-py request classes with a `feed` field (read from the installed SDK, never listed by hand) and the
# streams, whose own default is a fixed feed but which must still name it here.
SDK_FEED_CALLS = {name for name, cls in vars(sdk_requests).items()
                  if inspect.isclass(cls) and "feed" in getattr(cls, "model_fields", {})} | {"StockDataStream",
                                                                                          "OptionDataStream"}

# Requests that do not name their feed, each awaiting the owner's decision. Phase 1 of B9 found none, so the list is
# empty. An entry is the scan's "path:line: why" with the comment "implicit: awaiting the owner's decision (B9)".
# The scan fails on a new one, and on an entry that no longer exists.
KNOWN_IMPLICIT: dict[str, str] = {}
# The raw data requests the B9 inventory found: the scan must keep seeing each one (by file), or it passes vacuously.
KNOWN_REQUESTS = {"scripts/r3_run.py": 1, "src/wt/data/alpaca.py": 1, "src/wt/data/tape.py": 1,
                  "src/wt/live/runner_b.py": 2, "src/wt/live/runner_o.py": 4, "src/wt/options/live.py": 2,
                  "src/wt/options/pipeline_check.py": 2, "src/wt/scanner/features.py": 1}


def _sources() -> list[Path]:
    return sorted(p for d in SCAN for p in (ROOT / d).rglob("*") if p.is_file() and "__pycache__" not in p.parts)


def _scan_tree() -> tuple[list[str], list[str]]:
    problems: list[str] = []
    seen: list[str] = []
    for p in _sources():
        rel = p.relative_to(ROOT).as_posix()
        if rel in EXEMPT:
            continue
        if p.suffix == ".py":
            problems += scan(rel, p.read_text(), SDK_FEED_CALLS, seen)
        elif "data.alpaca.markets" in p.read_text(errors="replace"):
            problems.append(f"{rel}: a data request outside Python")     # deploy's shell scripts call no data host
    return problems, seen


def _scan(src: str) -> list[str]:
    return scan("x.py", src, SDK_FEED_CALLS)


def test_scan_sees_every_known_request() -> None:
    _, seen = _scan_tree()
    counts: dict[str, int] = {}
    for x in seen:
        counts[x.rsplit(":", 1)[0]] = counts.get(x.rsplit(":", 1)[0], 0) + 1
    assert counts == KNOWN_REQUESTS
    assert {"StockBarsRequest", "StockSnapshotRequest", "StockLatestQuoteRequest", "OptionChainRequest",
            "OptionSnapshotRequest"} <= SDK_FEED_CALLS
    assert "OptionBarsRequest" not in SDK_FEED_CALLS and "NewsRequest" not in SDK_FEED_CALLS


def test_no_new_request_without_a_feed() -> None:
    problems, _ = _scan_tree()
    assert [x for x in problems if x not in KNOWN_IMPLICIT] == []


def test_every_known_exception_still_exists() -> None:
    problems, _ = _scan_tree()
    assert [x for x in KNOWN_IMPLICIT if x not in problems] == []


# The cases the B9 review found the first scan missed (one function scope, a leading slash, one piece): each must now
# be caught.
MISSED = {
    "two requests in one function, only one names a feed": """
def f(s):
    a = s.get(f"{DATA}/v2/stocks/bars", {"symbols": "SPY", "feed": "iex"})
    b = s.get(f"{DATA}/v2/stocks/snapshots", {"symbols": "SPY"})
""",
    "an unrelated feed= elsewhere hides a request": """
def f(s, cfg):
    log(feed=cfg.feed)
    return s.get(DATA + "/v2/stocks/quotes/latest", {"symbols": "SPY"})
""",
    "no leading slash": """
def f(s):
    return s.get(DATA_URL + "v2/stocks/bars", {"symbols": "SPY"})
""",
    "the path in pieces beside a data base": """
def f(s):
    return s.get(DATA + "/v2/" + "stocks/bars", {"symbols": "SPY"})
""",
    "a path through a module constant and a loop variable": """
PATH = "v1beta1/options/snapshots/SPY"
def f(s, paths):
    s.get(f"https://data.alpaca.markets/{PATH}", {"limit": "1000"})
    for p in paths:
        s.get(DATA_HOST + p, {"limit": "1000"})
""",
    '"feed": None': """
def f(s):
    return s.get(f"{DATA}/v2/stocks/bars", {"symbols": "SPY", "feed": None})
""",
    "a feed set only under a condition": """
def f(s, feed):
    p = {"symbols": "SPY"}
    if feed:
        p["feed"] = feed
    return s.get(f"{DATA}/v2/stocks/bars", p)
""",
    "a later update, pop or del on the same dict": """
def f(s, extra):
    p = {"symbols": "SPY", "feed": "iex"}
    p.update(extra)
    q = {"symbols": "SPY", "feed": "iex"}
    q.pop("feed")
    r = {"symbols": "SPY", "feed": "iex"}
    del r["feed"]
    return s.get(f"{DATA}/v2/stocks/bars", p), s.get(f"{DATA}/v2/stocks/bars", q), s.get(f"{DATA}/v2/stocks/bars", r)
""",
    "an aliased SDK request class": """
from alpaca.data.requests import StockBarsRequest as Bars
def f(c):
    return c.get_stock_bars(Bars(symbol_or_symbols="SPY", timeframe=tf))
""",
    "model_validate without a feed, and feed=None": """
from alpaca.data.requests import StockLatestQuoteRequest
def f(c):
    a = StockLatestQuoteRequest.model_validate({"symbol_or_symbols": "SPY"})
    b = StockLatestQuoteRequest(symbol_or_symbols="SPY", feed=None)
""",
}


@pytest.mark.parametrize("case", list(MISSED))
def test_a_missed_case_is_now_caught(case: str) -> None:
    got = _scan(MISSED[case])
    assert got, case
    if case == "a later update, pop or del on the same dict":
        assert len(got) == 3
    if case == "two requests in one function, only one names a feed":
        assert got == ["x.py:4: a data request names no feed (f)"]
    if case in ("model_validate without a feed, and feed=None",
                "a path through a module constant and a loop variable"):
        assert len(got) == 2


def test_the_scan_passes_requests_that_name_their_feed() -> None:
    good = """
from alpaca.data.requests import StockBarsRequest as Bars
def snap(s, syms, feed):
    return s.get("https://data.alpaca.markets/v2/stocks/snapshots", {"symbols": ",".join(syms), "feed": feed})

def page(s, p, token):
    p["feed"] = "iex"
    while token:
        p = {**p, "page_token": token}
        token = s.get(f"{DATA}/v2/stocks/bars", p)

def query(s, feed):
    return s.get(f"{DATA}/v2/stocks/quotes/latest?symbols=SPY&feed={feed}")

def unrelated(s, extra):
    p = {"feed": "iex"}
    p.update({"page_token": "t"})
    return s.get(f"{DATA}/v1beta1/news", {}), s.get(f"{DATA}/v1beta1/options/bars", {}), s.get(DATA + "/v2/stocks/meta/exchanges", {})

def sdk(k, s):
    return StockDataStream(k, s, feed=DataFeed.IEX), Bars(symbol_or_symbols="SPY", feed="sip"), Bars.model_validate({"feed": "iex"})
"""
    assert _scan(good) == []


def test_the_bars_default_is_a_named_feed() -> None:
    """`a.bars(...)` without `feed=` sends the default argument: SIP, named on the wire, whatever the plan."""
    assert inspect.signature(AlpacaREST.bars).parameters["feed"].default == "sip"
    assert inspect.signature(HybridFeed.bars).parameters["feed"].default == "sip"


def test_feeds_for_paths() -> None:
    d = alpaca_data.DATA
    assert feeds_for(f"{d}/v2/stocks/bars") == feeds_for(f"{d}/v2/stocks/quotes/latest")
    for path in ("snapshots", "trades", "quotes", "bars/latest", "SPY/bars", "SPY/snapshot", "SPY/quotes/latest"):
        assert {"iex", "sip"} <= set(feeds_for(f"{d}/v2/stocks/{path}") or ())
    assert feeds_for(f"{d}/v1beta1/options/snapshots/SPY") == ("indicative", "opra")
    assert feeds_for(f"{d}/v1beta1/options/quotes/latest") == ("indicative", "opra")
    for none in (f"{d}/v1beta1/news", f"{d}/v1beta1/options/bars", f"{alpaca_data.TRADING}/v2/calendar",
                 "https://example.test/v2/stocks/bars", f"{d}/v2/stocks/meta/exchanges",
                 f"{d}/v2/stocks/meta/conditions/trade", f"{d}/v2/stocks/auctions"):
        assert feeds_for(none) is None


def test_require_feed() -> None:
    d = alpaca_data.DATA
    require_feed(f"{d}/v2/stocks/bars", {"feed": "iex"})
    require_feed(f"{d}/v1beta1/options/snapshots/SPY", {"feed": "indicative"})
    require_feed(f"{d}/v1beta1/news", None)
    require_feed(f"{d}/v2/stocks/meta/exchanges", None)                   # metadata takes no feed
    require_feed(f"{d}/v2/stocks/bars?symbols=SPY&feed=sip", {"symbols": "SPY"})     # a feed in the query
    require_feed(f"{d}/v1beta1/options/snapshots/SPY?feed=opra", None)
    for url, params in ((f"{d}/v2/stocks/bars", None), (f"{d}/v2/stocks/bars", {"symbols": "SPY"}),
                        (f"{d}/v2/stocks/bars", {"feed": ""}), (f"{d}/v2/stocks/bars", {"feed": "opra"}),
                        (f"{d}/v1beta1/options/snapshots/SPY", {"feed": "iex"}),
                        (f"{d}/v2/stocks/bars?feed=", None), (f"{d}/v2/stocks/bars?feed=opra", None),
                        (f"{d}/v2/stocks/bars?feed=sip", {"feed": "bogus"})):
        with pytest.raises(FeedNotNamed, match="must name its feed"):
            require_feed(url, params)


class _Session:
    def __init__(self) -> None:
        self.calls: list[tuple[str, object]] = []

    def get(self, url: str, params: object = None, timeout: float = 0) -> object:
        self.calls.append((url, params))
        raise AssertionError("nothing may be sent")


def test_alpaca_rest_refuses_before_sending() -> None:
    a = AlpacaREST.__new__(AlpacaREST)
    a.s, a.rl = _Session(), RateLimiter(10_000)      # type: ignore[assignment]
    with pytest.raises(FeedNotNamed):
        a.get(f"{alpaca_data.DATA}/v2/stocks/quotes", {"symbols": "SPY"})
    assert a.s.calls == []
