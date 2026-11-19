"""wt.live.runner_s: sleeve S's whole session, replayed. Constructed tapes only: no recorded market data is read.

The runner's own loop, scan, rule, gates and order manager run unchanged; the replay harness supplies the clock, the
market data as of the clock, and a broker that fills from the bars and quotes (wt.live.replay).
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json

import numpy as np
import pandas as pd
import pytest
from spec_bars import flat, minute_bars

from wt.core.clock import ET
from wt.live import runner_b, runner_s
from wt.live.replay import BarFillBroker, ReplayClock, ReplayCrash, ReplayREST, Tape

DAY, PREV, NEXT = dt.date(2024, 3, 1), dt.date(2024, 2, 29), dt.date(2024, 3, 4)
SESSIONS = {d: ("09:30", "16:00") for d in (PREV, DAY, NEXT)}
KEYS = {"APCA_S_KEY_ID": "PKS-TEST", "APCA_S_SECRET_KEY": "s-secret", "APCA_API_KEY_ID": "PKQ-TEST"}
TARGET = 45.62                      # EMA9 of the five-minute closes when the signal forms
ENTRY = 41.03                       # the 41.02 trigger plus a cent of slippage
STOP = 40.68


def at(h: int, m: int, s: int = 0) -> dt.datetime:
    return dt.datetime.combine(DAY, dt.time(h, m, s), tzinfo=ET)


def flush_rows() -> list[tuple]:
    """A flat hour at 50, three big red five-minute buckets, a small-range bucket at the low of the day. The name
    is 3% under its open from 10:33, so the 10:35 scan admits it; the signal forms when the 10:49 bar closes:
    trigger 41.02, stop 40.68, target 45.62."""
    rows = flat(60, 50.0, v=20_000, spread=0.05)
    px = 50.0
    for _ in range(15):
        rows.append((px, px + 0.02, px - 0.62, px - 0.60, 40_000))
        px -= 0.60
    for _ in range(5):
        rows.append((px, px + 0.01, px - 0.07, px - 0.06, 40_000))
        px -= 0.06
    return rows


FILL = (40.75, 41.10, 40.72, 41.04, 30_000)                         # 10:50: reaches the trigger, opens under the collar
UP = [(41.04, 41.35, 41.00, 41.30, 30_000), (41.30, 41.60, 41.25, 41.50, 30_000), (41.50, 41.80, 41.45, 41.70, 30_000)]
TO_TARGET = [FILL, *UP, (41.70, 46.20, 41.65, 46.00, 30_000)]       # 10:54 runs through the target
STOPPED = [FILL, (41.04, 41.05, 40.60, 40.62, 30_000)]
STALLED = [FILL] + [(41.04, 41.08, 41.00, 41.05, 30_000)] * 6
GAPPED = [(41.20, 41.40, 41.10, 41.30, 30_000)]                     # 10:50 opens over the collar: no fill, ever
QUIET_DAY = flat(390, 50.0, v=20_000, spread=0.05)


def day_rows(after: list[tuple]) -> list[tuple]:
    rows = flush_rows() + list(after)
    last = rows[-1][3]
    return rows + [(last, last + 0.02, last - 0.02, last, 20_000)] * (390 - len(rows))


def quotes_for(bars: pd.DataFrame) -> pd.DataFrame:
    """A quote every five seconds: a cent either side of the open of the minute it falls in."""
    rows = []
    for r in bars.itertuples():
        for k in range(12):
            rows.append({"t": r.t + pd.Timedelta(seconds=5 * k), "bp": r.o - 0.01, "ap": r.o + 0.01})
    return pd.DataFrame(rows)


def tape_of(days: dict[str, list[tuple]]) -> Tape:
    """days: symbol -> the day's 390 rows. Every symbol gets the same quiet prior session (2,000 shares a minute)."""
    bars, quotes = {}, {}
    for sym, rows in days.items():
        today = minute_bars(rows)
        prev = minute_bars(flat(390, 50.0, v=2_000, spread=0.05), day=str(PREV))
        bars[sym] = pd.concat([prev, today], ignore_index=True)
        quotes[sym] = quotes_for(today)
    return Tape(bars, quotes)


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("MODE", "paper")
    monkeypatch.delenv("WT_HOST", raising=False)
    record = tmp_path / "DEC-0066.md"
    record.write_text("# DEC-0066\n\n- **Status: ACCEPTED on 2026-12-01.**\n")
    state = tmp_path / "var" / "smallcap"
    for name, value in (("DIR", state), ("PLANS", state / "plans"), ("KILL", state / "KILL"),
                        ("VA_PATH", state / "virtual_account.json"),
                        ("JOURNAL", tmp_path / "live" / "smallcap_journal.jsonl"), ("RECORD", record),
                        ("MIN_FREE_GB", 0.0)):
        monkeypatch.setattr(runner_s, name, value)
    monkeypatch.setattr(runner_s, "detector_curve", lambda: np.linspace(1 / 390, 1.0, 390))
    monkeypatch.setattr(runner_b, "LIVE", tmp_path / "live")          # sleeve Q's folder, to prove it is not touched
    return tmp_path


