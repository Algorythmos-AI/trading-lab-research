"""Historical 09:25 ET feature builder for the pre-market ranking engine.

Point-in-time rules:
  * Pre-market bars are 04:00-09:25 ET; Alpaca stamps bars with their START, so the last usable
    bar starts at 09:24 (complete at 09:25).
  * Float = SEC shares outstanding KNOWN on the date (edgar.SharesOutstanding.asof).
  * News window: prior day 16:00 ET -> 09:25 ET.
  * Recall prefilter (to limit API calls) uses the prior close and the day's OPEN gap >= 2%. The open is
    after 09:25, so this is only used to decide what to FETCH, never as a feature; recall loss is
    measured in EXP-0002 by scanning the full universe on sample days. It is still look-ahead in selection:
    a name gapping >= 4% at 09:25 that opened below +2% was never a candidate (DEC-0011 H-LA). The frozen
    backtests keep it; `causal=True` (the v2 forward trial) prefilters on the 09:25 pre-market gap instead.
"""
from __future__ import annotations

import datetime as dt
import os
import statistics
import time

import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

from wt.core.clock import et, to_utc_iso
from wt.core.config import DATA_DIR
from wt.data.alpaca import AlpacaREST
from wt.data.edgar import SharesOutstanding
from wt.ops.locks import job_lock
from wt.ops.safeio import atomic_replace, read_cache
from wt.scanner.catalyst import best_catalyst
from wt.scanner.ranking import Candidate

PM_CACHE = DATA_DIR / "pm" / "pm_agg.parquet"
PM_COLUMNS = ["symbol", "date", "pm_volume", "pm_dollar_vol", "last_0925", "pm_high", "n_bars"]
PM_LOCK = "pm-cache"
PM_LOCK_WAIT_S = 600.0


class PMCache:
    """(symbol, date) -> pre-market aggregates, persisted.

    `since`: hold only the rows dated `since` or later. The file has ~2.8M rows and a night needs ~25 sessions of
    them; asking a filtered cache about an earlier date raises instead of answering "missing".

    save() never writes the file from memory. Under the pm-cache lock it copies the file on disk row group by row
    group and appends only the rows the file lacks, so neither a filtered cache nor a concurrent writer can drop
    rows (the old save wrote this process's copy over the file)."""

    def __init__(self, since: dt.date | None = None):
        self.since = since
        filters = [("date", ">=", since)] if since is not None else None
        self.df = read_cache(PM_CACHE, lambda f: pd.read_parquet(f, filters=filters),
                             lambda: pd.DataFrame(columns=PM_COLUMNS))
        self._keys = pd.MultiIndex.from_arrays([self.df.symbol, self.df.date])
        self._new_keys: set[tuple[str, dt.date]] = set()
        self.new: list[dict] = []

    def _check(self, dates) -> None:
        if self.since is not None:
            early = sorted(d for d in set(dates) if d < self.since)
            if early:
                raise ValueError(f"PMCache(since={self.since}) holds no rows for {early[0]}")

    def _has(self, key: tuple[str, dt.date]) -> bool:
        return key in self._new_keys or key in self._keys

    def missing(self, symbols, dates):
        dates = list(dates)
        self._check(dates)
        want = pd.MultiIndex.from_product([list(symbols), dates]) if len(symbols) and dates else []
        if not len(want):
            return []
        have = ~want.isin(self._keys)
        return [k for k, h in zip(want, have, strict=True) if h and k not in self._new_keys]

    def add(self, rows: list[dict]):
        for r in rows:
            key = (r["symbol"], r["date"])
            if not self._has(key):
                self._new_keys.add(key)
                self.new.append(r)

    def get(self, symbols, dates) -> pd.DataFrame:
        dates = set(dates)
        self._check(dates)
        df = pd.concat([self.df, pd.DataFrame(self.new)], ignore_index=True) if self.new else self.df
        return df[df.symbol.isin(set(symbols)) & df.date.isin(dates)]

    def save(self):
        if not self.new:
            return
        new = pd.DataFrame(self.new, columns=PM_COLUMNS)
        with job_lock(PM_LOCK, wait_s=PM_LOCK_WAIT_S) as ok:
            if not ok:
                raise RuntimeError(f"the {PM_LOCK} lock stayed held for {PM_LOCK_WAIT_S:.0f}s; nothing saved")
            _append_missing(PM_CACHE, new)                    # the pool build and the forward test share it
        self.df = pd.concat([self.df, new], ignore_index=True) if len(self.df) else new
        self._keys = pd.MultiIndex.from_arrays([self.df.symbol, self.df.date])
        self._new_keys, self.new = set(), []


