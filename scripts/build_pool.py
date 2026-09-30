"""Build the SPEC-0001 causal candidate pool (data/candidates/<date>.parquet) over a date range. Resumable.

Guards:
  D6  - pauses while US markets are in session (09:20-16:05 ET on trading days) so the paper runner keeps its API
        budget; uses the shared cross-process rate limiter
  D30 - aborts if free disk drops below 3 GB
Split factors (D2) are fetched lazily for symbols whose raw gap looks like a split, and fetched again when a split
may have taken effect since (R-C2). They are cached as change points, with the date each symbol was fetched
through, in data/daily/split_factors.parquet.

Usage: PYTHONPATH=src .venv/bin/python scripts/build_pool.py 2019-01-02 2025-09-25 [--per-minute 170] [--limit-days N]
"""
from __future__ import annotations

import argparse
import datetime as dt
import shutil
import sys
import time
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from wt.core.clock import ET  # noqa: E402
from wt.core.config import DATA_DIR  # noqa: E402
from wt.data.alpaca import AlpacaREST, sip_safe_end  # noqa: E402
from wt.data.corpactions import FACTORS, SplitFactors, factor_series  # noqa: E402
from wt.data.edgar import SharesOutstanding  # noqa: E402
from wt.data.universe import ASSETS, TailMeta, load_daily, load_daily_symbols  # noqa: E402
from wt.scanner.features import PMCache, last_quotes  # noqa: E402
from wt.ops.safeio import atomic_replace  # noqa: E402
from wt.scanner.pool import (POOL_DIR, SPLIT_CHECK_HI, SPLIT_CHECK_LO, DailyIndex, PoolConfig,  # noqa: E402
                             build_day, save_day)

MIN_FREE_GB = 3.0
MAX_REFETCH_SPLIT_LIKE = 200     # per run; a day has a handful of split-like movers, so this only guards a pathology
MAX_REFETCH_STALE = 300          # per run; a full-history fetch costs ~40 requests per 200 symbols


def free_gb() -> float:
    return shutil.disk_usage(DATA_DIR).free / 1e9


def market_guard(open_days: set[dt.date]) -> None:
    """Block while the US session (with a margin) is running on a trading day."""
    while True:
        now = dt.datetime.now(ET)
        hm = now.hour * 60 + now.minute
        if now.date() in open_days and 9 * 60 + 20 <= hm < 16 * 60 + 5:
            wait = (16 * 60 + 5 - hm) * 60
            print(f"[guard] US session in progress ({now:%H:%M} ET); sleeping {wait // 60} min", flush=True)
            time.sleep(min(wait, 1800))
            continue
        return