def session(tape: Tape, start=(9, 25), crash_at=None, broker=None, hook=None, **kw):
    clock = ReplayClock(at(*start), crash_at=crash_at)
    if broker is None:
        broker = BarFillBroker(clock, tape, SESSIONS)
    else:                                                             # a restart: the same broker, a new clock
        broker._rc = clock
        clock.hooks.insert(0, broker.advance)
    if hook is not None:
        clock.hooks.append(lambda now: hook(now, broker))
    args = {"account_number": "PA3SLEEVES", "q_account": lambda: "PA3SLEEVEQ", "environ": KEYS, **kw}
    runner_s.run(DAY, poll_s=10.0, broker=broker, rest=ReplayREST(clock, tape, SESSIONS), now_fn=clock.now,
                 sleep_fn=clock.sleep, **args)
    return broker


def journal(env, allow_errors: bool = False) -> list[dict]:
    f = env / "live" / "smallcap_journal.jsonl"
    rows = [json.loads(x) for x in f.read_text().splitlines()] if f.exists() else []
    errors = [r for r in rows if r["event"] in ("loop_error", "held_error", "data_timeout", "scan_failed")]
    assert allow_errors or not errors, errors[:3]
    return rows


def events(rows: list[dict], name: str) -> list[dict]:
    return [r for r in rows if r["event"] == name]


def one(rows: list[dict], name: str) -> dict:
    hits = events(rows, name)
    assert len(hits) == 1, f"{name}: {len(hits)} rows"
    return hits[0]


def flat_and_clean(b: BarFillBroker) -> None:
    assert b.positions() == [] and b.open_orders() == []


# ---- the lifecycle (DEC-0066 section 5, item 4) ---------------------------------------------------------------------
def test_an_entry_that_reaches_its_target_is_found_ordered_protected_sold_and_booked(env):
    b = session(tape_of({"ABC": day_rows(TO_TARGET)}))
    j = journal(env)
    assert one(j, "universe")["joined"] == ["ABC"]
    placed = one(j, "entry_placed")
    assert (placed["trigger"], placed["limit"], placed["stop"], placed["target"]) == (41.02, 41.05, STOP, TARGET)
    assert placed["qty"] == 14 and placed["trial"] == "HYP-0070" and placed["nbbo"] is not None   # cash caps the size
    filled = one(j, "entry_filled")
    assert filled["price"] == pytest.approx(ENTRY)
    closed = one(j, "trade_closed")
    assert closed["reason"] == "target" and closed["exit"] >= TARGET and closed["exit_price_estimated"] is False
    assert closed["R"] > 2 and closed["booked"] is True
    assert [f.rule for f in b.fills] == ["stop_limit", "marketable_limit"]
    entry_t = b.fills[0].t.tz_convert(ET)
    assert (entry_t.hour, entry_t.minute) == (10, 50)                  # the bar after the signal bar, never the same
    end = one(j, "session_end")
    assert end["entries"] == 1 and end["closed"] == 1 and end["universe"] == 1
    va = json.loads((env / "var" / "smallcap" / "virtual_account.json").read_text())
    assert va["equity"] > 600 and va["latched"] is False and len(va["recorded_trades"]) == 1
    flat_and_clean(b)


def test_a_stop_out_is_booked_at_the_stop_less_slippage(env):
    b = session(tape_of({"ABC": day_rows(STOPPED)}))
    closed = one(journal(env), "trade_closed")
    assert closed["reason"] == "stop" and closed["exit"] == pytest.approx(STOP - 0.01)
    assert -1.1 < closed["R"] < -1.0
    assert [f.rule for f in b.fills] == ["stop_limit", "stop"]
    flat_and_clean(b)


