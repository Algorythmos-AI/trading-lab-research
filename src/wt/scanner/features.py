"""Historical 09:25 ET feature builder for the pre-market ranking engine.

Point-in-time rules:
  * Pre-market bars are 04:00-09:25 ET; Alpaca stamps bars with their START, so the last usable
    bar starts at 09:24 (complete at 09:25).
  * Float = SEC shares outstanding KNOWN on the date (edgar.SharesOutstanding.asof).
  * News window: prior day 16:00 ET -> 09:25 ET.
  * Recall prefilter (to limit API calls) uses the prior close and the day's OPEN gap >= 2%. The open is
    after 09:25, so this is only used to decide what to FETCH, never as a feature; recall loss is
    measured in EXP-0002 by scanning the full universe on sample days.
"""
from __future__ import annotations

import datetime as dt
import os
import statistics
import time

import pandas as pd

from wt.core.clock import et, to_utc_iso
from wt.core.config import DATA_DIR
from wt.data.alpaca import AlpacaREST
from wt.data.edgar import SharesOutstanding
from wt.scanner.catalyst import best_catalyst
from wt.scanner.ranking import Candidate

PM_CACHE = DATA_DIR / "pm" / "pm_agg.parquet"


class PMCache:
    """(symbol, date) -> pre-market aggregates, persisted."""

    def __init__(self):
        self.df = pd.read_parquet(PM_CACHE) if PM_CACHE.exists() else pd.DataFrame(
            columns=["symbol", "date", "pm_volume", "pm_dollar_vol", "last_0925", "pm_high", "n_bars"])
        self.idx = {(s, d) for s, d in zip(self.df.symbol, self.df.date, strict=False)}
        self.new: list[dict] = []

    def missing(self, symbols, dates):
        return [(s, d) for s in symbols for d in dates if (s, d) not in self.idx]

    def add(self, rows: list[dict]):
        for r in rows:
            if (r["symbol"], r["date"]) not in self.idx:
                self.idx.add((r["symbol"], r["date"]))
                self.new.append(r)

    def get(self, symbols, dates) -> pd.DataFrame:
        df = pd.concat([self.df, pd.DataFrame(self.new)], ignore_index=True) if self.new else self.df
        return df[df.symbol.isin(set(symbols)) & df.date.isin(set(dates))]

    def save(self):
        if self.new:
            self.df = pd.concat([self.df, pd.DataFrame(self.new)], ignore_index=True)
            self.new = []
            PM_CACHE.parent.mkdir(parents=True, exist_ok=True)
            self.df.to_parquet(PM_CACHE)


def fetch_pm(a: AlpacaREST, cache: PMCache, symbols: list[str], dates: list[dt.date]) -> None:
    need = cache.missing(symbols, dates)
    if not need:
        return
    by_date: dict[dt.date, list[str]] = {}
    for s, d in need:
        by_date.setdefault(d, []).append(s)
    for d, syms in by_date.items():
        bars = a.bars(syms, "1Min", to_utc_iso(et(d, "04:00")), to_utc_iso(et(d, "09:24")), feed="sip")
        rows = []
        got = set()
        if len(bars):
            bars["dollar"] = bars["c"] * bars["v"]
            for s, g in bars.groupby("symbol"):
                g = g.sort_values("t")
                rows.append({"symbol": s, "date": d, "pm_volume": float(g.v.sum()), "pm_dollar_vol": float(g.dollar.sum()),
                             "last_0925": float(g.c.iloc[-1]), "pm_high": float(g.h.max()), "n_bars": int(len(g))})
                got.add(s)
        rows += [{"symbol": s, "date": d, "pm_volume": 0.0, "pm_dollar_vol": 0.0, "last_0925": float("nan"),
                  "pm_high": float("nan"), "n_bars": 0} for s in syms if s not in got]
        cache.add(rows)


def last_quotes(a: AlpacaREST, symbols: list[str], d: dt.date) -> dict[str, tuple[float, float]]:
    """Last NBBO quote in 09:24:00-09:25:00 ET per symbol -> (spread_pct, spread_abs)."""
    out = {}
    for s in symbols:
        try:
            j = a.get("https://data.alpaca.markets/v2/stocks/quotes",
                      {"symbols": s, "start": to_utc_iso(et(d, "09:24")), "end": to_utc_iso(et(d, "09:25")),
                       "feed": "sip", "limit": 1000}, tries=3)
        except Exception:  # noqa: BLE001 — fail soft: unknown spread -> neutral sub-score, logged by caller
            continue
        q = (j.get("quotes") or {}).get(s) or []
        q = [x for x in q if x.get("bp", 0) > 0 and x.get("ap", 0) > 0 and x["ap"] >= x["bp"]]
        if q:
            b, ask = q[-1]["bp"], q[-1]["ap"]
            mid = (b + ask) / 2
            out[s] = (100 * (ask - b) / mid, ask - b)
    return out


