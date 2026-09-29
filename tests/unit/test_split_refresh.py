"""R-C2: split factors are re-fetched when they may be stale, so a split on a forward day is applied, not ranked as a
gap. Fake data client and a temporary factor table; no network."""
import datetime as dt
import importlib.util
import sys
from pathlib import Path

import pandas as pd

from wt.scanner import pool as pool_mod
from wt.scanner.pool import DailyIndex, PoolConfig

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
_spec = importlib.util.spec_from_file_location("build_pool", ROOT / "scripts/build_pool.py")
bp = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bp)

D, P = dt.date(2024, 3, 1), dt.date(2024, 2, 29)            # D: the forward day, a 1:10 reverse split for SPLT
DAYS = [P - dt.timedelta(days=k) for k in range(40, -1, -1)]
NY = "America/New_York"


def ts(day, hhmm):
    return pd.Timestamp(f"{day} {hhmm}", tz=NY).tz_convert("UTC")


def raw_daily():
    rows = []
    for s, px in (("SPLT", 0.30), ("GAPR", 4.0), ("FLAT", 10.0)):
        for day in DAYS:
            rows.append({"symbol": s, "date": day, "o": px, "h": px, "l": px, "c": px, "v": 1e6})
    for s, px in (("SPLT", 3.00), ("GAPR", 4.8), ("FLAT", 10.0)):  # the forward day is in the store (update_daily)
        rows.append({"symbol": s, "date": D, "o": px, "h": px, "l": px, "c": px, "v": 1e6})
    return pd.DataFrame(rows)


class Client:
    """Minute bars at 09:03 (SPLT 3.03 = +1% vs its split-adjusted close) and split-adjusted daily history."""

    def __init__(self):
        self.adj_calls = []

    def bars(self, symbols, timeframe, start, end, feed="sip", adjustment="raw"):
        if timeframe == "1Day":
            assert adjustment == "split"
            self.adj_calls.append(sorted(symbols))
            raw = raw_daily()
            raw = raw[raw.symbol.isin(symbols)].copy()
            raw.loc[(raw.symbol == "SPLT") & (raw.date < D), "c"] *= 10     # the vendor knows the split
            raw["t"] = [pd.Timestamp(str(x), tz=NY).tz_convert("UTC") for x in raw.date]
            return raw[["symbol", "t", "o", "h", "l", "c", "v"]]
        px = {"SPLT": 3.03, "GAPR": 4.8, "FLAT": 10.05}
        out = [{"symbol": s, "t": t, "o": px[s], "h": px[s], "l": px[s], "c": px[s], "v": 5000, "n": 1, "vw": px[s]}
               for s in symbols if s in px for t in pd.date_range(max(pd.Timestamp(start), ts(D, "04:00")),
                                                                  min(pd.Timestamp(end), ts(D, "09:24")), freq="3min")]
        return pd.DataFrame(out, columns=["symbol", "t", "o", "h", "l", "c", "v", "n", "vw"])

    def news(self, symbols, start, end):
        return []


class Cache:
    def missing(self, symbols, dates):
        return []

    def get(self, symbols, dates):
        return pd.DataFrame(columns=["symbol", "date", "pm_volume"])


class Shares:
    def asof(self, s, d):
        return 5e6


def old_table(with_column=True):
    """SPLT and FLAT were fetched a month before the forward day, when no split was known: f = 1 throughout."""
    t = pd.DataFrame({"symbol": ["SPLT", "FLAT"], "date": dt.date(2018, 6, 1), "f": 1.0})
    if with_column:
        t["fetched_through"] = P - dt.timedelta(days=30)
    return t


def store(tmp_path, monkeypatch, table, client=None):
    f = tmp_path / "split_factors.parquet"
    table.to_parquet(f)
    monkeypatch.setattr(bp, "FACTORS", f)
    return bp.SplitStore(client or Client(), raw_daily())


def build(tmp_path, monkeypatch, splits, refresh):
    monkeypatch.setattr(pool_mod, "POOL_DIR", tmp_path / "candidates")
    monkeypatch.setattr(pool_mod, "PM_BARS_DIR", tmp_path / "pm_bars")
    monkeypatch.setattr(bp, "last_quotes", lambda a, syms, d: {})
    sessions = DAYS + [D]
    cands, _, st = pool_mod.build_day(D, P, splits.a, DailyIndex(raw_daily()), {"SPLT", "GAPR", "FLAT"}, splits.sf,
                                      Cache(), Shares(), sessions[-25:-1], PoolConfig(), split_refresh=refresh)
    return (cands.set_index("symbol") if len(cands) else pd.DataFrame()), st


