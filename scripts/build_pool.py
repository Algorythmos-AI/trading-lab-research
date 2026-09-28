"""Build the SPEC-0001 causal candidate pool (data/candidates/<date>.parquet) over a date range. Resumable.

Guards:
  D6  - pauses while US markets are in session (09:20-16:05 ET on trading days) so the paper runner keeps its API
        budget; uses the shared cross-process rate limiter
  D30 - aborts if free disk drops below 3 GB
Split factors (D2) are fetched lazily for symbols whose raw gap looks like a split. They are cached as change
points in data/daily/split_factors.parquet.

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
from wt.data.alpaca import AlpacaREST  # noqa: E402
from wt.data.corpactions import FACTORS, SplitFactors, factor_series  # noqa: E402
from wt.data.edgar import SharesOutstanding  # noqa: E402
from wt.data.universe import ASSETS, load_daily  # noqa: E402
from wt.scanner.features import PMCache, last_quotes  # noqa: E402
from wt.scanner.pool import POOL_DIR, DailyIndex, PoolConfig, build_day, save_day  # noqa: E402

MIN_FREE_GB = 3.0


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
    """Split-factor change points, fetched lazily and cached."""

    def __init__(self, a: AlpacaREST, daily_raw: pd.DataFrame):
        self.a, self.raw = a, daily_raw
        self.table = pd.read_parquet(FACTORS) if FACTORS.exists() else pd.DataFrame(columns=["symbol", "date", "f"])
        self.sf = SplitFactors(self.table)

    def refresh(self, symbols: list[str]) -> SplitFactors:
        need = sorted(set(symbols) - self.sf.symbols())
        if need:
            adj = self.a.bars(need, "1Day", "2018-06-01", (dt.date.today() - dt.timedelta(days=1)).isoformat(), adjustment="split")
            if len(adj):
                adj["date"] = adj.t.dt.tz_convert("America/New_York").dt.date
                f = factor_series(self.raw[self.raw.symbol.isin(need)], adj)
                f = f[(f.groupby("symbol").f.diff().fillna(1) != 0)]                 # change points only
                missing = sorted(set(need) - set(f.symbol))
                f = pd.concat([f, pd.DataFrame({"symbol": missing, "date": dt.date(2018, 6, 1), "f": 1.0})], ignore_index=True)
            else:
                f = pd.DataFrame({"symbol": need, "date": dt.date(2018, 6, 1), "f": 1.0})
            self.table = pd.concat([self.table, f], ignore_index=True)
            FACTORS.parent.mkdir(parents=True, exist_ok=True)
            self.table.to_parquet(FACTORS)
            self.sf = SplitFactors(self.table)
        return self.sf


def baseline_nonspread_pass(c: pd.DataFrame) -> pd.Series:
    """Frozen baseline (config/ranking.yaml) hard filters other than spread, for lazy NBBO lookups."""
    return (c.price_0925.between(2.0, 30.0) & (c.gap_pct >= 4.0) & (c.rvol_tod_base >= 2.0) &
            (c.pm_dollar_vol >= 1_000_000) & (c.float_shares.isna() | (c.float_shares <= 100_000_000)) &
            ~c.catalyst_type_v1.isin(["offering_dilution", "buyout_merger"]))


def main(start: str, end: str, per_minute: int, limit_days: int | None, min_free_gb: float = MIN_FREE_GB) -> None:
    a = AlpacaREST(per_minute=per_minute, shared=True)
    s, e = dt.date.fromisoformat(start), dt.date.fromisoformat(end)
    cal = a.calendar((s - dt.timedelta(days=60)).isoformat(), max(e, dt.date.today()).isoformat())
    sessions = sorted(cal.date)
    open_days = set(sessions)
    assets = pd.read_parquet(ASSETS)
    universe = set(assets[~assets.is_fund_like & ~assets.has_dot].symbol)
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
        i = sessions.index(d)
        p, prev_sessions = sessions[i - 1], sessions[max(0, i - 25): i]
        try:
            cands, pmb, st = build_day(d, p, a, daily, universe, splits.sf, cache, shares, prev_sessions, cfg,
                                       split_refresh=splits.refresh)
            if len(cands):
                mask = baseline_nonspread_pass(cands)
                q = last_quotes(a, sorted(cands[mask].symbol), d) if mask.any() else {}
                cands["spread_pct"] = [q.get(x, (float("nan"),) * 2)[0] for x in cands.symbol]
                cands["spread_abs"] = [q.get(x, (float("nan"),) * 2)[1] for x in cands.symbol]
            save_day(d, cands, pmb, st)
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