def test_a_trade_that_goes_nowhere_leaves_at_the_stagnation_stop(env):
    b = session(tape_of({"ABC": day_rows(STALLED)}))
    closed = one(journal(env), "trade_closed")
    assert closed["reason"] == "time_stop_5m" and abs(closed["R"]) < 0.2
    exit_t = b.fills[-1].t.tz_convert(ET)
    assert (exit_t.hour, exit_t.minute) == (10, 55)                    # asked at the close of the 10:54 bar
    flat_and_clean(b)


def test_a_session_with_no_valid_setup_places_nothing_and_says_so(env):
    b = session(tape_of({"ABC": QUIET_DAY}))
    j = journal(env)
    assert b.placed == [] and not events(j, "entry_placed") and not events(j, "universe")
    end = one(j, "session_end")
    assert end["entries"] == 0 and end["universe"] == 0 and end["scans"] > 60
    assert not (env / "var" / "smallcap" / "plans").exists()


def test_a_crash_while_holding_resumes_the_plan_and_books_the_trade_once(env):
    tape = tape_of({"ABC": day_rows(TO_TARGET)})
    clock = ReplayClock(at(9, 25), crash_at=at(10, 52))
    b = BarFillBroker(clock, tape, SESSIONS)
    with pytest.raises(ReplayCrash):
        runner_s.run(DAY, poll_s=10.0, broker=b, rest=ReplayREST(clock, tape, SESSIONS), now_fn=clock.now,
                     sleep_fn=clock.sleep, account_number="PA3SLEEVES", q_account=lambda: "PA3SLEEVEQ", environ=KEYS)
    assert [p.qty for p in b.positions()] == [14] and len(b.own_sells("ABC")) == 1      # died holding, stop resting
    session(tape, start=(10, 53), broker=b)
    j = journal(env)
    assert len(events(j, "entry_placed")) == 1 and one(j, "trade_closed")["reason"] == "target"
    assert events(j, "armed")[-1]["resumed_plan"] is not None
    assert sum(1 for c in b.placed if b.orders[c].side == "buy") == 1
    flat_and_clean(b)


def test_a_refused_sell_is_restopped_and_the_exit_is_tried_again(env):
    done = []

    def refuse_first_exit(now, b):
        if now >= at(10, 55) and not done:
            done.append(now)
            b.fail_next_place = True                                   # the target exit never reaches the broker

    b = session(tape_of({"ABC": day_rows(TO_TARGET)}), hook=refuse_first_exit)
    j = journal(env)
    closed = one(j, "trade_closed")
    assert closed["reason"] == "target" and closed["exit"] >= TARGET
    stops = [c for c in b.placed if b.orders[c].side == "sell" and b.orders[c].type == "stop"]
    assert len(stops) == 2                                             # the first stop, and the one put back
    flat_and_clean(b)


def test_the_kill_file_raised_while_holding_stops_entries_and_keeps_the_exit(env):
    def raise_kill(now, b):
        if now >= at(10, 52):
            (env / "var" / "smallcap" / "KILL").touch()

    b = session(tape_of({"ABC": day_rows(TO_TARGET)}), hook=raise_kill)
    j = journal(env)
    assert one(j, "kill_state")["on"] is True
    assert one(j, "trade_closed")["reason"] == "target"
    flat_and_clean(b)


def test_the_kill_file_cancels_a_resting_entry(env):
    def raise_kill(now, b):
        if now >= at(10, 50, 15):
            (env / "var" / "smallcap" / "KILL").touch()

    quiet = [(40.75, 40.90, 40.70, 40.80, 30_000)] * 4                 # the trigger is not reached before the kill
    b = session(tape_of({"ABC": day_rows(quiet)}), hook=raise_kill)
    j = journal(env)
    assert one(j, "entry_cancelled")["why"] == "kill_file" and not events(j, "entry_filled")
    flat_and_clean(b)