def test_a_reverse_split_on_a_forward_day_is_applied_not_ranked_as_a_gap(tmp_path, monkeypatch):
    stale = store(tmp_path, monkeypatch, old_table())
    before, _ = build(tmp_path, monkeypatch, stale, stale.refresh)                   # the old call: no session date
    assert before.loc["SPLT", "gap_pct"] > 900                                        # the defect: a fake +910% gap

    splits = store(tmp_path, monkeypatch, old_table())
    got, st = build(tmp_path, monkeypatch, splits, lambda syms: splits.refresh(syms, D, split_like=syms))
    assert st.split_checked == 1 and "SPLT" not in got.index                         # +1% after the split: no gap
    assert "GAPR" in got.index and abs(got.loc["GAPR", "gap_pct"] - 20.0) < 1e-9
    assert splits.a.adj_calls == [["SPLT"]]
    assert abs(splits.sf.adjusted_prev_close("SPLT", P, D, 0.30) - 3.00) < 1e-9


def test_build_one_passes_the_session_so_the_nightly_pool_refreshes(tmp_path, monkeypatch):
    splits = store(tmp_path, monkeypatch, old_table())
    monkeypatch.setattr(pool_mod, "POOL_DIR", tmp_path / "candidates")
    monkeypatch.setattr(pool_mod, "PM_BARS_DIR", tmp_path / "pm_bars")
    monkeypatch.setattr(bp, "last_quotes", lambda a, syms, d: {})
    bp.build_one(splits.a, D, DAYS + [D], DailyIndex(raw_daily()), {"SPLT", "GAPR", "FLAT"}, splits, Cache(), Shares(),
                 PoolConfig())
    saved = pd.read_parquet(tmp_path / "candidates" / f"{D}.parquet")
    assert set(saved.symbol) == {"GAPR"}


def test_a_legacy_table_without_the_column_counts_as_stale_and_is_upgraded(tmp_path, monkeypatch):
    splits = store(tmp_path, monkeypatch, old_table(with_column=False))
    splits.refresh(["SPLT"], D)                                   # split-like by the raw store scan (0.30 -> 3.00)
    assert splits.a.adj_calls == [["SPLT"]]
    saved = pd.read_parquet(bp.FACTORS)
    assert set(saved[saved.symbol == "SPLT"].fetched_through) == {D}           # through the store's last bar
    assert saved[saved.symbol == "FLAT"].fetched_through.isna().all()
    again = bp.SplitStore(Client(), raw_daily())
    again.refresh(["SPLT"], D)
    assert again.a.adj_calls == []                                # fresh for D: not fetched twice in a night
    assert abs(again.sf.factor("SPLT", P) - 0.1) < 1e-12 and again.sf.factor("SPLT", D) == 1.0


def test_historical_days_never_refetch_a_fresh_table(tmp_path, monkeypatch):
    t = old_table()
    t["fetched_through"] = D
    splits = store(tmp_path, monkeypatch, t)
    splits.refresh(["SPLT", "FLAT"], P, split_like=["SPLT"])
    splits.refresh(["SPLT", "FLAT"])                              # batch callers without a date: new symbols only
    assert splits.a.adj_calls == []


def test_stale_refetches_are_bounded_split_like_first_then_least_recent(tmp_path, monkeypatch):
    monkeypatch.setattr(bp, "MAX_REFETCH_STALE", 2)
    monkeypatch.setattr(bp, "MAX_REFETCH_SPLIT_LIKE", 1)
    syms = ["AAA", "BBB", "CCC", "DDD"]
    t = pd.DataFrame({"symbol": syms + ["SPLT"], "date": dt.date(2018, 6, 1), "f": 1.0,
                      "fetched_through": [P - dt.timedelta(days=k) for k in (5, 20, 10, 1)] + [P]})
    splits = store(tmp_path, monkeypatch, t)
    splits.refresh(syms + ["SPLT"], D)
    assert splits.a.adj_calls == [["BBB", "CCC", "SPLT"]]         # SPLT (split-like) + the two least recently fetched
    splits.refresh(syms + ["SPLT"], D)
    assert len(splits.a.adj_calls) == 1                           # the run's budget is spent: nothing more tonight


def test_the_raw_scan_flags_forward_and_reverse_splits_since_the_fetch():
    rows = []
    for s, before, after in (("FWD", 20.0, 10.0), ("REV", 0.2, 2.0), ("RUN", 5.0, 6.5), ("OLD", 20.0, 10.0)):
        for day in DAYS:
            px = after if (day >= P - dt.timedelta(days=3) if s != "OLD" else day >= P - dt.timedelta(days=35)) else before
            rows.append({"symbol": s, "date": day, "o": px, "h": px, "l": px, "c": px, "v": 1e6})
    t = pd.DataFrame({"symbol": ["FWD", "REV", "RUN", "OLD"], "date": dt.date(2018, 6, 1), "f": 1.0,
                      "fetched_through": [P - dt.timedelta(days=30)] * 4})
    s = bp.SplitStore.__new__(bp.SplitStore)
    s.raw, s.thru = pd.DataFrame(rows), dict(zip(t.symbol, t.fetched_through, strict=True))
    assert s.looks_split(["FWD", "REV", "RUN", "OLD"], P) == {"FWD", "REV"}    # RUN +30%; OLD split before the fetch
