"""load_daily_tail: identical to load_daily() cut to each symbol's last rows, without holding the whole store, and every
lookup the cut could change raises instead of answering from a shortened history. Temporary chunk store, offline."""
import datetime as dt
import importlib.util
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from wt.data import universe
from wt.data.universe import TailWindowExceeded
from wt.scanner.pool import DailyIndex

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
_spec = importlib.util.spec_from_file_location("build_pool", ROOT / "scripts/build_pool.py")
bp = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bp)

SESSIONS = [d.date() for d in pd.bdate_range("2025-01-02", periods=80)]


def bars(sym, days, c0=10.0, step=0.1):
    t = [pd.Timestamp(f"{d} 05:00", tz="UTC") for d in days]
    c = [c0 + step * i for i in range(len(days))]
    return pd.DataFrame({"symbol": sym, "t": t, "o": c, "h": c, "l": c, "c": c, "v": 1000, "n": 1, "vw": c})


@pytest.fixture
def store(tmp_path, monkeypatch):
    """Base chunks with disjoint and overlapping symbols, a halted name, a new listing, a dead one, duplicate rows in one
    file, and update chunks that repeat sessions a base chunk also holds (the base wins) or each other (the later wins)."""
    chunks = tmp_path / "chunks"
    chunks.mkdir()
    monkeypatch.setattr(universe, "DAILY", tmp_path / "daily.parquet")
    s = SESSIONS
    halted = s[:30] + s[55:70]                                       # a 25-session halt
    pd.concat([bars("AAA", s[:75]), bars("SPY", s[:75], 500), bars("HALT", halted, 3.0),
               bars("AAA", s[70:71], 99.0)]).to_parquet(chunks / "chunk_00000.parquet")   # in-file duplicate: last wins
    pd.concat([bars("BBB", s[:75], 20), bars("NEWL", s[60:75], 7.0), bars("DEAD", s[:20], 1.0),
               bars("QQQ", s[:75], 400)]).to_parquet(chunks / "chunk_00200.parquet")
    bars("BBB", s[10:40], 21.0).to_parquet(chunks / "chunk_09999.parquet")    # a later base rebuild of part of BBB
    pd.concat([bars(x, s[74:76], 1000) for x in ("AAA", "BBB", "SPY", "QQQ", "NEWL")]).to_parquet(
        chunks / f"chunk_zupd_{s[75]}.parquet")                    # repeats s[74] (base wins) and adds s[75]
    pd.concat([bars(x, s[75:77], 2000) for x in ("AAA", "BBB", "SPY", "QQQ", "NEWL")]).to_parquet(
        chunks / f"chunk_zupd_{s[76]}.parquet")                    # a later update: wins s[75] over the earlier one
    return chunks


@pytest.mark.parametrize("rows", [1, 5, 20, 30, 45, 76, 200])
def test_tail_equals_full_load_cut_per_symbol(store, rows):
    full = universe.load_daily()
    want = full.groupby("symbol", sort=False).tail(rows).reset_index(drop=True)
    got, meta = universe.load_daily_tail(rows)
    pd.testing.assert_frame_equal(got, want)
    assert meta.data_end == full.date.max()
    counts = full.groupby("symbol").size()
    assert set(meta.first_kept) == set(counts[counts > rows].index)
    for s, first in meta.first_kept.items():
        assert first == want[want.symbol == s].date.min()


def test_merge_rules_survive_the_per_file_cut(store):
    got, _ = universe.load_daily_tail(3)
    c = got.set_index(["symbol", "date"]).c
    s = SESSIONS
    assert c[("AAA", s[74])] == pytest.approx(10.0 + 0.1 * 74)      # the base copy beats the update chunk
    assert c[("AAA", s[75])] == 2000                                 # the later update chunk beats the earlier one
    assert not got.duplicated(["symbol", "date"]).any()
    full = universe.load_daily()
    assert full.set_index(["symbol", "date"]).c[("AAA", s[70])] == 99.0   # in-file duplicate: last row wins


def test_symbols_history_matches_the_full_load(store):
    full = universe.load_daily()
    want = full[full.symbol.isin({"BBB", "HALT"})].reset_index(drop=True)
    pd.testing.assert_frame_equal(universe.load_daily_symbols(["HALT", "BBB"]), want)
    assert universe.load_daily_symbols([]).empty


def test_sessions_since_counts_store_sessions(store):
    assert universe.sessions_since(SESSIONS[76]) == 1
    assert universe.sessions_since(SESSIONS[70]) == 7
    assert universe.tail_rows_for(SESSIONS[70], 20, margin=5) == 20 + 7 + 5


