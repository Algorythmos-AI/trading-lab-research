"""wt.live.scan_s: the reversal universe is built only from what a scan can know when it runs (HYP-0070)."""
from __future__ import annotations

import datetime as dt
import json

import numpy as np
import pandas as pd
import pytest

from wt.core.clock import ET
from wt.live import scan_s
from wt.live.scan_s import Universe, completed_minutes, parse_snapshot, qualifies, volume_floor

DAY = dt.date(2026, 10, 1)
OPEN = dt.datetime.combine(DAY, dt.time(9, 30), tzinfo=ET)
CURVE = np.linspace(1 / 390, 1.0, 390)          # 1/390 of the day per minute: the floor is easy to read


def at(h: int, m: int, s: int = 0) -> dt.datetime:
    return dt.datetime.combine(DAY, dt.time(h, m, s), tzinfo=ET)


def snap(last=50.0, o=52.0, low=50.0, v=400_000, bar_day=DAY, trade_day=DAY) -> dict:
    return {"dailyBar": {"t": f"{bar_day}T04:00:00Z", "o": o, "h": o, "l": low, "c": last, "v": v},
            "latestTrade": {"t": f"{trade_day}T14:40:00Z", "p": last}}


def test_the_committed_curve_loads_and_a_wrong_one_is_refused(tmp_path):
    curve = scan_s.load_curve()
    assert curve.shape == (390,) and curve[-1] == 1.0
    bad = tmp_path / "curve.json"
    bad.write_text(json.dumps({"curve": [0.5, 0.4] + [1.0] * 388}))      # goes down: not cumulative
    with pytest.raises(ValueError):
        scan_s.load_curve(bad)
    bad.write_text(json.dumps({"curve": [1.0] * 10}))
    with pytest.raises(ValueError):
        scan_s.load_curve(bad)


def test_the_volume_floor_uses_the_last_completed_minute_only():
    assert completed_minutes(at(9, 30, 59), OPEN) == 0 and completed_minutes(at(9, 35, 20), OPEN) == 5
    assert volume_floor(CURVE, 0) == float("inf")                        # nothing has completed: nothing qualifies
    assert volume_floor(CURVE, 5) == pytest.approx(500_000 * 5 / 390)    # the 09:34 bar's share, not 09:35's
    assert volume_floor(CURVE, 1000) == 500_000                          # after the close: the whole day


@pytest.mark.parametrize("kw, ok", [
    ({}, True),
    ({"last": 14.99, "o": 15.6, "low": 14.9}, False),                    # under US$15
    ({"last": 250.01, "o": 260.0, "low": 250.0}, False),                 # over US$250
    ({"last": 250.0, "o": 260.0, "low": 250.0}, True),
    ({"o": 51.5, "low": 50.0}, False),                                   # 2.9% under the open
    ({"o": 100.0, "low": 97.0, "last": 99.0}, True),                     # exactly 3%, even after a bounce
    ({"v": 99_999}, False),
])
def test_a_name_qualifies_on_price_drop_and_volume_so_far(kw, ok):
    s = parse_snapshot(snap(**kw), DAY)
    assert s is not None and qualifies(s, floor=100_000) is ok


def test_yesterdays_bar_or_a_broken_snapshot_is_not_todays_drop():
    yesterday = DAY - dt.timedelta(days=1)
    assert parse_snapshot(snap(bar_day=yesterday), DAY) is None          # no print yet today
    assert parse_snapshot(snap(trade_day=yesterday), DAY) is None
    assert parse_snapshot({"dailyBar": {"t": f"{DAY}T04:00:00Z", "o": 1}}, DAY) is None
    assert parse_snapshot(None, DAY) is None and parse_snapshot({"latestTrade": {}}, DAY) is None
    assert parse_snapshot(snap(o=0.0), DAY) is None


def test_a_scan_is_due_once_per_five_minute_mark_from_0935():
    u = Universe(DAY, OPEN, CURVE)
    assert not u.due(at(9, 34, 59)) and u.due(at(9, 35))
    u.candidates({}, at(9, 35, 10))
    assert not u.due(at(9, 39, 59)) and u.due(at(9, 40))
    u.candidates({}, at(9, 47))                                          # a late scan covers its own mark only
    assert not u.due(at(9, 49)) and u.due(at(9, 50)) and u.scans == 2