def _append_missing(path, new: pd.DataFrame) -> None:
    """Rewrite `path` atomically as its current rows plus the rows of `new` it lacks, one row group at a time."""
    try:
        pf = pq.ParquetFile(path) if path.exists() else None
    except Exception:  # noqa: BLE001 — torn file: set it aside, as read_cache does, and start from the new rows
        read_cache(path, pd.read_parquet, lambda: None)
        pf = None
    if pf is None:
        atomic_replace(path, lambda tmp: new.to_parquet(tmp, index=False))
        return
    disk = pq.read_table(path, columns=["symbol", "date"], filters=[("date", "in", sorted(set(new.date)))]).to_pandas()
    fresh = new[~pd.MultiIndex.from_arrays([new.symbol, new.date]).isin(pd.MultiIndex.from_arrays([disk.symbol, disk.date]))]
    if not len(fresh):
        return
    schema = pf.schema_arrow.remove_metadata()
    add = pa.Table.from_pandas(fresh, preserve_index=False).replace_schema_metadata(None).cast(schema)

    def write(tmp) -> None:
        with pq.ParquetWriter(tmp, schema) as w:
            for i in range(pf.num_row_groups):
                w.write_table(pf.read_row_group(i).replace_schema_metadata(None).cast(schema))
            w.write_table(add)

    atomic_replace(path, write)


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


def pm_prefilter(a: AlpacaREST, d: dt.date, p: dt.date, prev_close: pd.Series, min_gap: float,
                 split_refresh=None) -> pd.Series:
    """Causal recall prefilter: symbols whose last pre-market print up to 09:25 (bars 04:00-09:24, the window
    of last_0925, so the ranking's gap uses the same price) is >= min_gap % above the prior close. Returns their
    prior close. `split_refresh(symbols) -> SplitFactors`: prior closes are put on d's share basis, refreshing
    symbols whose raw 09:25 gap looks like a split (pool.SPLIT_CHECK_HI/LO), so a split on d is not a gap."""
    snap = a.bars(sorted(prev_close.index), "1Min", to_utc_iso(et(d, "04:00")), to_utc_iso(et(d, "09:24")), feed="sip")
    if not len(snap):
        return prev_close.iloc[:0]
    last = snap.sort_values("t").groupby("symbol").c.last()
    pc = prev_close.reindex(last.index)
    if split_refresh is not None:
        from wt.scanner.pool import SPLIT_CHECK_HI, SPLIT_CHECK_LO
        raw = last / pc - 1
        sf = split_refresh(sorted(raw[(raw >= SPLIT_CHECK_HI) | (raw <= SPLIT_CHECK_LO)].index))
        pc = pc * [sf.factor(s, d) / sf.factor(s, p) for s in pc.index]
    gap = 100 * (last / pc - 1)
    return pc[pc.between(1.5, 35) & (gap >= min_gap)]


def build_candidates(d: dt.date, daily: pd.DataFrame, sessions: list[dt.date], a: AlpacaREST,
                     cache: PMCache, so: SharesOutstanding, lookback: int = 20,
                     with_quotes: bool = True, prefilter_open_gap: float = 2.0,
                     quote_cfg: dict | None = None, causal: bool = False, split_refresh=None) -> list[Candidate]:
    """09:25 candidates for session d. causal=True prefilters on the 09:25 pre-market gap (pm_prefilter, with
    split-adjusted prior closes when split_refresh is given) instead of d's open."""
    i = sessions.index(d)
    prev_sessions = sessions[max(0, i - lookback): i]
    prev_day = sessions[i - 1]
    prev = daily[daily.date == prev_day].set_index("symbol")
    if causal:
        prev_close = pm_prefilter(a, d, prev_day, prev.c[prev.c.between(1.5, 35)], prefilter_open_gap, split_refresh)
    else:
        today = daily[daily.date == d].set_index("symbol")
        j = today.join(prev[["c"]].rename(columns={"c": "prev_close"}), how="inner")
        j = j[(j.prev_close.between(1.5, 35)) & (100 * (j.o / j.prev_close - 1) >= prefilter_open_gap)]
        prev_close = j.prev_close
    syms = sorted(prev_close.index)
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
        pre.append(Candidate(symbol=s, price=float(r.last_0925), gap_pct=100 * (r.last_0925 / prev_close[s] - 1),
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
