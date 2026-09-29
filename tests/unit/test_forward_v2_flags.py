"""DEC-0011 H-LA: the two legacy bull flags run as v2 without look-ahead, under new ledger keys.

HOD v1 fetched only names whose FULL-DAY volume reached 1M; the watchlist v1 prefiltered on d's 09:30 open gap. v2
decides from data available at decision time. Synthetic bars and fake clients only."""
import datetime as dt
import importlib.util
import sys
import types
from pathlib import Path

import numpy as np
import pandas as pd

from wt.data.corpactions import SplitFactors
from wt.scanner import features
from wt.scanner.pool import DailyIndex

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
_spec = importlib.util.spec_from_file_location("forward_test", ROOT / "scripts/forward_test.py")
ft = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ft)

D, P = dt.date(2024, 3, 1), dt.date(2024, 2, 29)
NY = "America/New_York"
CURVE = np.linspace(1 / 390, 1.0, 390)                          # expected cumulative share of the day's volume


def rth(closes, vols, day=D):
    t = pd.date_range(pd.Timestamp(f"{day} 09:30", tz=NY).tz_convert("UTC"), periods=len(closes), freq="1min")
    c = np.asarray(closes, float)
    return pd.DataFrame({"t": t, "o": c, "h": c * 1.001, "l": c * 0.999, "c": c, "v": np.asarray(vols, float)})


# ---------------------------------------------------------------- HOD: cumulative volume by the decision bar
def v1_qualify(b, pc, adv, f_t):
    """The v1 trigger, which relied on the full-day volume filter instead of volume by the decision bar."""
    cum = np.cumsum(b.v.to_numpy())
    return next((i for i in range(15, min(120, len(b) - 1)) if b.c.iloc[i] >= 1.10 * pc and 2 <= b.c.iloc[i] <= 30
                 and cum[i] / max(1.0, adv * f_t[min(i, len(f_t) - 1)]) >= 5), None)


def test_hod_v2_needs_1m_shares_by_the_decision_bar_not_by_the_close():
    closes = [5.0] * 15 + [5.6] * 375                             # +12% from 09:45 on
    vols = [4_000] * 200 + [20_000] * 190                          # 800k by 12:50, 4.6M by the close: full day >= 1M
    b = rth(closes, vols)
    assert b.v.sum() >= 1_000_000 and np.cumsum(vols)[119] < 1_000_000
    assert v1_qualify(b, 5.0, 10_000, CURVE) == 15               # v1: qualified at 09:45 on the day's final volume
    assert ft.hod_qualify(b, 5.0, 10_000, CURVE) is None           # v2: never 1M shares inside 09:45-11:30


def test_hod_v2_qualifies_when_volume_arrives_in_time_and_ignores_later_bars():
    closes = [5.0] * 15 + [5.6] * 375
    vols = [4_000] * 40 + [60_000] * 350                           # 1M shares reached at 10:23
    b = rth(closes, vols)
    q = ft.hod_qualify(b, 5.0, 10_000, CURVE)
    assert q == int(np.argmax(np.cumsum(vols) >= 1_000_000)) == 53
    later = b.copy()
    later.loc[q + 1:, "v"] = 0.0                                   # the rest of the day never happens
    later.loc[q + 1:, "c"] = 1.0
    assert ft.hod_qualify(later, 5.0, 10_000, CURVE) == q


class FakeSplits:
    def __init__(self, table):
        self.sf, self.asked = SplitFactors(table), []

    def refresh(self, symbols, d=None, split_like=None):
        self.asked.append((sorted(symbols), d, sorted(split_like or [])))
        return self.sf


def daily_frame():
    days = [P - dt.timedelta(days=k) for k in range(24, -1, -1)]
    rows = []
    for s, before, today, v in (("REV", 0.30, (3.0, 3.5, 3.4), 2e6),      # 1:10 reverse split on D, +17% on the new basis
                                ("FWD", 20.0, (10.0, 11.5, 11.2), 2e6),   # 2:1 forward split on D, +15%
                                ("RUN", 4.0, (4.2, 4.8, 4.6), 2e6),       # plain +20% runner
                                ("THIN", 4.0, (4.2, 4.8, 4.6), 9e5),      # day volume < 1M: cannot reach 1M by any bar
                                ("NEW", 4.0, (4.2, 4.8, 4.6), 2e6)):      # listed 5 days ago: no 20-day history
        for day in days[-5:] if s == "NEW" else days:
            rows.append({"symbol": s, "date": day, "o": before, "h": before, "l": before, "c": before, "v": 1e5})
        o, h, c = today
        rows.append({"symbol": s, "date": D, "o": o, "h": h, "l": o, "c": c, "v": v})
    return pd.DataFrame(rows)


def test_hod_superset_is_split_adjusted_and_needs_history():
    splits = FakeSplits(pd.DataFrame({"symbol": ["REV", "REV", "FWD", "FWD"], "date": [dt.date(2024, 1, 1), D] * 2,
                                      "f": [0.1, 1.0, 2.0, 1.0]}))
    g = ft.hod_superset(DailyIndex(daily_frame()), D, splits)
    assert sorted(g.index) == ["FWD", "REV", "RUN"]
    assert abs(g.loc["REV", "pc"] - 3.0) < 1e-9 and abs(g.loc["FWD", "pc"] - 10.0) < 1e-9
    assert abs(g.loc["REV", "adv20"] - 1e4) < 1e-6 and abs(g.loc["FWD", "adv20"] - 2e5) < 1e-6   # shares on d's basis
    assert abs(g.loc["RUN", "adv20"] - 1e5) < 1e-6
    assert splits.asked == [(["FWD", "REV"], D, ["FWD", "REV"])]  # only split-like moves are refreshed


