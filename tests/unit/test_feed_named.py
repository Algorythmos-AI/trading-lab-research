"""B9: every Alpaca market-data request names its feed (docs/runbooks/keys-and-feeds.md).

Alpaca's default for an omitted `feed` is the best one the subscription allows (IEX on the free plan, SIP on a paid
one, IEX again after a lapse), so a request that leaves it out changes its data source with the plan. Two guards:
`AlpacaREST.get` refuses such a request (wt.data.feeds.require_feed), and the scan below covers the modules that
call Alpaca with their own HTTP session, and the alpaca-py data request classes, whose `feed=None` is left out of
the query.
"""
from __future__ import annotations

import ast
import inspect
import re
from pathlib import Path

import pytest

import alpaca.data.requests as sdk_requests
from wt.data import alpaca as alpaca_data
from wt.data.alpaca import AlpacaREST, HybridFeed, RateLimiter
from wt.data.feeds import FeedNotNamed, feeds_for, require_feed

ROOT = Path(__file__).resolve().parents[2]
SCAN = ("src", "scripts", "deploy")
# A data path that takes a feed: every stock endpoint, and the option quote endpoints (snapshots and latest).
FEED_PATH = re.compile(r"/v2/stocks/|/v1beta1/options/(snapshots|(quotes|trades|bars)/latest)")
EXEMPT = {"src/wt/data/feeds.py"}          # the rule's own home names the paths it checks
# The alpaca-py request classes with a `feed` field (read from the installed SDK, never listed by hand) and the
# streams, whose own default is a fixed feed but which must still name it here.
SDK_FEED_CALLS = {name for name, cls in vars(sdk_requests).items()
                  if inspect.isclass(cls) and "feed" in getattr(cls, "model_fields", {})} | {"StockDataStream",
                                                                                          "OptionDataStream"}

# Requests that do not name their feed, each awaiting the owner's decision. Phase 1 of B9 found none, so the list is
# empty. An entry is "path::function" (or "path:line: Class" for an SDK call) with the comment
# "implicit: awaiting the owner's decision (B9)". The scan fails on a new one, and on an entry that no longer exists.
KNOWN_IMPLICIT: dict[str, str] = {}


def _text(node: ast.AST) -> str | None:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.JoinedStr):
        return "".join(v.value if isinstance(v, ast.Constant) and isinstance(v.value, str) else "{}"
                       for v in node.values)
    return None


def _names_feed(n: ast.AST) -> bool:
    """`n` is `{"feed": ...}`, `feed=...` or `x["feed"] = ...`."""
    if isinstance(n, ast.Dict):
        return any(isinstance(k, ast.Constant) and k.value == "feed" for k in n.keys)
    if isinstance(n, ast.keyword):
        return n.arg == "feed"
    return isinstance(n, ast.Assign) and any(isinstance(t, ast.Subscript) and isinstance(t.slice, ast.Constant)
                                             and t.slice.value == "feed" for t in n.targets)


def unnamed(rel: str, source: str) -> list[str]:
    """Each function that writes a feed-taking data path but names no feed, and each SDK data call without `feed=`."""
    tree = ast.parse(source)
    out: list[str] = []

    def scope(node: ast.AST, qual: str) -> None:
        own: list[ast.AST] = []                  # this scope's nodes, nested functions and classes left out
        stack = list(ast.iter_child_nodes(node))
        while stack:
            n = stack.pop()
            if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                scope(n, f"{qual}.{n.name}" if qual else n.name)
                continue
            if isinstance(n, ast.Expr) and _text(n.value) is not None:
                continue                         # a docstring or a bare string sends nothing
            own.append(n)
            stack.extend(ast.iter_child_nodes(n))
        if any((t := _text(n)) is not None and FEED_PATH.search(t) for n in own):
            if not any(_names_feed(n) for n in own):
                out.append(f"{rel}::{qual or '<module>'}")

    scope(tree, "")
    for n in ast.walk(tree):
        if isinstance(n, ast.Call):
            name = n.func.id if isinstance(n.func, ast.Name) else n.func.attr if isinstance(n.func, ast.Attribute) else ""
            if name in SDK_FEED_CALLS and not any(k.arg == "feed" for k in n.keywords):
                out.append(f"{rel}:{n.lineno}: {name}")
    return out


def _sources() -> list[Path]:
    return sorted(p for d in SCAN for p in (ROOT / d).rglob("*") if p.is_file() and "__pycache__" not in p.parts)


