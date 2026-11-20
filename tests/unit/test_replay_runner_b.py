"""The replay harness against a known answer: the unchanged paper-B runner, its real signal, a recorded-style tape.

Nothing is scripted here but the prices. The runner reads its own sigma from fourteen prior sessions, sees its own
signal on the 10:00 mark, sends its own orders, and the broker double fills them from the bars and quotes. If the
harness leaked a later bar, or filled by a rule the engine does not have, these sessions would not come out as the
arithmetic below says.
"""
from __future__ import annotations

import datetime as dt
import json

import pandas as pd
import pytest

from wt.core.clock import ET
from wt.live import runner_b
from wt.live.replay import BarFillBroker, ReplayClock, ReplayCrash, ReplayREST, Tape

DAY = dt.date(2026, 9, 30)
PRIOR = [d.date() for d in pd.bdate_range(end=DAY - dt.timedelta(days=1), periods=14)]
NEXT = (pd.Timestamp(DAY) + pd.offsets.BDay(1)).date()       # the runner asks the calendar for the session after today
SESSIONS = {d: ("09:30", "16:00") for d in [*PRIOR, DAY, NEXT]}
RATIO = 0.5                                     # QQQM trades at half of QQQ on this tape


def at(h: int, m: int, day: dt.date = DAY) -> dt.datetime:
    return dt.datetime.combine(day, dt.time(h, m), tzinfo=ET)


def session(day: dt.date, closes: list[float], first_open: float) -> pd.DataFrame:
    """One bar a minute from 09:30. Each bar opens at the previous close and ranges 5 cents either side."""
    rows, prev = [], first_open
    for i, c in enumerate(closes):
        t = (at(9, 30, day) + dt.timedelta(minutes=i)).astimezone(dt.UTC)
        rows.append({"t": t, "o": prev, "h": max(prev, c) + 0.05, "l": min(prev, c) - 0.05, "c": c, "v": 200_000.0})
        prev = c
    return pd.DataFrame(rows)


def tape_for(today: list[float]) -> Tape:
    """Fourteen quiet prior sessions (open 500, every close 501: sigma 0.2%, previous close 501), then `today` for
    QQQ, and the same path at half the price for QQQM. One quote a minute, a cent either side of the bar's open."""
    qqq = pd.concat([session(d, [501.0] * 390, 500.0) for d in PRIOR] + [session(DAY, today, 501.0)], ignore_index=True)
    qqqm = qqq.assign(**{k: qqq[k] * RATIO for k in ("o", "h", "l", "c")})
    quotes = {s: pd.DataFrame({"t": df.t, "bp": df.o - 0.01, "ap": df.o + 0.01}) for s, df in (("QQQ", qqq), ("QQQM", qqqm))}
    return Tape({"QQQ": qqq, "QQQM": qqqm}, quotes)


def path(after_entry: list[float]) -> list[float]:
    """Flat at 501 until 09:58, a close of 503 on the 09:59 bar (the 10:00 mark: above the 502.002 band and the
    VWAP), then `after_entry` from the 10:00 bar on, the last value held to the close."""
    head = [501.0] * 29 + [503.0]
    tail = after_entry + [after_entry[-1]] * (390 - len(head) - len(after_entry))
    return head + tail


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("MODE", "paper")
    monkeypatch.setattr(runner_b, "LIVE", tmp_path / "live")
    monkeypatch.setattr(runner_b, "KILL", tmp_path / "KILL")
    monkeypatch.setattr(runner_b, "MIN_FREE_GB", 0.0)
    monkeypatch.setattr("wt.risk.mandate.LEGACY_FILE", tmp_path / "legacy_positions.yaml")
    monkeypatch.setattr(runner_b.events, "coverage_ok", lambda d: True)
    monkeypatch.setattr(runner_b.events, "policy", lambda now: ("normal", None))
    return tmp_path


def run(env, today: list[float], start=(8, 0), crash_at=None, broker=None):
    tape = tape_for(today)
    clock = ReplayClock(at(*start), crash_at=crash_at)
    if broker is None:
        broker = BarFillBroker(clock, tape, SESSIONS)
    else:                                       # a restart: the same broker, a new clock
        broker._rc = clock
        clock.hooks.insert(0, broker.advance)
    runner_b.run(DAY, broker=broker, rest=ReplayREST(clock, tape, SESSIONS), now_fn=clock.now, sleep_fn=clock.sleep)
    return broker


def journal(env) -> list[dict]:
    rows = [json.loads(x) for x in (env / "live" / "journal.jsonl").read_text().splitlines()]
    errors = [r for r in rows if r["event"] in ("loop_error", "data_timeout", "decision_error")]
    assert not errors, errors[:3]
    return rows