def minutes(rows: list[tuple[str, float, float, float, float, float]]) -> pd.DataFrame:
    """rows: (HH:MM, o, h, l, c, v)"""
    return pd.DataFrame([{"t": at(*map(int, hm.split(":"))).astimezone(dt.UTC), "o": o, "h": h, "l": lo, "c": c, "v": v}
                         for hm, o, h, lo, c, v in rows])


DROP = [("09:30", 52.0, 52.1, 51.0, 51.2, 8_000), ("09:31", 51.2, 51.3, 50.0, 50.4, 9_000)]      # 3.8% under 52


def test_the_snapshot_only_proposes_and_closed_session_bars_decide():
    u = Universe(DAY, OPEN, CURVE)
    snaps = {"AAA": snap(v=400_000), "BBB": snap(o=50.5), "CCC": snap(v=400_000)}
    cands = u.candidates(snaps, at(9, 40))
    assert cands == ["AAA", "CCC"] and u.joined == {}                    # BBB: only 1% under its open
    thin = [("09:30", 52.0, 52.1, 50.0, 50.4, 500)]                      # the snapshot's volume was pre-market
    assert u.admit(cands, {"AAA": minutes(DROP), "CCC": minutes(thin)}, at(9, 40)) == ["AAA"]
    assert u.joined == {"AAA": at(9, 40)}


def test_confirmation_reads_no_bar_before_the_open_or_still_forming():
    pre = [("09:29", 60.0, 60.0, 40.0, 50.0, 900_000)]                   # a pre-market bar: not the session
    forming = [("09:40", 50.4, 50.5, 30.0, 31.0, 900_000)]               # 09:40 has not ended at 09:40:30
    s = scan_s.from_bars(minutes(pre + DROP + forming), OPEN, at(9, 40, 30))
    assert (s.open, s.low, s.last, s.volume) == (52.0, 50.0, 50.4, 17_000)
    assert scan_s.from_bars(minutes(pre), OPEN, at(9, 40)) is None and scan_s.from_bars(None, OPEN, at(9, 40)) is None
    u = Universe(DAY, OPEN, CURVE)
    assert u.admit(["AAA"], {}, at(9, 40)) == []                         # no bars: not confirmed


def test_a_name_joins_once_and_then_stays():
    u = Universe(DAY, OPEN, CURVE)
    assert u.admit(["AAA"], {"AAA": minutes(DROP)}, at(9, 40)) == ["AAA"]
    assert u.candidates({"AAA": snap(v=400_000)}, at(9, 45)) == []       # already in: not proposed again
    assert u.admit(["AAA"], {"AAA": minutes(DROP)}, at(9, 45)) == [] and u.joined == {"AAA": at(9, 40)}


def test_the_same_bars_confirm_late_in_the_day_only_with_more_volume():
    assert Universe(DAY, OPEN, CURVE).admit(["AAA"], {"AAA": minutes(DROP)}, at(9, 40)) == ["AAA"]
    assert Universe(DAY, OPEN, CURVE).admit(["AAA"], {"AAA": minutes(DROP)}, at(15, 0)) == []   # floor 423,077


def test_snapshots_are_asked_in_chunks_with_the_feed_named_and_a_bad_reply_raises():
    calls = []

    class Rest:
        def get(self, url, params):
            calls.append((url, params))
            return {s: snap() for s in params["symbols"].split(",")}

    syms = [f"S{i:04d}" for i in range(2300)]
    got = scan_s.fetch_snapshots(Rest(), syms)
    assert len(got) == 2300 and len(calls) == 3
    assert all(p["feed"] == "sip" and u.endswith("/v2/stocks/snapshots") for u, p in calls)

    class Broken:
        def get(self, url, params):
            return []
    with pytest.raises(ValueError):
        scan_s.fetch_snapshots(Broken(), syms[:3])


def test_only_plain_active_tradable_symbols_are_scanned():
    assets = [{"symbol": "AAA", "tradable": True, "status": "active"}, {"symbol": "BRK.B", "tradable": True},
              {"symbol": "CCC", "tradable": False}, {"symbol": "DDD", "tradable": True, "status": "inactive"},
              {"symbol": "EEE", "tradable": True}]
    assert scan_s.tradable_symbols(assets) == ["AAA", "EEE"]