def _found() -> list[str]:
    out: list[str] = []
    for p in _sources():
        rel = p.relative_to(ROOT).as_posix()
        if rel in EXEMPT:
            continue
        if p.suffix == ".py":
            out += unnamed(rel, p.read_text())
        elif "data.alpaca.markets" in p.read_text(errors="replace"):
            out.append(f"{rel}: a data request outside Python")       # deploy's shell scripts call no data host
    return out


def test_scan_reads_the_modules_with_their_own_http() -> None:
    rels = {p.relative_to(ROOT).as_posix() for p in _sources()}
    for f in ("src/wt/live/runner_o.py", "src/wt/live/runner_b.py", "src/wt/options/live.py",
              "src/wt/options/pipeline_check.py", "src/wt/data/alpaca.py", "src/wt/data/tape.py",
              "scripts/r3_run.py", "scripts/options_clone_dry_run.py"):
        assert f in rels
    assert {"StockBarsRequest", "StockSnapshotRequest", "StockLatestQuoteRequest", "OptionChainRequest",
            "OptionSnapshotRequest"} <= SDK_FEED_CALLS
    assert "OptionBarsRequest" not in SDK_FEED_CALLS and "NewsRequest" not in SDK_FEED_CALLS


def test_no_new_request_without_a_feed() -> None:
    assert [x for x in _found() if x not in KNOWN_IMPLICIT] == []


def test_every_known_exception_still_exists() -> None:
    found = set(_found())
    assert [x for x in KNOWN_IMPLICIT if x not in found] == []


def test_the_scan_flags_a_missing_feed() -> None:
    bad = '''
def snap(s, syms):
    return s.get("https://data.alpaca.markets/v2/stocks/snapshots", {"symbols": ",".join(syms)})

def chain(s, root):
    return s.get(f"{HOST}/v1beta1/options/snapshots/{root}", {"limit": "1000"})

def bars(c):
    return c.get_stock_bars(StockBarsRequest(symbol_or_symbols="SPY", timeframe=TimeFrame.Minute))
'''
    assert sorted(unnamed("x.py", bad)) == ["x.py:9: StockBarsRequest", "x.py::chain", "x.py::snap"]
    good = '''
def snap(s, syms, feed):
    return s.get("https://data.alpaca.markets/v2/stocks/snapshots", {"symbols": ",".join(syms), "feed": feed})

def page(s, p):
    p["feed"] = "iex"
    return s.get(f"{HOST}/v2/stocks/bars", p)

def news(s):
    return s.get(f"{HOST}/v1beta1/news", {}), s.get(f"{HOST}/v1beta1/options/bars", {})

def stream(k, s):
    return StockDataStream(k, s, feed=DataFeed.IEX), StockBarsRequest(symbol_or_symbols="SPY", feed="sip")
'''
    assert unnamed("y.py", good) == []


def test_the_bars_default_is_a_named_feed() -> None:
    """`a.bars(...)` without `feed=` sends the default argument: SIP, named on the wire, whatever the plan."""
    assert inspect.signature(AlpacaREST.bars).parameters["feed"].default == "sip"
    assert inspect.signature(HybridFeed.bars).parameters["feed"].default == "sip"


def test_feeds_for_paths() -> None:
    d = alpaca_data.DATA
    assert feeds_for(f"{d}/v2/stocks/bars") == feeds_for(f"{d}/v2/stocks/quotes/latest")
    assert "iex" in (feeds_for(f"{d}/v2/stocks/snapshots") or ()) and "sip" in (feeds_for(f"{d}/v2/stocks/x") or ())
    assert feeds_for(f"{d}/v1beta1/options/snapshots/SPY") == ("indicative", "opra")
    assert feeds_for(f"{d}/v1beta1/options/quotes/latest") == ("indicative", "opra")
    for none in (f"{d}/v1beta1/news", f"{d}/v1beta1/options/bars", f"{alpaca_data.TRADING}/v2/calendar",
                 "https://example.test/v2/stocks/bars"):
        assert feeds_for(none) is None


def test_require_feed() -> None:
    d = alpaca_data.DATA
    require_feed(f"{d}/v2/stocks/bars", {"feed": "iex"})
    require_feed(f"{d}/v1beta1/options/snapshots/SPY", {"feed": "indicative"})
    require_feed(f"{d}/v1beta1/news", None)
    for url, params in ((f"{d}/v2/stocks/bars", None), (f"{d}/v2/stocks/bars", {"symbols": "SPY"}),
                        (f"{d}/v2/stocks/bars", {"feed": ""}), (f"{d}/v2/stocks/bars", {"feed": "opra"}),
                        (f"{d}/v1beta1/options/snapshots/SPY", {"feed": "iex"})):
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