# ---------------------------------------------------------------- watchlist: 09:25 pre-market gap, not the open
class PMClient:
    """FADE gapped +8% by 09:25 and opened +1%; POP was flat at 09:25 and opened +5%."""

    def __init__(self):
        self.calls = []

    def bars(self, symbols, timeframe, start, end, feed="sip"):
        self.calls.append((sorted(symbols), start, end))
        last = {"FADE": 10.8, "POP": 10.02, "FLAT": 10.0}
        t0 = pd.Timestamp(start)
        day = t0.tz_convert(NY).date()
        t = pd.date_range(t0, pd.Timestamp(end), freq="30min")
        rows = [{"symbol": s, "t": x, "o": last[s], "h": last[s], "l": last[s], "c": last[s] if day == D else 10.0,
                 "v": 50_000} for s in symbols if s in last for x in t]
        return pd.DataFrame(rows, columns=["symbol", "t", "o", "h", "l", "c", "v"])

    def news(self, symbols, start, end):
        return []


class NoShares:
    def asof(self, s, d):
        return None


def watch_daily():
    rows = [{"symbol": s, "date": P, "o": 10.0, "h": 10.0, "l": 10.0, "c": 10.0, "v": 1e6} for s in ("FADE", "POP", "FLAT")]
    rows += [{"symbol": s, "date": D, "o": o, "h": o, "l": o, "c": o, "v": 1e6} for s, o in (("FADE", 10.1), ("POP", 10.5),
                                                                                         ("FLAT", 10.0))]
    return pd.DataFrame(rows)


def test_watchlist_v2_prefilters_on_the_0925_gap_not_the_open(tmp_path, monkeypatch):
    monkeypatch.setattr(features, "PM_CACHE", tmp_path / "pm.parquet")
    sessions = [P, D]
    v1 = features.build_candidates(D, watch_daily(), sessions, PMClient(), features.PMCache(), NoShares(),
                                   lookback=1, with_quotes=False)
    assert [c.symbol for c in v1] == ["POP"]                       # selected by an open that is known only at 09:30
    client = PMClient()
    v2 = features.build_candidates(D, watch_daily(), sessions, client, features.PMCache(), NoShares(),
                                   lookback=1, with_quotes=False, causal=True)
    assert [c.symbol for c in v2] == ["FADE"] and abs(v2[0].gap_pct - 8.0) < 1e-9
    first = client.calls[0]
    assert first[0] == ["FADE", "FLAT", "POP"] and pd.Timestamp(first[2]) <= pd.Timestamp(f"{D} 09:24", tz=NY)


def test_watchlist_v2_puts_a_split_on_d_on_the_new_basis(tmp_path, monkeypatch):
    monkeypatch.setattr(features, "PM_CACHE", tmp_path / "pm.parquet")

    class SplitDay(PMClient):
        def bars(self, symbols, timeframe, start, end, feed="sip"):
            out = super().bars(symbols, timeframe, start, end, feed)
            return out.assign(c=np.where(out.symbol == "FLAT", 20.0, out.c))   # FLAT 1:2 reverse split: 10 -> 20

    splits = FakeSplits(pd.DataFrame({"symbol": ["FLAT", "FLAT"], "date": [dt.date(2024, 1, 1), D], "f": [0.5, 1.0]}))
    got = features.build_candidates(D, watch_daily(), [P, D], SplitDay(), features.PMCache(), NoShares(), lookback=1,
                                    with_quotes=False, causal=True, split_refresh=lambda syms: splits.refresh(syms, D, syms))
    assert [c.symbol for c in got] == ["FADE"]                     # FLAT's +100% was the split, not a gap
    assert splits.asked == [(["FLAT"], D, ["FLAT"])]


# ---------------------------------------------------------------- keys: v2 rows never mix with the biased v1 rows
def test_v2_keys_replace_the_biased_ones_and_old_markers_do_not_cover_them(monkeypatch):
    monkeypatch.setattr(ft, "V2_FROM", dt.date(2026, 9, 28))      # as if DEC-0011 were accepted on that date
    assert set(ft.LEGACY) == {"B_qqq_qqqm", "watchlist_bull_flag_atr_M1_v2", "hod_bull_flag_atr_M1_v2"}
    assert ft.BIASED == set(ft.LEGACY_V1) - {"B_qqq_qqqm"} and not ft.BIASED & ft.required(dt.date(2026, 10, 1))
    rows = [{"session": "2026-09-28", "session_marker": True, "n_trades": 0},
            {"session": "2026-09-29", "strategy": "watchlist_bull_flag_atr_M1", "strategy_marker": True, "n_trades": 0}]
    done = ft.done_by_session(rows)
    assert ft.required(dt.date(2026, 9, 28)) - done["2026-09-28"] >= {"watchlist_bull_flag_atr_M1_v2", "hod_bull_flag_atr_M1_v2"}
    assert "watchlist_bull_flag_atr_M1_v2" not in done["2026-09-29"]
    names = [n for names, _ in ft.units_for(types.SimpleNamespace(a=None, sessions=[]), D) for n in names]
    assert set(ft.LEGACY) <= set(names) and not ft.BIASED & set(names)


def test_v2_trials_wait_for_dec0011_acceptance(monkeypatch):
    import forward_test as ft
    d = dt.date(2026, 10, 5)
    monkeypatch.setattr(ft, "V2_FROM", None)
    assert not set(ft.V2) & ft.required(d)                   # not pre-registered yet: they don't run
    monkeypatch.setattr(ft, "V2_FROM", dt.date(2026, 10, 2))
    assert set(ft.V2) <= ft.required(d) and not set(ft.V2) & ft.required(dt.date(2026, 10, 1))   # no backfill