# ---- entries that must not happen ------------------------------------------------------------------------------------
def test_an_order_that_gapped_over_its_collar_is_cancelled_and_ends_the_name(env):
    b = session(tape_of({"ABC": day_rows(GAPPED)}))
    j = journal(env)
    assert one(j, "entry_cancelled")["why"] == "no_fill"
    assert not events(j, "entry_filled") and not events(j, "trade_closed")
    assert len(events(j, "entry_placed")) == 1 and one(j, "session_end")["blocked"] == {"no_fill": 1}
    flat_and_clean(b)


def second_flush(start_px: float) -> list[tuple]:
    """Another oversold flush, as the first: three big red five-minute buckets, then a small one at the new low."""
    rows, px = [], start_px
    for _ in range(15):
        rows.append((px, px + 0.02, px - 0.62, px - 0.60, 40_000))
        px -= 0.60
    for _ in range(5):
        rows.append((px, px + 0.01, px - 0.07, px - 0.06, 40_000))
        px -= 0.06
    return rows + [(px, px + 0.05, px - 0.02, px + 0.02, 30_000)] * 10


# 10:50 gaps over the collar (no fill); flat to 12:39, long enough for the bands to close up again; a second
# signal forms when the 12:59 bar closes
TWO_SIGNALS = GAPPED + [(41.30, 41.32, 41.28, 41.30, 20_000)] * 109 + second_flush(41.30)


def test_the_tape_with_two_signals_would_trade_the_second_if_the_name_were_fresh(env):
    tape = tape_of({"ABC": day_rows(TWO_SIGNALS)})
    session(tape, start=(10, 54))                                      # a first start after the unfilled attempt
    j = journal(env)
    assert len(events(j, "entry_placed")) == 1 and events(j, "entry_placed")[0]["signal_t"].startswith("2024-03-01 17:59")


def test_an_unfilled_attempt_stays_spent_across_a_restart(env):
    tape = tape_of({"ABC": day_rows(TWO_SIGNALS)})
    clock = ReplayClock(at(9, 25), crash_at=at(10, 53))
    b = BarFillBroker(clock, tape, SESSIONS)
    with pytest.raises(ReplayCrash):
        runner_s.run(DAY, poll_s=10.0, broker=b, rest=ReplayREST(clock, tape, SESSIONS), now_fn=clock.now,
                     sleep_fn=clock.sleep, account_number="PA3SLEEVES", q_account=lambda: "PA3SLEEVEQ", environ=KEYS)
    session(tape, start=(10, 54), broker=b)
    j = journal(env)
    assert len(events(j, "universe")) == 2                             # it rejoined after the restart ...
    assert len(events(j, "entry_placed")) == 1                         # ... already spent: the 12:59 signal is not traded
    assert events(j, "entry_placed")[0]["signal_t"].startswith("2024-03-01 15:49")
    assert not events(j, "entry_not_placed")                          # and not merely refused by the broker as a duplicate
    flat_and_clean(b)


HOLDS = [FILL, *UP]                                                    # in the position all day: no target, no stop
LATER = flat(10, 50.0, v=20_000, spread=0.05)                          # the same flush, ten minutes later


def test_a_signal_forming_while_another_name_is_in_play_is_blocked_not_missed(env):
    xyz = LATER + flush_rows() + [(40.75, 40.90, 40.70, 40.80, 30_000)] * 20
    last = xyz[-1][3]
    xyz = xyz + [(last, last + 0.02, last - 0.02, last, 20_000)] * (390 - len(xyz))
    b = session(tape_of({"ABC": day_rows(HOLDS), "XYZ": xyz}))
    j = journal(env)
    assert one(j, "entry_placed")["symbol"] == "ABC"
    blocked = one(j, "signal_blocked")
    assert blocked["symbol"] == "XYZ" and blocked["blockers"] == ["exposure_exists"]
    assert blocked["signal_t"].startswith("2024-03-01 15:59") and "name_done" not in blocked
    assert not events(j, "signal_missed")
    assert one(j, "trade_closed")["reason"] == "eod_flatten"
    flat_and_clean(b)


def test_a_wide_spread_at_the_signal_blocks_the_entry_and_ends_the_name(env):
    tape = tape_of({"ABC": day_rows(TO_TARGET)})
    tape.quotes["ABC"] = tape.quotes["ABC"].assign(ap=lambda q: q.bp + 0.08)            # eight cents wide all day
    b = session(tape)
    blocked = one(journal(env), "signal_blocked")
    assert blocked["blockers"] == ["spread"] and blocked["name_done"] == "spread" and b.placed == []