def one(rows: list[dict], event: str) -> dict:
    hits = [r for r in rows if r["event"] == event]
    assert len(hits) == 1, f"{event}: {len(hits)} rows"
    return hits[0]


# The signal on this tape, by the rule: close 503.00 > 501 x 1.002; trigger 503.01; the VWAP (about 501.07) is under
# 503 x 0.998, so the stop is the VWAP less a cent. In QQQM: trigger ceil(251.505) = 251.51, R just under a dollar.
TRIGGER = 251.51


def test_a_session_that_reaches_its_target_is_entered_protected_and_sold_at_the_bid(env):
    # 10:00 to 10:19 hold 503.2 (QQQM 251.60); from the 10:20 bar QQQ closes at 507.2: QQQM's bid then sits at
    # 253.59, above any target this entry can have, so the DEC-0063 exit may sell at a limit at the target.
    b = run(env, path([503.2] * 20 + [507.2]))
    j = journal(env)
    armed = one(j, "armed")
    assert armed["sigma"] == pytest.approx(0.002) and armed["prev_close"] == 501.0 and armed["sigma_sessions"] == 14
    placed = one(j, "entry_placed")
    assert placed["trigger"] == TRIGGER and placed["qty"] == 2 and placed["state"] == "entry_working"
    filled = one(j, "entry_filled")
    assert filled["price"] == pytest.approx(TRIGGER + 0.01)             # max(trigger, open 251.50) plus a cent
    closed = one(j, "trade_closed")
    assert closed["reason"] == "target" and closed["exit_price_estimated"] is False
    assert closed["exit"] >= placed["target"] and closed["R"] > 1.9
    rules = [f.rule for f in b.fills]
    assert rules == ["stop_limit", "marketable_limit"]                  # one entry from a bar, one exit at the bid
    entry_t = b.fills[0].t.tz_convert(ET)
    assert (entry_t.hour, entry_t.minute) == (10, 0)                    # the bar after the mark: never the mark itself
    assert b.positions() == [] and b.open_orders() == []
    assert one(j, "session_end")


def test_a_session_that_falls_is_stopped_at_the_stop_less_slippage(env):
    b = run(env, path([503.2] * 5 + [500.0]))                           # 10:05: QQQM trades down through its stop
    j = journal(env)
    placed, closed = one(j, "entry_placed"), one(j, "trade_closed")
    assert closed["reason"] == "stop"
    assert closed["exit"] == pytest.approx(placed["stop"] - 0.01)        # the stop, less the cent of slippage
    assert -1.2 < closed["R"] < -1.0
    assert [f.rule for f in b.fills] == ["stop_limit", "stop"]
    assert b.positions() == [] and b.open_orders() == []


def test_a_quiet_session_places_no_order(env):
    b = run(env, [501.0] * 390)
    j = journal(env)
    assert not [r for r in j if r["event"] in ("entry_placed", "entry_filled", "trade_closed")]
    assert b.placed == [] and one(j, "session_end")
    summary = one(j, "decision_summary")
    assert summary["would_signals"] == 0 and summary["asked"] > 0


def test_a_position_that_neither_stops_nor_reaches_its_target_is_flat_by_the_close(env):
    b = run(env, path([503.2]))                                         # holds 251.60 all day
    j = journal(env)
    closed = one(j, "trade_closed")
    assert closed["reason"] == "eod_flatten" and abs(closed["R"]) < 0.2
    assert b.positions() == [] and b.open_orders() == []


def test_a_crash_while_in_the_position_resumes_and_books_the_trade_once(env):
    today = path([503.2] * 20 + [507.2])
    tape = tape_for(today)
    clock = ReplayClock(at(8, 0), crash_at=at(10, 10))
    b = BarFillBroker(clock, tape, SESSIONS)
    with pytest.raises(ReplayCrash):
        runner_b.run(DAY, broker=b, rest=ReplayREST(clock, tape, SESSIONS), now_fn=clock.now, sleep_fn=clock.sleep)
    assert [p.qty for p in b.positions()] == [2] and len(b.own_sells("QQQM")) == 1   # died holding, its stop resting
    run(env, today, start=(10, 12), broker=b)
    j = journal(env)
    assert [r["event"] for r in j].count("entry_placed") == 1
    assert one(j, "trade_closed")["reason"] == "target"
    assert sum(1 for c in b.placed if b.orders[c].side == "buy") == 1
    assert b.positions() == [] and b.open_orders() == []