def test_daily_index_on_a_tail_is_exact_or_raises(store):
    full = universe.load_daily()
    raw, meta = universe.load_daily_tail(30)
    tail, whole = DailyIndex(raw, meta), DailyIndex(full)
    for d in SESSIONS:
        if meta.covers(d):
            pd.testing.assert_frame_equal(tail.on(d), whole.on(d))
        else:
            with pytest.raises(TailWindowExceeded):
                tail.on(d)
    exact = raised = 0
    for s in full.symbol.unique():
        for d in SESSIONS + [SESSIONS[-1] + dt.timedelta(days=1)]:
            for n in (1, 10, 20, 29):
                try:
                    got = tail.before(s, d, n)
                except TailWindowExceeded:
                    raised += 1
                    continue
                pd.testing.assert_frame_equal(got.reset_index(drop=True), whole.before(s, d, n).reset_index(drop=True))
                exact += 1
    assert exact and raised                     # both paths ran; no lookup ever returned a shortened history


def test_daily_index_without_tail_is_unchanged(store):
    full = universe.load_daily()
    ix = DailyIndex(full)
    assert ix.on(SESSIONS[0] - dt.timedelta(days=3)).empty
    assert len(ix.before("AAA", SESSIONS[0], 5)) == 0
    assert list(ix.on(SESSIONS[74]).index) == sorted(full[full.date == SESSIONS[74]].symbol)


class AdjClient:
    """Split-adjusted daily bars: BBB split 2:1 on SESSIONS[5], long before a 20-row tail starts."""

    def bars(self, symbols, timeframe, start, end, adjustment="raw", **_):
        full = universe.load_daily()
        x = full[full.symbol.isin(symbols)].copy()
        x.loc[(x.symbol == "BBB") & (x.date < SESSIONS[5]), "c"] /= 2
        x["t"] = [pd.Timestamp(str(d), tz="America/New_York").tz_convert("UTC") for d in x.date]
        return x[["symbol", "t", "o", "h", "l", "c", "v"]]


def test_split_store_on_a_tail_keeps_every_change_point(store, tmp_path, monkeypatch):
    monkeypatch.setattr(bp, "FACTORS", tmp_path / "split_factors.parquet")
    monkeypatch.setattr(bp, "sip_safe_end", lambda: "2025-06-01T00:00:00Z")
    full = universe.load_daily()
    raw, meta = universe.load_daily_tail(20)
    assert "BBB" in meta.first_kept and meta.first_kept["BBB"] > SESSIONS[5]
    whole = bp.SplitStore(AdjClient(), full, persist=False)
    tail = bp.SplitStore(AdjClient(), raw, persist=False, tail=meta)
    whole.refresh(["BBB", "AAA"])
    tail.refresh(["BBB", "AAA"])
    cols = ["symbol", "date", "f"]
    pd.testing.assert_frame_equal(tail.table[cols].reset_index(drop=True), whole.table[cols].reset_index(drop=True))
    assert tail.sf.factor("BBB", SESSIONS[0]) == pytest.approx(2.0)       # the pre-window split is still known
    assert tail.sf.factor("BBB", SESSIONS[50]) == pytest.approx(1.0)


def test_split_store_looks_split_matches_full_history(store):
    full = universe.load_daily()
    raw, meta = universe.load_daily_tail(20)
    whole = bp.SplitStore(AdjClient(), full, persist=False)
    tail = bp.SplitStore(AdjClient(), raw, persist=False, tail=meta)
    for thru in (SESSIONS[2], SESSIONS[60]):
        whole.thru = dict.fromkeys(["AAA", "BBB", "HALT"], thru)
        tail.thru = dict(whole.thru)
        d = SESSIONS[76]
        assert tail.looks_split(["AAA", "BBB", "HALT"], d) == whole.looks_split(["AAA", "BBB", "HALT"], d)


def test_tail_memory_is_bounded_by_one_file_plus_the_kept_rows(store):
    raw, meta = universe.load_daily_tail(5)
    assert raw.groupby("symbol").size().max() == 5
    assert np.all(raw.groupby("symbol").date.is_monotonic_increasing)
    assert meta.rows == 5


def _forward():
    spec = importlib.util.spec_from_file_location("forward_test", ROOT / "scripts/forward_test.py")
    ft = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(ft)
    return ft


def test_forward_loads_a_tail_sized_for_its_oldest_session(store, monkeypatch):
    ft = _forward()
    ctx = ft.Context(None, SESSIONS, {}, oldest=SESSIONS[70])
    assert ctx.tail is not None and ctx.tail.rows == ft.TAIL_LOOKBACK + 7 + universe.TAIL_MARGIN
    assert ctx.daily.tail is ctx.tail and ctx.splits.tail is ctx.tail
    monkeypatch.setenv("WT_DAILY_FULL", "1")
    full = ft.Context(None, SESSIONS, {}, oldest=SESSIONS[70])
    assert full.tail is None and len(full.raw) == len(universe.load_daily())


def test_forward_watchlist_refuses_a_tail_that_misses_its_window(store):
    ft = _forward()
    raw, meta = universe.load_daily_tail(20)
    with pytest.raises(TailWindowExceeded):
        ft.run_watchlist_flag(None, SESSIONS[76], SESSIONS, raw, None, meta)
