"""The `today` section: Paper B's session, trades and profit and loss, from the journal's own rows."""
from __future__ import annotations

import datetime as dt

from wt.analytics import today_view

DAY = dt.date(2026, 10, 6)


def _trade(day: str, entry: float, exit_: float, r: float, qty: int = 2, n: int = 0) -> list[dict]:
    tid = f"{day}-B-QQQM-{n}"
    return [{"event": "armed", "ts": f"{day}T12:30:00+00:00", "day": day, "kill": False, "entries_off": [],
             "virtual": {"equity": 600.0, "secret": "never copied"}},
            {"event": "entry_placed", "ts": f"{day}T14:30:06+00:00", "trigger": entry, "stop": entry - 1,
             "target": entry + 2, "qty": qty},
            {"event": "entry_filled", "ts": f"{day}T14:31:00+00:00", "trade_id": tid, "qty": qty, "price": entry},
            {"event": "trade_closed", "ts": f"{day}T19:45:00+00:00", "day": day, "symbol": "QQQM", "entry": entry,
             "exit": exit_, "stop": entry - 1, "qty": qty, "R": r, "reason": "target" if r > 0 else "stop",
             "trade_id": tid, "booked": True, "virtual": {"equity": 601.0}},
            {"event": "session_end", "ts": f"{day}T20:00:05+00:00", "outcome": "traded", "virtual": {"equity": 601.0}}]


def test_profit_and_loss_by_day_week_month_and_total():
    rows = (_trade("2026-09-29", 250.0, 252.0, 2.0) + _trade("2026-10-02", 250.0, 249.0, -1.0)
            + _trade("2026-10-05", 250.0, 251.5, 1.5) + _trade("2026-10-06", 250.0, 250.5, 0.5))
    v = today_view.view(rows, DAY, {"start_equity": 600.0, "equity": 606.0})
    p = v["pnl"]
    assert (p["today"], p["week"], p["month"], p["total"]) == (1.0, 4.0, 2.0, 6.0)     # Mon 5 and Tue 6 this week
    assert (p["today_r"], p["week_r"], p["total_r"]) == (0.5, 2.0, 3.0)
    assert (p["trades"], p["wins"], p["losses"], p["win_rate"]) == (4, 3, 1, 75.0)
    assert (p["best"], p["worst"], p["max_dd"], p["profit_factor"]) == (4.0, -2.0, -2.0, 4.0)
    assert p["equity"] == 606.0 and p["return_pct"] == 1.0
    assert [d["date"] for d in v["days"]] == ["2026-09-29", "2026-10-02", "2026-10-05", "2026-10-06"]
    t = v["trades"][-1]
    assert (t["entry"], t["exit"], t["pnl"], t["r"], t["target"], t["held_min"]) == (250.0, 250.5, 1.0, 0.5, 252.0, 314.0)
    assert t["entry_at"] == "2026-10-06T14:31:00+00:00" and t["exit_at"] == "2026-10-06T19:45:00+00:00"
    assert v["session"] == "2026-10-06" and v["outcome"] == "traded" and v["ended"] and v["position"] is None
    assert "virtual" not in str(v) and "secret" not in str(v)                           # named fields only


def test_a_replayed_close_counts_once():
    rows = _trade("2026-10-06", 250.0, 251.0, 1.0)
    rows.append(rows[3])
    assert today_view.view(rows, DAY, None)["pnl"]["trades"] == 1


def test_an_open_position_and_a_working_order_are_shown_until_they_close():
    rows = _trade("2026-10-06", 250.0, 251.0, 1.0)
    working = today_view.view(rows[:2], DAY, None)
    assert working["position"]["state"] == "entry_working" and working["position"]["entry"] is None
    assert working["position"]["trigger"] == 250.0 and working["outcome"] == "traded" and not working["ended"]
    held = today_view.view(rows[:3], DAY, None)["position"]
    assert (held["state"], held["qty"], held["entry"], held["stop"], held["target"]) == ("in_position", 2.0, 250.0, 249.0, 252.0)
    assert today_view.view(rows[:4], DAY, None)["position"] is None


def test_a_session_from_before_outcomes_were_recorded_still_gets_one():
    kill = [{"event": "armed", "ts": "2026-10-05T12:30:00+00:00", "day": "2026-10-05", "kill": True, "entries_off": []},
            {"event": "decision", "ts": "2026-10-05T14:32:05+00:00", "would_signal": True, "runner_acts": False,
             "signal_t": "2026-10-05 14:30:00+00:00", "trigger": 753.14, "stop": 749.61,
             "blockers": ["kill_file", "latched:daily loss of the owner's free text"]},
            {"event": "session_end", "ts": "2026-10-05T20:00:08+00:00"}]
    v = today_view.view(kill, DAY, None)
    assert v["outcome"] == "blocked:kill_file" and v["armed"]["kill"] is True
    assert v["signals"] == [{"at": "2026-10-05T14:30:00+00:00", "trigger": 753.14, "stop": 749.61,
                             "blockers": "kill_file, latched", "acted": False}]         # kinds, never the free text
    quiet = [kill[0], kill[2]]
    assert today_view.view(quiet, DAY, None)["outcome"] == "no_signal"
    assert today_view.view(kill[:2], DAY, None)["outcome"] is None                      # still in session


def test_an_empty_journal_is_a_valid_section():
    v = today_view.view([], DAY, None)
    assert v["session"] is None and v["trades"] == [] and v["days"] == [] and v["pnl"]["trades"] == 0
    assert v["pnl"]["total"] == 0 and v["pnl"]["win_rate"] is None


def test_bad_numbers_never_reach_the_page():
    rows = _trade("2026-10-06", 250.0, 251.0, 1.0)
    rows[3] = {**rows[3], "exit": float("nan"), "R": None}
    t = today_view.view(rows, DAY, None)["trades"][0]
    assert t["exit"] is None and t["pnl"] is None and t["r"] is None
