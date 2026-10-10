"""What the bars and quotes behind one scan looked like, in counts and closed codes. Record only.

Nothing here changes which names a scan keeps, and nothing reads these to block a session or an entry: a rule
that acts on data quality needs its own decision record. The counts sit in `PoolStats` beside the scan's other
counts; the codes are derived from them.

Left out on purpose: "stale" and "missing" bars. A thin name legitimately prints no bar for minutes at a time,
so neither can be counted without a threshold, and a threshold is a rule.
"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any

BAR_KEYS = ("snap_bars", "snap_iex_bars", "snap_dup_bars", "snap_zero_vol_bars")
CODES = ("sip_fallback", "iex_bars", "duplicate_bars", "zero_volume_bars", "quotes_missing")


def bar_counts(bars: Any) -> dict[str, int]:
    """Counts over a frame of minute bars (symbol, t, v, and `src` when the hybrid feed built it)."""
    n = len(bars)
    if not n:
        return dict.fromkeys(BAR_KEYS, 0)
    cols = set(bars.columns)
    return {"snap_bars": n,
            "snap_iex_bars": int((bars["src"] == "iex").sum()) if "src" in cols else 0,
            "snap_dup_bars": int(bars.duplicated(["symbol", "t"]).sum()),
            "snap_zero_vol_bars": int((bars["v"] <= 0).sum()) if "v" in cols else 0}


def sip_fallback(bars: Any, feed: str) -> int:
    """1 when a hybrid scan read bars and none of them came from the consolidated tape: the whole window fell
    back to IEX (wt.data.alpaca.HybridFeed), so its volumes are one venue's."""
    if feed != "hybrid" or not len(bars) or "src" not in set(bars.columns):
        return 0
    return int(not bool((bars["src"] == "sip").any()))


def codes(stats: Mapping[str, Any]) -> list[str]:
    """The closed codes one scan's counts raise, in CODES order."""
    def n(k: str) -> int:
        v = stats.get(k)
        return int(v) if isinstance(v, int | float) and not isinstance(v, bool) else 0
    hit = {"sip_fallback": n("sip_fallback"), "iex_bars": n("snap_iex_bars"), "duplicate_bars": n("snap_dup_bars"),
           "zero_volume_bars": n("snap_zero_vol_bars"), "quotes_missing": n("quotes_missing")}
    return [c for c in CODES if hit[c] > 0]
