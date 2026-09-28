"""Point-in-time split handling (SPEC-0001 POOL-02, POOL-03, CHT-07; plan D2, D22).

The daily store is RAW (unadjusted). Alpaca also serves split-adjusted bars, adjusted with every split it
knows up to today. For each symbol-day, f(t) = raw_close(t) / split_adjusted_close(t). It is piecewise
constant and changes only across a split. History seen from day d is then comparable with raw prices on d:

    price_asof_d(t) = raw(t) * f(d) / f(t)          volume_asof_d(t) = raw_volume(t) * f(t) / f(d)

Example: a 1:10 reverse split effective on d, raw close 0.20 the day before and 2.00 on d. Then
f(prev) = 0.20 / 2.00 = 0.1 and f(d) = 1, so the prior close as of d = 0.20 * 1 / 0.1 = 2.00. No fake gap.

Splits Alpaca does not know about stay in the data. `suspect_split` flags them so that symbol-day fails
closed. A close-to-close ratio near a common split ratio, WITHOUT the dollar-volume surge a genuine news
move brings, is suspect. That way a real 200% runner is never mistaken for a split.
"""
from __future__ import annotations

import datetime as dt
from pathlib import Path

import numpy as np
import pandas as pd

from wt.core.config import DATA_DIR

FACTORS = DATA_DIR / "daily" / "split_factors.parquet"
COMMON_RATIOS = (1.5, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 35, 40, 50, 60, 75, 80, 100, 150, 200, 250)
_NOISE = 1e-4          # relative change in f below this is rounding, not a split


def factor_series(raw: pd.DataFrame, adj: pd.DataFrame) -> pd.DataFrame:
    """raw/adj: daily bars with columns symbol, date, c. Returns symbol, date, f (float), with rounding
    noise snapped so that f is exactly piecewise constant."""
    m = raw[["symbol", "date", "c"]].merge(adj[["symbol", "date", "c"]], on=["symbol", "date"], suffixes=("_raw", "_adj"))
    m = m[(m.c_raw > 0) & (m.c_adj > 0)].sort_values(["symbol", "date"]).reset_index(drop=True)
    m["f"] = m.c_raw / m.c_adj
    out = []
    for _, g in m.groupby("symbol", sort=False):
        f = g.f.to_numpy().copy()
        for i in range(1, len(f)):                       # snap: keep previous value unless a real change
            if abs(f[i] / f[i - 1] - 1) < _NOISE:
                f[i] = f[i - 1]
        out.append(pd.DataFrame({"symbol": g.symbol.to_numpy(), "date": g.date.to_numpy(), "f": f}))
    return pd.concat(out, ignore_index=True) if out else pd.DataFrame(columns=["symbol", "date", "f"])


class SplitFactors:
    """Lookup of f(symbol, date). A symbol or date missing from the table gets f = 1 (no known split)."""

    def __init__(self, table: pd.DataFrame | None = None, path: Path = FACTORS):
        if table is None:
            table = pd.read_parquet(path) if path.exists() else pd.DataFrame(columns=["symbol", "date", "f"])
        self._by_sym: dict[str, pd.Series] = {s: g.set_index("date").f.sort_index() for s, g in table.groupby("symbol")}

    def symbols(self) -> set[str]:
        return set(self._by_sym)

    def factor(self, symbol: str, d: dt.date) -> float:
        s = self._by_sym.get(symbol)
        if s is None or not len(s):
            return 1.0
        i = s.index.searchsorted(d, side="right") - 1        # last known factor on or before d
        return float(s.iloc[i]) if i >= 0 else float(s.iloc[0])

    def adjust_asof(self, hist: pd.DataFrame, d: dt.date) -> pd.DataFrame:
        """Rescale one symbol's raw daily history (columns date, o, h, l, c, v; any subset) to day d's share basis."""
        if hist.empty:
            return hist.copy()
        sym = hist["symbol"].iloc[0] if "symbol" in hist else None
        fd = self.factor(sym, d) if sym else 1.0
        ft = np.array([self.factor(sym, t) for t in hist["date"]]) if sym else np.ones(len(hist))
        k = fd / ft
        out = hist.copy()
        for col in ("o", "h", "l", "c", "vw"):
            if col in out:
                out[col] = out[col].to_numpy() * k
        if "v" in out:
            out["v"] = out["v"].to_numpy() / k
        return out

    def adjusted_prev_close(self, symbol: str, prev: dt.date, d: dt.date, raw_prev_close: float) -> float:
        return raw_prev_close * self.factor(symbol, d) / self.factor(symbol, prev)


def suspect_split(adj_hist: pd.DataFrame, lookback: int = 250, ratio_tol: float = 0.03,
                  min_ratio: float = 1.45, max_dollar_surge: float = 5.0) -> bool:
    """True if the (already split-adjusted) history shows a jump that looks like an unrecorded split:
    a close-to-close ratio within `ratio_tol` of a common split ratio (or its inverse), at least `min_ratio`,
    on a day whose dollar volume is below `max_dollar_surge` x the median of the prior 20 days."""
    h = adj_hist.tail(lookback + 1).reset_index(drop=True)
    if len(h) < 2:
        return False
    c = h.c.to_numpy(float)
    dv = (h.c * h.v).to_numpy(float)
    for i in range(1, len(h)):
        if c[i - 1] <= 0 or c[i] <= 0:
            continue
        r = c[i] / c[i - 1]
        big = max(r, 1 / r)
        if big < min_ratio:
            continue
        if min(abs(big / k - 1) for k in COMMON_RATIOS) > ratio_tol:
            continue
        base = np.median(dv[max(0, i - 20):i]) if i >= 1 else 0.0
        if base <= 0 or dv[i] / base < max_dollar_surge:
            return True
    return False
