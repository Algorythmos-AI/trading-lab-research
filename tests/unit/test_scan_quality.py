"""What a scan's bars and quotes looked like, in counts (wt.scanner.quality). Record only: nothing is kept or
dropped because of them."""
import datetime as dt
import importlib.util
from dataclasses import asdict
from pathlib import Path

import pandas as pd
import test_pool as tp

from wt.data.corpactions import SplitFactors
from wt.scanner import quality
from wt.scanner.pool import DailyIndex, PoolConfig, PoolStats, build_day

ROOT = Path(__file__).resolve().parents[2]
UNIVERSE = {"GAPR", "FLAT", "SPLT", "PENY"}


def build(client, cfg=None):
    sessions = [tp.P - dt.timedelta(days=k) for k in range(25, 0, -1)] + [tp.P]
    return build_day(tp.D, tp.P, client, DailyIndex(tp.daily_rows()), UNIVERSE,
                     SplitFactors(pd.DataFrame(columns=["symbol", "date", "f"])), tp.FakeCache(), tp.FakeShares(),
                     sessions, cfg or PoolConfig(), split_refresh=lambda syms: tp.split_factors())


class Tagged(tp.FakeClient):
    """The fake client with the hybrid feed's `src` column: `iex_from` on, bars are IEX-only; plus optional faults."""

    def __init__(self, iex_from="09:10", dup=False, zero=False):
        super().__init__()
        self.iex_from, self.dup, self.zero = iex_from, dup, zero

    def bars(self, symbols, timeframe, start, end, feed="sip", adjustment="raw"):
        b = super().bars(symbols, timeframe, start, end, feed, adjustment)
        b["src"] = ["iex" if t >= tp.ts(tp.D, self.iex_from) else "sip" for t in b.t]
        if self.zero:
            b.loc[b.symbol == "FLAT", "v"] = 0
        return pd.concat([b, b[b.symbol == "GAPR"].head(3)], ignore_index=True) if self.dup else b


def test_the_counts_describe_the_snapshot_and_change_no_candidate():
    plain, _, st0 = build(tp.FakeClient())
    assert (st0.snap_bars, st0.snap_iex_bars, st0.snap_dup_bars, st0.snap_zero_vol_bars, st0.sip_fallback) == (100, 0, 0, 0, 0)
    assert quality.codes(asdict(st0)) == []
    cands, _, st = build(Tagged(), PoolConfig(feed="hybrid"))                  # the same bars, tagged by venue
    assert st.snap_bars == 100 and st.snap_iex_bars == 4 * 15 and st.sip_fallback == 0      # 09:10-09:24, four names
    assert quality.codes(asdict(st)) == ["iex_bars"]
    pd.testing.assert_frame_equal(cands, plain)                                # the counts decide nothing
    pinned = ("universe", "snapshot_symbols", "kept", "in_band", "split_checked", "float_unknown")
    assert [getattr(st, k) for k in pinned] == [getattr(st0, k) for k in pinned]
    _, _, bad = build(Tagged(dup=True, zero=True), PoolConfig(feed="hybrid"))
    assert bad.snap_bars == 103 and bad.snap_dup_bars == 3 and bad.snap_zero_vol_bars == 25
    assert quality.codes(asdict(bad)) == ["iex_bars", "duplicate_bars", "zero_volume_bars"]


def test_a_hybrid_scan_with_no_consolidated_bar_is_a_fallback():
    _, _, st = build(Tagged(iex_from="04:00"), PoolConfig(feed="hybrid"))
    assert st.sip_fallback == 1 and st.snap_iex_bars == st.snap_bars == 100
    assert quality.codes(asdict(st))[0] == "sip_fallback"
    _, _, sip = build(Tagged(iex_from="04:00"))                                # not a hybrid scan: no fallback to speak of
    assert sip.sip_fallback == 0
    empty = pd.DataFrame(columns=["symbol", "t", "v", "src"])
    assert quality.sip_fallback(empty, "hybrid") == 0 and quality.bar_counts(empty) == dict.fromkeys(quality.BAR_KEYS, 0)


def test_the_counts_are_plain_ints_and_the_codes_are_a_closed_list():
    st = PoolStats(quotes_asked=5, quotes_missing=2, sip_fallback=1)
    assert quality.codes(asdict(st)) == ["sip_fallback", "quotes_missing"]
    assert all(type(v) is int for k, v in asdict(st).items() if k != "notes")
    assert quality.codes({"snap_iex_bars": None, "quotes_missing": True, "sip_fallback": "1"}) == []     # only numbers count
    assert set(quality.codes({k: 1 for k in ("sip_fallback", "snap_iex_bars", "snap_dup_bars", "snap_zero_vol_bars",
                                             "quotes_missing")})) == set(quality.CODES)


def test_the_batch_build_counts_the_quotes_it_did_not_get(monkeypatch):
    spec = importlib.util.spec_from_file_location("bp_q", ROOT / "scripts/build_pool.py")
    bp = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bp)
    cands = pd.DataFrame({"symbol": ["AAA", "BBB", "CCC"]})
    st, saved = PoolStats(universe=4300, snapshot_symbols=800, kept=3), []
    monkeypatch.setattr(bp, "build_day", lambda *a, **k: (cands, pd.DataFrame(), st))
    monkeypatch.setattr(bp, "baseline_nonspread_pass", lambda c: pd.Series([True, True, False]))
    monkeypatch.setattr(bp, "last_quotes", lambda a, syms, d: {"AAA": (0.5, 0.02)})
    monkeypatch.setattr(bp, "save_day", lambda *a: saved.append(a))
    from types import SimpleNamespace
    bp.build_one(None, tp.D, [tp.P, tp.D], None, set(), SimpleNamespace(sf=None), None, None, None)
    assert (st.quotes_asked, st.quotes_missing) == (2, 1) and len(saved) == 1


def test_the_snapshot_cut_is_0925_new_york_in_every_clock_change_week():
    """The scan's window is stated in New York time. The weeks where the US has changed its clocks and Sydney has
    not (or the reverse) are where a rule written on another clock would slip an hour."""
    from wt.core.clock import et, to_utc_iso
    from wt.signals.bars import et_minutes
    for day, utc in ((dt.date(2026, 3, 6), "14:25"), (dt.date(2026, 3, 9), "13:25"),      # US springs forward 8 March
                     (dt.date(2026, 10, 30), "13:25"), (dt.date(2026, 11, 2), "14:25")):  # and falls back 1 November
        iso = to_utc_iso(et(day, "09:25"))
        assert iso.startswith(f"{day}T{utc}"), (day, iso)
        assert et_minutes(pd.DataFrame({"t": [pd.Timestamp(iso)]})).tolist() == [9 * 60 + 25]
