"""Causal daily candidate pool for SPEC-0001 (POOL-01..04; plan D1, D2, D3, D22, D27).

For day d, with prior session p:
  1. Snapshot: 1-minute SIP bars 09:00-09:24 for every listed common stock that traded on p. The last print is
     the 09:25 price. Nothing at or after 09:25 is used; the old builder chose what to fetch from d's 09:30 open.
  2. Gap vs the split-adjusted prior close. Raw gaps >= +90% or <= -25% may be split artefacts, so their split
     factors are checked (corpactions).
  3. Keep price $1-30 (the union of Set F $1-20 and the baseline $2-30) with an adjusted gap > 4% (baseline
     minimum; Set F applies > 5% later).
  4. For kept names:
     - pre-market bars 04:00-09:24, saved to data/pm_bars/<d>.parquet
     - RVOL baselines from the PM cache
     - point-in-time float
     - news up to 09:25, classified by v3 (spec) and v1 (baseline)
     - daily chart musts from split-adjusted history before d
     - NBBO spread 09:24-09:25 for baseline passers
  5. Save every kept candidate with every feature to data/candidates/<d>.parquet.
The data client is injected (`client` with .bars and .news), so the logic is testable offline.
"""
from __future__ import annotations

import datetime as dt
import statistics
from dataclasses import asdict, dataclass, field

import numpy as np
import pandas as pd

from wt.core.clock import et, to_utc_iso
from wt.core.config import DATA_DIR
from wt.data.corpactions import SplitFactors, suspect_split
from wt.data.universe import TailMeta, TailWindowExceeded
from wt.scanner.catalyst import best_catalyst, best_catalyst_spec
from wt.scanner.checklist import atr14, former_runner, overhead_levels, pm_consolidation, trend, window_ok
from wt.signals.bars import PM_OPEN, resample_clock
from wt.signals.patterns import pm_pattern

POOL_DIR = DATA_DIR / "candidates"
PM_BARS_DIR = DATA_DIR / "pm_bars"
SPLIT_CHECK_HI, SPLIT_CHECK_LO = 0.90, -0.25


class DailyIndex:
    """Raw daily bars indexed by symbol for fast point-in-time slicing.

    `tail`: the TailMeta of a load_daily_tail frame. Then a lookup that would need a row the tail load dropped raises
    TailWindowExceeded instead of answering from a shortened history. Days are grouped on first use, not all up
    front (a second full copy of the frame)."""

    def __init__(self, daily: pd.DataFrame, tail: TailMeta | None = None):
        self.tail = tail
        self.by_sym = {s: g.sort_values("date").reset_index(drop=True) for s, g in daily.groupby("symbol")}
        self._daily = daily
        self._by_date: dict[dt.date, pd.DataFrame] = {}

    def on(self, day: dt.date) -> pd.DataFrame:
        if self.tail is not None and not self.tail.covers(day):
            raise TailWindowExceeded(f"on({day}): the tail load holds every symbol only from {self.tail.complete_from}")
        if day not in self._by_date:
            g = self._daily[self._daily.date == day]
            self._by_date[day] = g.set_index("symbol") if len(g) else pd.DataFrame(columns=["o", "h", "l", "c", "v"])
        return self._by_date[day]

    def before(self, symbol: str, day: dt.date, n: int) -> pd.DataFrame:
        g = self.by_sym.get(symbol)
        if g is None:
            return pd.DataFrame(columns=["symbol", "date", "o", "h", "l", "c", "v"])
        i = int(np.searchsorted(g.date.to_numpy(), day, side="left"))
        if i < n and self.tail is not None and symbol in self.tail.first_kept:
            raise TailWindowExceeded(f"before({symbol}, {day}, {n}): only {i} kept rows precede {day}")
        return g.iloc[max(0, i - n): i]


SLICE_BAND = (2.0, 20.0)              # reported beside the registered bands as counts only; it selects nothing


@dataclass
class PoolConfig:
    price_band: tuple = (1.00, 30.00)
    gap_min_pct: float = 4.0
    prefilter_prev_close: tuple = (0.05, 1000.0)
    snapshot: tuple = ("09:00", "09:25")          # the routine uses (stage - 25 min, stage) with feed="iex"
    feed: str = "sip"
    rvol_lookback: int = 20
    daily_lookback: int = 300