def test_no_quote_at_the_signal_blocks_the_entry(env):
    tape = tape_of({"ABC": day_rows(TO_TARGET)})
    tape.quotes.clear()
    b = session(tape)
    blocked = one(journal(env), "signal_blocked")
    assert blocked["blockers"][0] == "spread" and "no_quote" in blocked["blockers"] and b.placed == []


def test_a_stale_quote_blocks_the_entry(env):
    tape = tape_of({"ABC": day_rows(TO_TARGET)})
    q = tape.quotes["ABC"]
    tape.quotes["ABC"] = q[q.t <= pd.Timestamp(at(10, 49, 30))].reset_index(drop=True)  # the feed stops before the signal
    b = session(tape)
    assert "quote_age" in one(journal(env), "signal_blocked")["blockers"] and b.placed == []


def test_the_day_stop_blocks_entries_after_three_losers_or_two_r(env):
    assert runner_s.day_stopped(3, -1.5) and runner_s.day_stopped(0, -2.0) and runner_s.day_stopped(2, -1.99) is None
    rows = [{"event": "trade_closed", "day": str(DAY), "trade_id": f"t{i}", "R": r, "origin": "entry"}
            for i, r in enumerate([-0.5, 1.0, -0.4, -0.3, -0.2])]
    rows.append({"event": "trade_closed", "day": str(DAY), "trade_id": "t4", "R": -9.0, "origin": "entry"})  # a replay
    rows.append({"event": "trade_closed", "day": str(PREV), "trade_id": "old", "R": -5.0, "origin": "entry"})
    rows.append({"event": "trade_closed", "day": str(DAY), "trade_id": "orph", "R": None, "origin": "orphan"})
    assert runner_s.day_state(rows, DAY) == (3, pytest.approx(-0.4), 5)
    f = env / "live" / "smallcap_journal.jsonl"
    f.parent.mkdir(parents=True)
    f.write_text("".join(json.dumps(r) + "\n" for r in rows))
    b = session(tape_of({"ABC": day_rows(TO_TARGET)}))
    j = journal(env)
    assert one(j, "armed")["day_stop"] == "3 losers in a row"
    assert one(j, "signal_blocked")["blockers"] == ["day_stop:3 losers in a row"] and b.placed == []


# ---- the guards --------------------------------------------------------------------------------------------------------
def test_a_record_that_is_only_proposed_orders_nothing(env):
    runner_s.RECORD.write_text("# DEC-0066\n\n- **Status: PROPOSED on 2026-11-19.** It takes effect when a pull "
                               "request changes this line to ACCEPTED and the owner merges it.\n")
    b = session(tape_of({"ABC": day_rows(TO_TARGET)}))
    j = journal(env)
    assert one(j, "armed")["record_accepted"] is False
    assert one(j, "signal_blocked")["blockers"] == ["entries_off:DEC-0066 does not read ACCEPTED"]
    assert b.placed == []


def test_the_real_record_is_read_from_the_repository_and_says_what_its_status_line_says():
    import importlib
    real = importlib.reload(importlib.import_module("wt.live.runner_s")).RECORD
    assert real.name == "DEC-0066-robot-b-sleeve-s-paper-desk.md" and real.exists()
    status = next(line for line in real.read_text().splitlines() if line.startswith("- **Status:"))
    assert runner_s.accepted(real) is status.startswith("- **Status: ACCEPTED")


def test_an_unreadable_record_is_not_an_accepted_one(tmp_path):
    assert runner_s.accepted(tmp_path / "missing.md") is False
    f = tmp_path / "r.md"
    f.write_text("- **Status: PROPOSED on 2026-11-19.** It takes effect when ... ACCEPTED ...")
    assert runner_s.accepted(f) is False


@pytest.mark.parametrize("environ, why", [
    ({}, "not both set"),
    ({"APCA_S_KEY_ID": "PKS"}, "not both set"),
    ({"APCA_S_SECRET_KEY": "x", "APCA_API_KEY_ID": "PKQ", "APCA_API_SECRET_KEY": "y"}, "not both set"),   # no fallback
    ({"APCA_S_KEY_ID": "PKQ", "APCA_S_SECRET_KEY": "x", "APCA_API_KEY_ID": "PKQ"}, "sleeve Q's key"),
])
def test_it_refuses_to_start_without_its_own_keys(env, environ, why):
    assert why in runner_s.key_refusal(environ)
    with pytest.raises(SystemExit, match=why):
        session(tape_of({"ABC": QUIET_DAY}), environ=environ)
    assert [r["event"] for r in journal(env)] == ["refuse_to_start"]


