"""Every Alpaca market-data request names its feed (B9, docs/runbooks/keys-and-feeds.md).

When a request leaves `feed` out, Alpaca uses "the best one the subscription allows": IEX on the free plan, SIP on a
paid one, IEX again if the subscription lapses. A request without a feed changes its data source with the plan, with
no code change and no record. `require_feed` refuses such a request before it is sent; `AlpacaREST.get` calls it on
every GET. Stock paths take one of Alpaca's stock feeds (this repo sends iex and sip); the option quote paths
(snapshots, latest) take indicative or opra. Option bars and trades, news and corporate actions have no feed
parameter and pass unchecked. It never chooses a feed: it only refuses a request that has none.

The modules that call Alpaca with their own HTTP session (wt.live.runner_o, wt.options.live,
wt.options.pipeline_check) are held to the same rule by tests/unit/test_feed_named.py, which scans the source.
"""
from __future__ import annotations

import re
from collections.abc import Mapping
from urllib.parse import urlsplit

DATA_HOST = "data.alpaca.markets"
STOCK_FEEDS = ("iex", "sip", "delayed_sip", "boats", "overnight", "otc")   # alpaca-py 0.44 DataFeed
OPTION_FEEDS = ("indicative", "opra")
_OPTION_QUOTES = re.compile(r"^/v1beta1/options/(snapshots|(quotes|trades|bars)/latest)")


class FeedNotNamed(ValueError):
    """A market-data request that does not name one of its path's feeds."""


def feeds_for(url: str) -> tuple[str, ...] | None:
    """The feeds a market-data URL takes, or None for a URL that takes none (another host, news, option bars)."""
    u = urlsplit(url)
    if (u.hostname or "").lower() != DATA_HOST:
        return None
    if u.path.startswith("/v2/stocks/"):
        return STOCK_FEEDS
    if _OPTION_QUOTES.match(u.path):
        return OPTION_FEEDS
    return None


def require_feed(url: str, params: Mapping[str, object] | None) -> None:
    """Raise FeedNotNamed when `url` takes a feed and `params` names none of its feeds."""
    feeds = feeds_for(url)
    if feeds is None:
        return
    feed = (params or {}).get("feed")
    if feed not in feeds:
        raise FeedNotNamed(f"an Alpaca data request must name its feed ({' or '.join(feeds)}): {urlsplit(url).path}")