class SplitStore:
    """Split-factor change points, fetched lazily and cached with the date each symbol was fetched through.

    SplitFactors.factor() returns the last known factor, so a split that takes effect after a symbol's fetch stays
    invisible until the symbol is fetched again: a reverse split on a forward day entered ranking as a fake gap
    (audit R-C2). refresh(symbols, d) therefore also re-fetches symbols whose `fetched_through` is before d. A table
    written before the column existed counts as stale. Symbols new to the table are always fetched.

    Bounded, so a large universe never stalls the nightly run: per run at most MAX_REFETCH_SPLIT_LIKE stale symbols
    whose raw move since their fetch looks like a split (the pool's own check, pool.SPLIT_CHECK_HI/LO: open or close
    >= +90% or <= -25% vs the prior close, which covers 3:2 and larger forward splits and 1:2 and larger reverse
    ones), then at most MAX_REFETCH_STALE others, least recently fetched first, so repeated nights rotate through
    them."""

    tail: TailMeta | None = None          # set when daily_raw is a load_daily_tail frame

    def __init__(self, a: AlpacaREST, daily_raw: pd.DataFrame, persist: bool = True, tail: TailMeta | None = None):
        self.a, self.raw, self.persist, self.tail = a, daily_raw, persist, tail
        self.table = pd.read_parquet(FACTORS) if FACTORS.exists() else pd.DataFrame(columns=["symbol", "date", "f"])
        if "fetched_through" not in self.table:
            self.table["fetched_through"] = None
        t = self.table
        self.thru = {s: pd.Timestamp(x).date() for s, x in zip(t.symbol, t.fetched_through, strict=True) if not pd.isna(x)}
        self.raw_through = daily_raw.date.max() if len(daily_raw) else None
        self.left = {"split_like": MAX_REFETCH_SPLIT_LIKE, "stale": MAX_REFETCH_STALE}
        self.sf = SplitFactors(self.table)

    def refresh(self, symbols, d: dt.date | None = None, split_like=None) -> SplitFactors:
        """Fetch factors for symbols new to the table; with d (the session being built) also re-fetch stale ones.
        `split_like`: symbols the caller already knows moved like a split (the pool's 09:25 check); default: scan
        the raw daily store."""
        symbols = set(symbols)
        todo = sorted(symbols - self.sf.symbols())
        stale = sorted(s for s in symbols - set(todo) if d is not None and not (s in self.thru and self.thru[s] >= d))
        if stale:
            like = set(split_like) if split_like is not None else self.looks_split(stale, d)
            for kind, group in (("split_like", [s for s in stale if s in like]),
                                ("stale", sorted((s for s in stale if s not in like),
                                                 key=lambda s: (self.thru.get(s, dt.date.min), s)))):
                take = group[: self.left[kind]]
                self.left[kind] -= len(take)
                todo += take
        if todo:
            self._fetch(todo)
        return self.sf

    def looks_split(self, symbols: list[str], d: dt.date) -> set[str]:
        """Symbols whose raw open or close moved like a split on a day after their fetch, up to d (the last 10
        calendar days when the fetch date is unknown)."""
        since = {s: self.thru.get(s, d - dt.timedelta(days=10)) for s in symbols}
        start = min(since.values()) - dt.timedelta(days=10)
        r = self.history(set(since), start + dt.timedelta(days=1))
        w = r[r.symbol.isin(set(since)) & (r.date > start) & (r.date <= d)]
        w = w.sort_values(["symbol", "date"])
        pc = w.groupby("symbol").c.shift(1)
        hi, lo = 1 + SPLIT_CHECK_HI, 1 + SPLIT_CHECK_LO
        jump = (w.o / pc >= hi) | (w.o / pc <= lo) | (w.c / pc >= hi) | (w.c / pc <= lo)
        after = w.date.to_numpy() > w.symbol.map(since).to_numpy()
        return set(w.symbol[jump.to_numpy() & after])

    def history(self, symbols: set[str], since: dt.date | None = None) -> pd.DataFrame:
        """These symbols' raw daily rows dated `since` or later (all of them when since is None). A tail-loaded store
        may have dropped older rows, and factors built from a shortened history would lose their earlier change
        points on disk; those symbols are read in full from the chunks instead."""
        if self.tail is not None and any(not self.tail.covers_symbol(s, since or dt.date.min) for s in symbols):
            return load_daily_symbols(symbols)
        return self.raw[self.raw.symbol.isin(symbols)]

    def _fetch(self, need: list[str]) -> None:
        end = sip_safe_end()
        thru = pd.Timestamp(end).tz_convert(ET).date()
        if self.raw_through is not None:            # factors exist only where the raw store has bars
            thru = min(thru, self.raw_through)
        adj = self.a.bars(need, "1Day", "2018-06-01", end, adjustment="split")
        f = pd.DataFrame(columns=["symbol", "date", "f"])
        if len(adj):
            adj["date"] = adj.t.dt.tz_convert("America/New_York").dt.date
            f = factor_series(self.history(set(need)), adj)
            f = f[(f.groupby("symbol").f.diff().fillna(1) != 0)]                 # change points only
        old = self.table[self.table.symbol.isin(set(need) - set(f.symbol))]      # nothing new: keep what was known
        missing = sorted(set(need) - set(f.symbol) - set(old.symbol))
        parts = [x for x in (f, old[["symbol", "date", "f"]],
                             pd.DataFrame({"symbol": missing, "date": dt.date(2018, 6, 1), "f": 1.0})) if len(x)]
        new = pd.concat(parts, ignore_index=True).assign(fetched_through=thru)
        kept = self.table[~self.table.symbol.isin(need)]
        self.table = pd.concat([kept, new], ignore_index=True) if len(kept) else new
        self.thru.update(dict.fromkeys(need, thru))
        if self.persist:                                   # the live routine never writes shared caches
            atomic_replace(FACTORS, self.table.to_parquet)
        self.sf = SplitFactors(self.table)