def boom() -> str:
    raise RuntimeError("no network")


@pytest.mark.parametrize("own, q_account, why", [
    ("PA3SLEEVEQ", lambda: "PA3SLEEVEQ", "this is sleeve Q's account"),
    (None, lambda: "PA3SLEEVEQ", "sleeve S's account number could not be read"),
    ("PA3SLEEVES", boom, "sleeve Q's account number could not be read"),
    ("PA3SLEEVES", lambda: None, "sleeve Q's account number could not be read"),
])
def test_it_refuses_to_start_on_sleeve_qs_account_or_when_it_cannot_tell(env, own, q_account, why):
    with pytest.raises(SystemExit, match=why):
        session(tape_of({"ABC": QUIET_DAY}), account_number=own, q_account=q_account)
    assert [r["event"] for r in journal(env)] == ["refuse_to_start"]


def test_a_machine_with_no_keys_for_sleeve_q_needs_no_comparison():
    assert runner_s.account_refusal("PA3SLEEVES", None) is None
    assert runner_s.key_refusal({"APCA_S_KEY_ID": "PKS", "APCA_S_SECRET_KEY": "x"}) is None


def test_it_refuses_outside_paper_mode(env, monkeypatch):
    monkeypatch.setenv("MODE", "backtest")
    with pytest.raises(SystemExit, match="MODE must be 'paper'"):
        session(tape_of({"ABC": QUIET_DAY}))


def test_under_systemd_it_manages_exits_only(env, monkeypatch):
    monkeypatch.setenv("WT_HOST", "systemd")
    b = session(tape_of({"ABC": day_rows(TO_TARGET)}))
    assert any("no host job" in r for r in one(journal(env), "armed")["entries_off"]) and b.placed == []


def test_sleeve_qs_files_are_never_created_or_changed(env):
    live = env / "live"
    live.mkdir(parents=True)
    theirs = {"journal.jsonl": '{"event":"armed"}\n', f"plan_{DAY}.json": '{"symbol":"QQQM"}',
              "virtual_account.json": '{"equity": 612.5}'}
    for name, text in theirs.items():
        (live / name).write_text(text)
    before = {n: hashlib.sha256((live / n).read_bytes()).hexdigest() for n in theirs}
    session(tape_of({"ABC": day_rows(TO_TARGET)}))
    assert {n: hashlib.sha256((live / n).read_bytes()).hexdigest() for n in theirs} == before
    assert sorted(p.name for p in live.iterdir()) == sorted([*theirs, "smallcap_journal.jsonl"])
    assert one(journal(env), "trade_closed")["reason"] == "target"     # and it did trade, in its own files


def test_the_journal_never_carries_a_headline_or_a_setup_name(env):
    session(tape_of({"ABC": day_rows(TO_TARGET)}))
    text = (env / "live" / "smallcap_journal.jsonl").read_text()
    assert "headline" not in text and "REV-1" not in text and "reversal" not in text


# ---- positions the desk did not open --------------------------------------------------------------------------------
def test_a_position_no_plan_opened_is_adopted_stopped_and_sold(env):
    tape = tape_of({"ABC": QUIET_DAY})
    clock = ReplayClock(at(9, 25))
    b = BarFillBroker(clock, tape, SESSIONS)
    from wt.core.types import Position
    b.pos["ABC"] = Position("ABC", 5, 50.0)
    session(tape, broker=b)
    j = journal(env)
    assert one(j, "adopted_orphan")["qty"] == 5
    closed = one(j, "trade_closed")
    assert closed["origin"] == "orphan" and closed["R"] is None and closed["booked"] is False
    assert one(j, "session_end")["closed"] == 0                        # not the book's trade
    flat_and_clean(b)


