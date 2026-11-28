"""Every Alpaca market-data request names its feed (B9, docs/runbooks/keys-and-feeds.md).

When a request leaves `feed` out, Alpaca uses "the best one the subscription allows": IEX on the free plan, SIP on a
paid one, IEX again if the subscription lapses. A request without a feed changes its data source with the plan, with
no code change and no record. `require_feed` refuses such a request before it is sent; `AlpacaREST.get` calls it on
every GET. It never chooses a feed: it only refuses a request that names none, or names two different ones.

Which paths are checked: the stock bars, trades, quotes and snapshots (multi-symbol, per symbol, and latest), the
stock auctions (Alpaca's reference: "Only `sip` is valid for auctions"), and the option snapshots and latest quotes,
trades and bars. Other paths take no feed and pass unchecked: stock metadata (`/v2/stocks/meta/...`), option bars
and trades, news, corporate actions.

Which feeds are accepted: this repo sends sip for stocks and opra for options (DEC-0064); iex is paused. The accepted lists are wider: they are Alpaca's own values (alpaca-py 0.44's DataFeed and OptionsFeed),
so a hand-run tool that names another real feed is not refused. A feed may be in `params` (a mapping, a sequence of
pairs, or a query string, as `requests` accepts) or in the URL's query; if both name one, they must agree.

`require_feed` raises FeedNotNamed and nothing else: input it cannot read is refused when the URL is a data request
and passed through untouched otherwise. FeedPaused is a FeedNotNamed: a stock request that names a feed in
PAUSED_STOCK_FEEDS (DEC-0064) is refused the same way, and no caller falls back to another feed.

The modules that call Alpaca with their own HTTP session call it in their request helpers (wt.live.runner_o
AlpacaFeeds._get, wt.options.live OptionsAccount._get, wt.options.pipeline_check _alpaca_get), each turning a refusal
into its own failed-read error; tests/unit/test_feed_named.py also holds them to the rule by scanning the source.
"""
from __future__ import annotations

import re
from collections.abc import Mapping
from urllib.parse import parse_qsl, unquote, urlsplit

DATA_HOST = "data.alpaca.markets"
STOCK_FEEDS = ("iex", "sip", "delayed_sip", "boats", "overnight", "otc")     # Alpaca's; this repo sends sip
AUCTION_FEEDS = ("sip",)                                                     # Alpaca's reference: only sip
OPTION_FEEDS = ("indicative", "opra")                                        # Alpaca's; this repo sends opra
_STOCK_DATA = re.compile(r"^/v2/stocks/(?:(?:bars|trades|quotes)(?:/latest)?|snapshots"
                         r"|(?!meta/)[^/]+/(?:(?:bars|trades|quotes)(?:/latest)?|snapshot))/?$")
_AUCTIONS = re.compile(r"^/v2/stocks/(?:[^/]+/)?auctions/?$")
_OPTION_QUOTES = re.compile(r"^/v1beta1/options/(?:snapshots(?:/[^/]+)?|(?:quotes|trades|bars)/latest)/?$")


class FeedNotNamed(ValueError):
    """A market-data request that does not name one of its path's feeds."""


# DEC-0064: a stock feed listed here is paused. A request that names it is refused before it is sent, like one that
# names no feed, and nothing asks another feed instead. Switched on as the record's last step, once every consumer
# reads SIP; the way back is the owner's: empty it again, with a dated note in DEC-0064.
PAUSED_STOCK_FEEDS: tuple[str, ...] = ("iex",)


class FeedPaused(FeedNotNamed):
    """A stock-data request that names a paused feed. A FeedNotNamed, so every caller that turns a refusal into its
    own failed data read already handles it."""


def _text(v: object) -> str | None:
    if isinstance(v, str):
        return v
    if isinstance(v, (bytes, bytearray)):
        return bytes(v).decode("utf-8", "replace")
    return None


def _feeds_for_path(path: str) -> tuple[str, ...] | None:
    p = re.sub(r"/{2,}", "/", unquote(path)).lower()
    if _AUCTIONS.match(p):
        return AUCTION_FEEDS
    if _STOCK_DATA.match(p):
        return STOCK_FEEDS
    if _OPTION_QUOTES.match(p):
        return OPTION_FEEDS
    return None


def _split(url: object) -> tuple[str, str, str] | None:
    """(host, path, query), normalised, or None when the URL cannot be read."""
    text = _text(url)
    if text is None:
        return None
    try:
        u = urlsplit(text.strip())
        host = (u.hostname or "").rstrip(".").lower()
    except ValueError:
        return None
    return host, u.path, u.query


def _looks_like_data(url: object) -> bool:
    t = (_text(url) or "").lower()
    return DATA_HOST in t and ("/stocks/" in t or "/options/" in t)


def feeds_for(url: str) -> tuple[str, ...] | None:
    """The feeds a market-data URL takes, or None for a URL that takes none (another host, metadata, news, option
    bars) or one that cannot be read."""
    parts = _split(url)
    if parts is None or parts[0] != DATA_HOST:
        return None
    return _feeds_for_path(parts[1])


def _param_feeds(params: object) -> list[object] | None:
    """Every value given for `feed` in `params`, or None when `params` cannot be read."""
    if params is None:
        return []
    try:
        if isinstance(params, (str, bytes, bytearray)):
            pairs: list[tuple[object, object]] = list(parse_qsl(_text(params) or "", keep_blank_values=True))
        elif isinstance(params, Mapping):
            pairs = list(params.items())
        else:
            pairs = [(k, v) for k, v in params]          # type: ignore[attr-defined]
    except (TypeError, ValueError):
        return None
    out: list[object] = []
    for k, v in pairs:
        if _text(k) == "feed":
            out += list(v) if isinstance(v, (list, tuple)) else [v]
    return out


def require_feed(url: object, params: object) -> None:
    """Raise FeedNotNamed when `url` takes a feed and the request does not name exactly one of its feeds."""
    parts = _split(url)
    if parts is None:
        if _looks_like_data(url):
            raise FeedNotNamed("an Alpaca data request must name its feed: the URL cannot be read")
        return
    host, path, query = parts
    feeds = _feeds_for_path(path) if host == DATA_HOST else None
    if feeds is None:
        return
    given = _param_feeds(params)
    if given is None:
        raise FeedNotNamed(f"an Alpaca data request must name its feed: its params cannot be read: {path}")
    named: list[object] = [_text(v) if isinstance(v, (bytes, bytearray)) else v for v in given]
    named += [v for k, v in parse_qsl(query, keep_blank_values=True) if k == "feed"]
    plain = [str.__str__(v) if isinstance(v, str) else v for v in named]     # a str Enum by its value
    if not plain or any(v not in feeds for v in plain) or len({v for v in plain if isinstance(v, str)}) > 1:
        raise FeedNotNamed(f"an Alpaca data request must name its feed ({' or '.join(feeds)}): {path}")
    if feeds is not OPTION_FEEDS:
        paused = sorted({v for v in plain if isinstance(v, str)} & set(PAUSED_STOCK_FEEDS))
        if paused:
            raise FeedPaused(f"the {paused[0]} stock feed is paused (DEC-0064): {path}")