def baseline_nonspread_pass(c: pd.DataFrame) -> pd.Series:
    """Frozen baseline (config/ranking.yaml) hard filters other than spread, for lazy NBBO lookups."""
    return (c.price_0925.between(2.0, 30.0) & (c.gap_pct >= 4.0) & (c.rvol_tod_base >= 2.0) &
            (c.pm_dollar_vol >= 1_000_000) & (c.float_shares.isna() | (c.float_shares <= 100_000_000)) &
            ~c.catalyst_type_v1.isin(["offering_dilution", "buyout_merger"]))


def universe_symbols() -> set[str]:
    assets = pd.read_parquet(ASSETS)
    return set(assets[~assets.is_fund_like & ~assets.has_dot].symbol)


def build_one(a: AlpacaREST, d: dt.date, sessions: list[dt.date], daily: DailyIndex, universe: set[str],
              splits: SplitStore, cache: PMCache, shares: SharesOutstanding, cfg: PoolConfig):
    """Build and save the causal pool for one session (the batch build and the nightly forward test)."""
    i = sessions.index(d)
    p, prev_sessions = sessions[i - 1], sessions[max(0, i - 25): i]
    # build_day asks only about names whose 09:25 gap moved like a split, so each one is split-like
    cands, pmb, st = build_day(d, p, a, daily, universe, splits.sf, cache, shares, prev_sessions, cfg,
                               split_refresh=lambda syms: splits.refresh(syms, d, split_like=syms))
    if len(cands):
        mask = baseline_nonspread_pass(cands)
        q = last_quotes(a, sorted(cands[mask].symbol), d) if mask.any() else {}
        cands["spread_pct"] = [q.get(x, (float("nan"),) * 2)[0] for x in cands.symbol]
        cands["spread_abs"] = [q.get(x, (float("nan"),) * 2)[1] for x in cands.symbol]
    save_day(d, cands, pmb, st)
    return st


def main(start: str, end: str, per_minute: int, limit_days: int | None, min_free_gb: float = MIN_FREE_GB) -> None:
    a = AlpacaREST(per_minute=per_minute, shared=True)
    s, e = dt.date.fromisoformat(start), dt.date.fromisoformat(end)
    cal = a.calendar((s - dt.timedelta(days=60)).isoformat(), max(e, dt.date.today()).isoformat())
    sessions = sorted(cal.date)
    open_days = set(sessions)
    universe = universe_symbols()
    print("loading daily store ...", flush=True)
    raw = load_daily()
    daily = DailyIndex(raw)
    splits = SplitStore(a, raw)
    cache, shares, cfg = PMCache(), SharesOutstanding(), PoolConfig()
    todo = [d for d in sessions if s <= d <= e and not (POOL_DIR / f"{d}.parquet").exists()]
    if limit_days:
        todo = todo[:limit_days]
    print(f"{len(todo)} sessions to build", flush=True)
    t0 = time.time()
    for n, d in enumerate(todo, 1):
        if free_gb() < min_free_gb:
            print(f"[abort] free disk {free_gb():.1f} GB < {min_free_gb} GB", flush=True)
            break
        market_guard(open_days)
        try:
            st = build_one(a, d, sessions, daily, universe, splits, cache, shares, cfg)
        except Exception as ex:  # noqa: BLE001 — log and continue; the day is retried on the next run
            print(f"{d} FAILED {ex!r}", flush=True)
            continue
        if n % 10 == 0:
            cache.save()
            rate = (time.time() - t0) / n
            print(f"{n}/{len(todo)} ({d}) kept={st.kept} univ={st.universe}; {rate:.0f}s/day; "
                  f"ETA {(len(todo) - n) * rate / 3600:.1f}h; free {free_gb():.1f} GB", flush=True)
    cache.save()
    print("done", flush=True)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("start")
    ap.add_argument("end")
    ap.add_argument("--per-minute", type=int, default=170)
    ap.add_argument("--limit-days", type=int)
    ap.add_argument("--min-free-gb", type=float, default=MIN_FREE_GB)
    args = ap.parse_args()
    main(args.start, args.end, args.per_minute, args.limit_days, args.min_free_gb)