def test_a_position_over_the_hard_caps_is_left_for_the_owner_and_does_not_stop_the_day(env):
    tape = tape_of({"ABC": day_rows(TO_TARGET), "BIG": QUIET_DAY})
    clock = ReplayClock(at(9, 25))
    b = BarFillBroker(clock, tape, SESSIONS)
    from wt.core.types import Position
    b.pos["BIG"] = Position("BIG", 5000, 50.0)
    session(tape, broker=b)
    j = journal(env)
    assert one(j, "position_over_caps")["symbol"] == "BIG" and not events(j, "adopted_orphan")
    assert one(j, "trade_closed")["reason"] == "target"                # the day's own trade ran as usual
    assert [(p.symbol, p.qty) for p in b.positions()] == [("BIG", 5000)]
    assert one(j, "END_OF_DAY_NOT_FLAT")["symbol"] == "BIG"


# ---- a plan resumed with something missing ----------------------------------------------------------------------------
def crash_then(env, tape: Tape, crash: dt.datetime, damage) -> BarFillBroker:
    clock = ReplayClock(at(9, 25), crash_at=crash)
    b = BarFillBroker(clock, tape, SESSIONS)
    with pytest.raises(ReplayCrash):
        runner_s.run(DAY, poll_s=10.0, broker=b, rest=ReplayREST(clock, tape, SESSIONS), now_fn=clock.now,
                     sleep_fn=clock.sleep, account_number="PA3SLEEVES", q_account=lambda: "PA3SLEEVEQ", environ=KEYS)
    (f,) = (env / "var" / "smallcap" / "plans").glob("*.json")
    plan = json.loads(f.read_text())
    damage(plan)
    f.write_text(json.dumps(plan))
    return b


def test_a_position_resumed_without_its_entry_price_is_still_flat_by_the_close(env):
    tape = tape_of({"ABC": day_rows([FILL, *UP])})                     # holds 41.70 all day: no target, no stop

    def lose_price(plan):
        plan["avg_entry"] = None

    b = crash_then(env, tape, at(10, 52), lose_price)
    session(tape, start=(10, 53), broker=b)
    closed = one(journal(env), "trade_closed")
    assert closed["reason"] == "eod_flatten" and closed["R"] is None and closed["booked"] is False
    assert closed["virtual"]["equity"] == 600.0                        # an unknown entry is never booked as a gain
    assert one(journal(env), "session_end")["realised_R"] == -1.0      # and it counts against the day as a loser
    flat_and_clean(b)


def test_an_entry_resumed_without_its_staged_terms_is_cancelled(env):
    quiet = [(40.75, 40.90, 40.70, 40.80, 30_000)] * 30                # never reaches the trigger
    tape = tape_of({"ABC": day_rows(quiet)})

    def lose_terms(plan):
        plan["log"] = [row for row in plan["log"] if row[0] != "staged"]

    b = crash_then(env, tape, at(10, 51), lose_terms)
    session(tape, start=(10, 52), broker=b)
    j = journal(env)
    assert events(j, "entry_cancelled")[-1]["why"] == "staged_unreadable" and not events(j, "entry_filled")
    flat_and_clean(b)


# ---- production wiring: the only path that picks real keys ----------------------------------------------------------
def test_production_builds_its_broker_and_data_client_from_sleeve_s_keys_only(env, monkeypatch):
    import wt.brokers.alpaca_paper as paper
    import wt.brokers.alpaca_read as read
    import wt.data.alpaca as data
    from wt.ops import locks
    built: dict[str, dict] = {}

    class FakeBroker:
        def __init__(self, **kw):
            built["broker"] = kw
            self.account_number = "PA3SLEEVES"

    class FakeREST:
        def __init__(self, **kw):
            built["rest"] = kw

    class FakeReader:
        def account_number(self):
            built["q_read"] = {}
            return "PA3SLEEVEQ"

    seen = {}
    monkeypatch.setattr(paper, "AlpacaPaperBroker", FakeBroker)
    monkeypatch.setattr(data, "AlpacaREST", FakeREST)
    monkeypatch.setattr(read, "AccountReader", FakeReader)
    monkeypatch.setattr(locks, "LOCK_DIR", env / "locks")
    monkeypatch.setattr(runner_s, "_session", lambda day, poll_s, broker, rest, clock, sleep: seen.update(
        broker=broker, rest=rest))
    environ = {"APCA_S_KEY_ID": "PKS-TEST", "APCA_S_SECRET_KEY": "s-secret", "APCA_API_KEY_ID": "PKQ-TEST",
               "APCA_API_SECRET_KEY": "q-secret"}
    runner_s.run(DAY, environ=environ, now_fn=lambda: at(9, 0), sleep_fn=lambda s: None)
    assert built["broker"] == {"key_id": "PKS-TEST", "secret": "s-secret"}
    assert built["rest"]["key_id"] == "PKS-TEST" and built["rest"]["secret"] == "s-secret"
    assert "q-secret" not in repr(built) and "PKQ-TEST" not in repr(built)      # sleeve Q's pair goes nowhere
    assert "q_read" in built and isinstance(seen["broker"], FakeBroker)         # and the accounts were compared


