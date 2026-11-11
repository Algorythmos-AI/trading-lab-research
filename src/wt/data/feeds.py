"""Every Alpaca market-data request names its feed (B9, docs/runbooks/keys-and-feeds.md).

When a request leaves `feed` out, Alpaca uses "the best one the subscription allows": IEX on the free plan, SIP on a
paid one, IEX again if the subscription lapses. A request without a feed changes its data source with the plan, with
no code change and no record. `require_feed` refuses such a request before it is sent; `AlpacaREST.get` calls it on
every GET. It never chooses a feed: it only refuses a request that names none.

Which paths are checked: the stock bars, trades, quotes and snapshots (multi-symbol, per symbol, and latest), and the
option snapshots and latest quotes, trades and bars. Other paths take no feed and pass unchecked: stock metadata
(`/v2/stocks/meta/...`) and auctions, option bars and trades, news, corporate actions.

Which feeds are accepted: this repo sends iex and sip for stocks, indicative (opra when the owner switches it) for
options. The accepted lists are wider: they are Alpaca's own values (alpaca-py 0.44's DataFeed and OptionsFeed),
so a hand-run tool that names another real feed is not refused. A feed may be in `params` or in the URL's query.

The modules that call Alpaca with their own HTTP session (wt.live.runner_o, wt.options.live,
wt.options.pipeline_check) do not call this yet: tests/unit/test_feed_named.py holds them to the rule by scanning the
source.
"""
from __future__ import annotations

import re
from collections.abc import Mapping
from urllib.parse import parse_qs, urlsplit

DATA_HOST = "data.alpaca.markets"
STOCK_FEEDS = ("iex", "sip", "delayed_sip", "boats", "overnight", "otc")     # Alpaca's; this repo sends iex, sip
OPTION_FEEDS = ("indicative", "opra")                                        # Alpaca's; this repo sends indicative
_STOCK_DATA = re.compile(r"^/v2/stocks/(?:(?:bars|trades|quotes)(?:/latest)?|snapshots"
                         r"|(?!meta/|auctions)[^/]+/(?:(?:bars|trades|quotes)(?:/latest)?|snapshot))/?$")
_OPTION_QUOTES = re.compile(r"^/v1beta1/options/(?:snapshots(?:/[^/]+)?|(?:quotes|trades|bars)/latest)/?$")


class FeedNotNamed(ValueError):
    """A market-data request that does not name one of its path's feeds."""


def feeds_for(url: str) -> tuple[str, ...] | None:
    """The feeds a market-data URL takes, or None for a URL that takes none (another host, metadata, news, option
    bars)."""
    u = urlsplit(url)
    if (u.hostname or "").lower() != DATA_HOST:
        return None
    if _STOCK_DATA.match(u.path):
        return STOCK_FEEDS
    if _OPTION_QUOTES.match(u.path):
        return OPTION_FEEDS
    return None


def require_feed(url: str, params: Mapping[str, object] | None) -> None:
    """Raise FeedNotNamed when `url` takes a feed and neither `params` nor the URL's query names one of its feeds."""
    feeds = feeds_for(url)
    if feeds is None:
        return
    given = (params or {}).get("feed")
    in_query = parse_qs(urlsplit(url).query).get("feed", [])
    if given not in feeds and not (given is None and any(f in feeds for f in in_query)):
        raise FeedNotNamed(f"an Alpaca data request must name its feed ({' or '.join(feeds)}): {urlsplit(url).path}")