@dataclass
class PoolStats:
    universe: int = 0
    snapshot_symbols: int = 0
    split_checked: int = 0
    kept: int = 0
    float_unknown: int = 0
    notes: list = field(default_factory=list)
    # Counts only, added for the funnel record (wt.scanner.explain). Plain ints: they travel as JSON numbers.
    in_band: int = 0                  # snapshot symbols priced inside cfg.price_band (before the gap floor)
    slice_snapshot: int = 0           # snapshot symbols priced inside SLICE_BAND
    slice_kept: int = 0               # kept names priced inside SLICE_BAND


def last_print(snap: pd.DataFrame) -> pd.Series:
    """symbol -> close of the last bar starting before 09:25 (bars are stamped at their start)."""
    if snap.empty:
        return pd.Series(dtype=float)
    return snap.sort_values("t").groupby("symbol").c.last()


def build_day(d: dt.date, p: dt.date, client, daily: "DailyIndex", universe: set[str], splits: SplitFactors,
              pm_cache, shares, prev_sessions: list[dt.date], cfg: PoolConfig = PoolConfig(),  # noqa: B008 — never mutated in build_day
              quotes=None, split_refresh=None) -> tuple[pd.DataFrame, pd.DataFrame, PoolStats]:
    """Returns (candidates, pm_bars, stats). `daily`: DailyIndex over raw daily bars (symbol, date, o, h, l, c, v).
    `pm_cache`: features.PMCache. `shares`: edgar.SharesOutstanding. `quotes(symbols, d)` -> {sym: (pct, abs)}.
    `split_refresh(symbols)`: fetches split factors for symbols, returning an updated SplitFactors."""
    st = PoolStats()
    prev = daily.on(p)
    prev = prev[prev.index.isin(universe)]
    prev = prev[prev.c.between(*cfg.prefilter_prev_close)]
    st.universe = len(prev)
    snap = client.bars(sorted(prev.index), "1Min", to_utc_iso(et(d, cfg.snapshot[0])), to_utc_iso(et(d, cfg.snapshot[1])),
                       feed=cfg.feed)
    snap = snap[snap.t < pd.Timestamp(et(d, cfg.snapshot[1]))] if len(snap) else snap
    px = last_print(snap)
    st.snapshot_symbols = len(px)
    st.slice_snapshot = int(px.between(*SLICE_BAND).sum())
    px = px[px.between(*cfg.price_band)]
    st.in_band = len(px)
    raw_gap = px / prev.c.reindex(px.index) - 1
    need = sorted(raw_gap[(raw_gap >= SPLIT_CHECK_HI) | (raw_gap <= SPLIT_CHECK_LO)].index)
    if need and split_refresh is not None:
        splits = split_refresh(need)
    st.split_checked = len(need)
    adj_prev = pd.Series({s: splits.adjusted_prev_close(s, p, d, float(prev.c[s])) for s in px.index}, dtype=float)
    gap = 100 * (px / adj_prev - 1)
    keep = sorted(gap[gap > cfg.gap_min_pct].index)
    st.kept = len(keep)
    st.slice_kept = sum(1 for s in keep if SLICE_BAND[0] <= float(px[s]) <= SLICE_BAND[1])
    if not keep:
        return pd.DataFrame(), pd.DataFrame(), st
    # ---- pre-market bars (full window) and RVOL baselines --------------------------------------------------
    cut = cfg.snapshot[1]
    pmb = client.bars(keep, "1Min", to_utc_iso(et(d, "04:00")), to_utc_iso(et(d, cut)), feed=cfg.feed)
    pmb = pmb[pmb.t < pd.Timestamp(et(d, cut))] if len(pmb) else pmb
    base_days = prev_sessions[-cfg.rvol_lookback:]
    from wt.scanner.features import fetch_pm
    fetch_pm(client, pm_cache, keep, base_days)
    base = pm_cache.get(keep, base_days)
    # ---- news ----------------------------------------------------------------------------------------------
    news = client.news(keep, to_utc_iso(et(p, "16:00")), to_utc_iso(et(d, cut)))
    heads: dict[str, list[tuple]] = {s: [] for s in keep}
    for n in news:
        for s in n.get("symbols", []):
            if s in heads and n.get("headline"):
                heads[s].append((n.get("created_at"), n["headline"]))
    rows = []
    for s in keep:
        g = pmb[pmb.symbol == s].sort_values("t").reset_index(drop=True) if len(pmb) else pd.DataFrame()
        pm_vol = float(g.v.sum()) if len(g) else 0.0
        pm_dv = float((g.c * g.v).sum()) if len(g) else 0.0
        b = base[base.symbol == s].pm_volume.tolist() if len(base) else []
        med = statistics.median(b) if b else 0.0
        mean = statistics.mean(b) if b else 0.0
        rvol_spec = pm_vol / max(med, 1000.0)                                    # K-22 (median, floor 1,000)
        rvol_base = pm_vol / max(med, mean, 1000.0)                             # frozen baseline definition
        hist = daily.before(s, d, cfg.daily_lookback)
        hadj = splits.adjust_asof(hist, d)
        tr_ = trend(hadj)
        atr = atr14(hadj)
        levels = overhead_levels(hadj)
        price = float(px[s])
        win_ok, room = window_ok(price, levels, atr)
        sus = suspect_split(hadj)
        fr = former_runner(hadj)
        pm5 = resample_clock(g, 5, anchor=PM_OPEN)[0] if len(g) else pd.DataFrame()
        pat = pm_pattern(pm5[["o", "h", "l", "c", "v"]].reset_index(drop=True), price) if len(pm5) >= 5 else None
        cons = pm_consolidation(g)
        hl = [h for _, h in heads[s]]
        st_s, cat_s, sc_s, ev_s = best_catalyst_spec(hl)
        runner_v1 = bool(len(hadj) > 1 and (hadj.c.pct_change().tail(90) >= 0.5).any())
        cat_v1, sc_v1, _ = best_catalyst(hl, runner_v1)
        fl = shares.asof(s, d)
        if fl is None:
            st.float_unknown += 1
        first_cat = min((t for t, h in heads[s] if best_catalyst_spec([h])[0] == "qualifying" and t), default=None)
        rows.append({
            "date": d, "symbol": s, "price_0925": price, "prev_close_raw": float(prev.c[s]),
            "prev_close_adj": float(adj_prev[s]), "gap_pct": float(gap[s]),
            "pm_volume": pm_vol, "pm_dollar_vol": pm_dv, "pm_high": float(g.h.max()) if len(g) else np.nan,
            "pm_low": float(g.l.min()) if len(g) else np.nan, "pm_bars": int(len(g)),
            "rvol_pm": rvol_spec, "rvol_tod_base": rvol_base, "float_shares": fl,
            "catalyst_status": st_s, "catalyst_category": cat_s, "catalyst_score": sc_s,
            "catalyst_headline": ev_s[0] if ev_s else None, "first_catalyst_at": first_cat,
            "catalyst_type_v1": cat_v1, "catalyst_score_v1": sc_v1, "headlines_n": len(hl),
            "trend_ok": bool(tr_.ok) if tr_ else False, "hist_bars": len(hadj),
            "atr14": atr, "window_ok": bool(win_ok), "window_room": room,
            "pm_consolidation": bool(cons), "pm_pattern": pat.kind if pat else None,
            "pm_pattern_trigger": pat.trigger if pat else np.nan, "pm_pattern_stop": pat.stop if pat else np.nan,
            "former_runner": bool(fr), "suspect_split": bool(sus),
            "overhead_levels": [x for x in levels if x > price][:20],
            "chart_ok": bool(tr_ is not None and tr_.ok and win_ok and cons and not sus),
            "spread_pct": np.nan, "spread_abs": np.nan,
        })
    cands = pd.DataFrame(rows)
    if quotes is not None and len(cands):
        q = quotes(sorted(cands.symbol), d)
        cands["spread_pct"] = [q.get(s, (np.nan, np.nan))[0] for s in cands.symbol]
        cands["spread_abs"] = [q.get(s, (np.nan, np.nan))[1] for s in cands.symbol]
    return cands, pmb, st


def save_day(d: dt.date, cands: pd.DataFrame, pmb: pd.DataFrame, stats: PoolStats) -> None:
    POOL_DIR.mkdir(parents=True, exist_ok=True)
    PM_BARS_DIR.mkdir(parents=True, exist_ok=True)
    out = cands.copy() if len(cands) else pd.DataFrame({"date": [], "symbol": []})
    out.attrs["stats"] = asdict(stats)
    out.to_parquet(POOL_DIR / f"{d}.parquet")
    if len(pmb):
        pmb[["symbol", "t", "o", "h", "l", "c", "v"]].to_parquet(PM_BARS_DIR / f"{d}.parquet")