def test_production_refuses_when_the_two_accounts_are_one(env, monkeypatch):
    import wt.brokers.alpaca_paper as paper
    import wt.brokers.alpaca_read as read
    import wt.data.alpaca as data
    from wt.ops import locks

    class FakeBroker:
        def __init__(self, **kw):
            self.account_number = "PA3SAME"

    monkeypatch.setattr(paper, "AlpacaPaperBroker", FakeBroker)
    monkeypatch.setattr(data, "AlpacaREST", lambda **kw: object())
    monkeypatch.setattr(read, "AccountReader", lambda: type("R", (), {"account_number": lambda self: "PA3SAME"})())
    monkeypatch.setattr(locks, "LOCK_DIR", env / "locks")
    monkeypatch.setattr(runner_s, "_session", lambda *a: pytest.fail("the session must not start"))
    with pytest.raises(SystemExit, match="this is sleeve Q's account"):
        runner_s.run(DAY, environ={"APCA_S_KEY_ID": "PKS", "APCA_S_SECRET_KEY": "x", "APCA_API_KEY_ID": "PKQ",
                                   "APCA_API_SECRET_KEY": "y"}, now_fn=lambda: at(9, 0), sleep_fn=lambda s: None)


# ---- parity with the batch simulation (DEC-0066 section 5, item 3, the CI half) -----------------------------------------
def simulated(after: list[tuple]):
    """The registered batch path on the same day: the detector, then wt.backtest.engine.simulate with the reversal
    exit, sized from the same US$600 book. Returns the Trade, or None when the simulation takes no trade."""
    from wt.backtest.engine import Costs, simulate
    from wt.backtest.management import REGISTRY
    from wt.live import setups_live as sl
    from wt.signals.spec_setups import reversal_long

    bars = minute_bars(day_rows(after))
    prev = minute_bars(flat(390, 50.0, v=2_000, spread=0.05), day=str(PREV))
    ctx = sl.rev_context(prev, [390 * 2_000.0], np.linspace(1 / 390, 1.0, 390))
    sig = reversal_long(bars, ctx, start=66)                           # the name joined the universe at 10:35
    assert sig is not None
    costs = Costs(slippage_per_share=max(0.01, 0.02 / 2))              # the tape's spread is two cents
    return simulate(bars, sig, REGISTRY["REV5"](), costs, "ABC", str(DAY), risk_dollars=6.0, cash=600.0,
                    max_notional=600.0, flatten_idx=380)               # 15:50: ten minutes before the close


@pytest.mark.parametrize("name, after", [("target", TO_TARGET), ("stop", STOPPED), ("stagnation", STALLED),
                                         ("held to the close", HOLDS)])
def test_the_runner_and_the_batch_simulation_take_the_same_trade(env, name, after):
    sim = simulated(after)
    b = session(tape_of({"ABC": day_rows(after)}))
    j = journal(env)
    placed, closed = one(j, "entry_placed"), one(j, "trade_closed")
    entry_fill = b.fills[0]
    assert entry_fill.t == pd.Timestamp(sim.entry_time)                 # the same entry bar
    assert entry_fill.price == pytest.approx(sim.entry, abs=1e-9)       # the same entry, to the cent
    assert placed["stop"] == pytest.approx(sim.stop0, abs=1e-9)         # the same stop
    assert entry_fill.qty == sim.qty                                    # the same size from the same book
    assert closed["reason"] == sim.exits[-1][3]                         # the same exit reason
    assert len(sim.exits) == 1                                          # one exit: the whole position at once


def test_where_the_simulation_takes_no_trade_the_runner_has_no_fill(env):
    assert simulated(GAPPED) is None                                   # opened over the collar
    b = session(tape_of({"ABC": day_rows(GAPPED)}))
    assert [f for f in b.fills] == [] and not events(journal(env), "trade_closed")