def build_candidates(d: dt.date, daily: pd.DataFrame, sessions: list[dt.date], a: AlpacaREST,
                     cache: PMCache, so: SharesOutstanding, lookback: int = 20,
                     with_quotes: bool = True, prefilter_open_gap: float = 2.0,
                     quote_cfg: dict | None = None) -> list[Candidate]:
    i = sessions.index(d)
    prev_sessions = sessions[max(0, i - lookback): i]
    prev_day = sessions[i - 1]
    today = daily[daily.date == d].set_index("symbol")
    prev = daily[daily.date == prev_day].set_index("symbol")
    j = today.join(prev[["c"]].rename(columns={"c": "prev_close"}), how="inner")
    j = j[(j.prev_close.between(1.5, 35)) & (100 * (j.o / j.prev_close - 1) >= prefilter_open_gap)]
    syms = sorted(j.index)
    if not syms:
        return []
    dbg = os.environ.get("WT_DEBUG")
    t0 = time.time()
    fetch_pm(a, cache, syms, prev_sessions + [d])
    if dbg:
        print(f"    [{d}] prefilter {len(syms)} syms; fetch_pm {time.time() - t0:.1f}s", flush=True)
    pm = cache.get(syms, prev_sessions + [d])
    pm_today = pm[pm.date == d].set_index("symbol")
    base = pm[pm.date != d].groupby("symbol").pm_volume.apply(list)
    hist = daily[(daily.date < d) & (daily.date >= sessions[max(0, i - 90)]) & daily.symbol.isin(syms)].sort_values(["symbol", "date"])
    hist["ret"] = hist.groupby("symbol").c.pct_change()
    runners = set(hist[hist.ret >= 0.5].symbol)
    t1 = time.time()
    news = a.news(syms, to_utc_iso(et(prev_day, "16:00")), to_utc_iso(et(d, "09:25")))
    if dbg:
        print(f"    [{d}] news {len(news)} items {time.time() - t1:.1f}s", flush=True)
    heads: dict[str, list[str]] = {}
    for n in news:
        for s in n.get("symbols", []):
            if s in syms:
                heads.setdefault(s, []).append(n["headline"])
    pre: list[Candidate] = []
    for s in syms:
        if s not in pm_today.index or pm_today.loc[s, "n_bars"] == 0:
            continue
        r = pm_today.loc[s]
        b = base.get(s, [])
        # baseline floor: many small caps have ~0 pre-market volume on normal days, which makes the ratio
        # explode; floor the denominator at 1,000 shares (score saturates at 10x anyway)
        base_vol = max(statistics.median(b) if b else 0.0, statistics.mean(b) if b else 0.0, 1000.0)
        rvol = r.pm_volume / base_vol
        typ, sc, hl = best_catalyst(heads.get(s, []), s in runners)
        pre.append(Candidate(symbol=s, price=float(r.last_0925), gap_pct=100 * (r.last_0925 / j.loc[s, "prev_close"] - 1),
                             rvol_tod=float(rvol), pm_dollar_vol=float(r.pm_dollar_vol), spread_pct=None,
                             spread_abs=None, float_shares=so.asof(s, d), pm_volume=float(r.pm_volume),
                             catalyst_type=typ, catalyst_score=sc, headlines=hl))
    if with_quotes:
        # lazy quotes: only symbols that pass every non-spread hard filter need an NBBO lookup (API cost)
        from wt.core.config import load_yaml
        from wt.scanner.ranking import hard_filter
        cfg = quote_cfg or load_yaml("ranking.yaml")
        need = [c.symbol for c in pre if not [w for w in hard_filter(c, cfg) if not w.startswith("spread")]]
        t2 = time.time()
        q = last_quotes(a, need, d)
        if dbg:
            print(f"    [{d}] quotes {len(need)} syms {time.time() - t2:.1f}s", flush=True)
        for c in pre:
            if c.symbol in q:
                c.spread_pct, c.spread_abs = q[c.symbol]
    return pre
