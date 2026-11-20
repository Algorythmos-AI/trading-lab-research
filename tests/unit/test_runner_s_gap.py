"""wt.live.runner_s in Gap Hunter mode (HYP-0071, DEC-0068), replayed on constructed days. No market data is read.

The runner's own loop, selection, gates and order manager run unchanged; the replay harness (wt.live.replay) supplies
the clock, the data as of the clock and a broker that fills from the bars and quotes. Each traded day is also run
through the registered batch path (the detector, then wt.backtest.engine.simulate with the gap exit), and the two
must take the same trade.
"""
from __future__ import annotations

import datetime as dt
import json

import pandas as pd
import pytest
from gap_days import pool_row, write_pool
from spec_bars import minute_bars
from test_runner_s import (DAY, KEYS, PREV, SESSIONS, at, events, flat_and_clean, journal, one)
from test_runner_s import env as env  # noqa: F401 — the shared state fixture

from wt.backtest.engine import Costs, simulate
from wt.backtest.management import REGISTRY
from wt.live import runner_s
from wt.live import setups_live as sl
from wt.live.replay import BarFillBroker, ReplayClock, ReplayCrash, ReplayREST, Tape
from wt.signals.spec_setups import continuation_5m, gg_level_break, orb_ladder, red_to_green

BATCH = {"e1": gg_level_break, "e2": orb_ladder, "e3": continuation_5m, "e4": red_to_green}
OPEN = (5.00, 5.05, 4.95, 5.02, 150_000)                       # the 09:30 bar: green, high 5.05, low 4.95
# the gap entries' windows end at 11:00, so these days close at noon: the same code path, a third of the polls
HALF = {**SESSIONS, DAY: ("09:30", "12:00")}
FLATTEN = 140                                                  # 11:50, ten minutes before that close


def day_of(rows: list[tuple]) -> list[tuple]:
    last = rows[-1][3]
    return rows + [(last, last + 0.01, last - 0.01, last, 20_000)] * (390 - len(rows))


def quotes_for(bars: pd.DataFrame, spread: float = 0.02) -> pd.DataFrame:
    """A quote every five seconds: around the open for the first half of each minute, around the close after."""
    rows = []
    for r in bars.itertuples():
        for k in range(12):
            mid = r.o if k < 6 else r.c
            rows.append({"t": r.t + pd.Timedelta(seconds=5 * k), "bp": mid - spread / 2, "ap": mid + spread / 2})
    return pd.DataFrame(rows)


def tape_of(rows: list[tuple], spread: float = 0.02, more: dict[str, list[tuple]] | None = None) -> Tape:
    bars, quotes = {}, {}
    for sym, r in {"ABC": rows, **(more or {})}.items():
        today = minute_bars(day_of(r))
        prev = minute_bars(day_of([(5.0, 5.01, 4.99, 5.0, 2_000)]), day=str(PREV))
        bars[sym] = pd.concat([prev, today], ignore_index=True)
        quotes[sym] = quotes_for(today, spread)
    return Tape(bars, quotes)


@pytest.fixture
def gap(env, monkeypatch):  # noqa: F811
    """Gap Hunter switched on for the test, its pool folders in the test's own directory, and a pool whose primary
    is ABC (rank 2: XYZ, with less relative volume)."""
    monkeypatch.setattr(runner_s, "switched_on", lambda: frozenset({"HYP-0071"}))
    monkeypatch.setattr(runner_s, "POOL_DIR", env / "candidates")
    monkeypatch.setattr(runner_s, "PM_BARS_DIR", env / "pm_bars")
    write_pool(env, pool_row("ABC"), pool_row("XYZ", rvol_pm=3.0))
    return env


def session(tape: Tape, start=(9, 25), crash_at=None, broker=None, hook=None, **kw):
    clock = ReplayClock(at(*start), crash_at=crash_at)
    if broker is None:
        broker = BarFillBroker(clock, tape, HALF)
    else:                                                             # a restart: the same broker, a new clock
        broker._rc = clock
        clock.hooks.insert(0, broker.advance)
    if hook is not None:
        clock.hooks.append(lambda now: hook(now, broker))
    args = {"account_number": "PA3SLEEVES", "q_account": lambda: "PA3SLEEVEQ", "environ": KEYS, **kw}
    runner_s.run(DAY, poll_s=10.0, broker=broker, rest=ReplayREST(clock, tape, HALF), now_fn=clock.now,
                 sleep_fn=clock.sleep, **args)
    return broker


def crashed(tape: Tape, when: dt.datetime) -> BarFillBroker:
    clock = ReplayClock(at(9, 25), crash_at=when)
    b = BarFillBroker(clock, tape, HALF)
    with pytest.raises(ReplayCrash):
        runner_s.run(DAY, poll_s=10.0, broker=b, rest=ReplayREST(clock, tape, HALF), now_fn=clock.now,
                     sleep_fn=clock.sleep, account_number="PA3SLEEVES", q_account=lambda: "PA3SLEEVEQ", environ=KEYS)
    return b


def simulated(code: str, rows: list[tuple], ctx: dict | None = None):
    """The registered batch path on the same day, sized from the same US$600 book: (signal, trade or None)."""
    bars = minute_bars(day_of(rows))
    sig = BATCH[code](bars, {"overhead": [99.0], **(ctx or {})})
    assert sig is not None
    return sig, simulate(bars, sig, REGISTRY["WT"](), Costs(slippage_per_share=0.01), "ABC", str(DAY),
                         risk_dollars=6.0, cash=600.0, max_notional=600.0, flatten_idx=FLATTEN)


def same_trade(root, b: BarFillBroker, sim, code: str) -> dict:
    """The runner's trade against the simulation's: entry bar, entry price, stop, size, and every exit's reason."""
    j = journal(root)
    filled, closed = one(j, "entry_filled"), one(j, "trade_closed")
    entry = next(f for f in b.fills if f.side == "buy")
    assert entry.t == pd.Timestamp(sim.entry_time)
    assert entry.price == pytest.approx(sim.entry, abs=1e-9) and entry.qty == sim.qty
    assert closed["stop"] == pytest.approx(sim.stop0, abs=1e-9) and closed["code"] == code == filled["code"]
    assert closed["trial"] == "HYP-0071" and closed["booked"] is True
    reasons = [r["reason"] for r in events(j, "partial_filled")] + [closed["reason"]]
    assert reasons == [e[3] for e in sim.exits], (reasons, sim.exits)
    sold = [f for f in b.fills if f.side == "sell"]
    assert sum(f.qty for f in sold) == sim.qty
    flat_and_clean(b)
    return closed


# ---- days -------------------------------------------------------------------------------------------------------------------
# the 09:31 bar breaks the 09:30 high (e2, the one-minute leg): trigger 5.06, stop 4.94, fill 5.07, first target 5.33
ORB = [OPEN, (5.03, 5.10, 5.01, 5.08, 80_000)]
RUN = ORB + [(5.08, 5.20, 5.07, 5.18, 60_000), (5.18, 5.30, 5.17, 5.28, 60_000), (5.28, 5.40, 5.27, 5.38, 60_000),
             (5.38, 5.50, 5.37, 5.48, 60_000), (5.48, 5.60, 5.47, 5.58, 60_000), (5.58, 5.62, 5.55, 5.60, 60_000),
             (5.60, 5.64, 5.56, 5.60, 60_000), (5.60, 5.62, 5.55, 5.58, 60_000)]
TRAILED = RUN + [(5.58, 5.59, 5.30, 5.32, 60_000)]                    # 09:40 falls through the 09:35-09:40 low
EMA_EXIT = RUN + [(5.58, 5.59, 5.44, 5.45, 60_000)] + [(5.45, 5.46, 5.40, 5.41, 60_000)] * 4 + \
    [(5.41, 5.50, 5.40, 5.48, 60_000)] * 3                            # 09:40-09:45 closes under EMA9, over the stop
STOPPED = ORB + [(5.08, 5.09, 4.90, 4.92, 60_000)]
STALLED = ORB + [(5.08, 5.10, 5.05, 5.08, 60_000)] * 6
NO_ENTRY = [OPEN] + [(5.02, 5.04, 5.00, 5.02, 30_000)] * 100          # nothing reaches a trigger all morning
GAPPED = [OPEN, (5.12, 5.20, 5.10, 5.15, 80_000)]                     # 09:31 opens over the collar: reached, no fill


# ---- the lifecycle -----------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("name, rows, last", [("trailed stop", TRAILED, "runner_prior_5m_low"),
                                              ("EMA", EMA_EXIT, "runner_5m_close_below_ema9")])
def test_a_day_that_takes_the_first_target_then_leaves_on_the_runner_exit(gap, name, rows, last):
    sig, sim = simulated("e2", rows)
    assert [e[3] for e in sim.exits] == ["partial_t1", last]
    b = session(tape_of(rows))
    closed = same_trade(gap, b, sim, "e2")
    j = journal(gap)
    placed = events(j, "entry_placed")[0]
    assert (placed["trigger"], placed["limit"], placed["stop"], placed["code"]) == (5.06, 5.07, 4.94, "e2")
    assert one(j, "gap_primary")["symbol"] == "ABC" and one(j, "gap_day_done")["reason"] == "traded"
    part = one(j, "partial_filled")
    assert part["qty"] == sim.qty // 2 and part["limit"] == 5.33      # the target's own price, on a bid at or over it
    moves = events(j, "stop_moved")
    assert moves[0]["why"] == "breakeven" and moves[0]["stop"] == 5.07
    # R is measured against the stop the trade entered with, not the one the exit moved it to
    assert closed["final_stop"] > closed["entry"] > closed["stop"] and closed["partial_qty"] == sim.qty // 2
    assert closed["R"] == pytest.approx((closed["exit"] - closed["entry"]) / (closed["entry"] - 4.94))
    assert closed["R"] > 1.5
    end = one(j, "session_end")
    assert end["entries"] == 1 and end["closed"] == 1 and end["realised_R"] > 1.5 and end["day_stop"] is None
    va = json.loads((gap / "var" / "smallcap" / "virtual_account.json").read_text())
    assert va["equity"] > 600 and len(va["recorded_trades"]) == 1


def test_a_stop_out(gap):
    _, sim = simulated("e2", STOPPED)
    b = session(tape_of(STOPPED))
    closed = same_trade(gap, b, sim, "e2")
    assert closed["reason"] == "stop" and -1.2 < closed["R"] < -1.0 and closed["partial_qty"] == 0


def test_a_stagnation_exit(gap):
    _, sim = simulated("e2", STALLED)
    b = session(tape_of(STALLED))
    closed = same_trade(gap, b, sim, "e2")
    assert closed["reason"] == "time_stop_5m" and abs(closed["R"]) < 0.3
    exit_t = [f for f in b.fills if f.side == "sell"][-1].t.tz_convert("America/New_York")
    assert (exit_t.hour, exit_t.minute) == (9, 36)                     # asked at the close of the 09:35 bar


def test_no_valid_entry_all_morning_is_no_trade_and_no_other_name(gap):
    xyz = [OPEN, (5.03, 5.10, 5.01, 5.08, 80_000)] + RUN[2:]           # rank 2 breaks out; it is not the primary
    b = session(tape_of(NO_ENTRY, more={"XYZ": xyz}))
    j = journal(gap)
    assert not events(j, "entry_filled") and not events(j, "trade_closed")
    assert one(j, "gap_day_done")["reason"] == "no_signal"
    assert {b.orders[c].symbol for c in b.placed} <= {"ABC"}           # orders may have rested; none in another name
    assert all(r["symbol"] == "ABC" for r in events(j, "entry_placed"))
    flat_and_clean(b)


def test_an_order_reached_without_a_fill_spends_the_day(gap):
    sig, sim = simulated("e2", GAPPED + RUN[2:])
    assert sim is None                                                 # the engine: gapped through the collar
    b = session(tape_of(GAPPED + RUN[2:]))
    j = journal(gap)
    done = one(j, "gap_day_done")
    assert done["reason"] == "no_fill" and done["code"] == "e2"
    assert len(events(j, "entry_placed")) == 1 and not events(j, "entry_filled")
    assert b.fills == []
    flat_and_clean(b)


# ---- each registered entry through the runner, against the batch path (DEC-0068, "before it is switched on", item 3) ------
LEVEL = [OPEN] + [(5.02, 5.04, 5.00, 5.02, 30_000)] * 3               # e1 rests over the 5.10 pre-market high
LEVEL_RUN = [(5.18, 5.30, 5.17, 5.28, 60_000), (5.28, 5.40, 5.27, 5.38, 60_000), (5.38, 5.52, 5.37, 5.50, 60_000),
             (5.50, 5.60, 5.45, 5.58, 60_000), (5.58, 5.62, 5.55, 5.60, 60_000), (5.60, 5.61, 5.20, 5.22, 60_000)]
RED = (5.00, 5.05, 4.95, 4.98, 150_000)                               # a 09:30 bar that closes under its open
TURN = [RED, (4.98, 5.00, 4.85, 4.90, 50_000), (4.90, 4.95, 4.84, 4.94, 50_000), (4.94, 5.08, 4.93, 5.06, 60_000)] + \
    [(5.06, 5.08, 5.03, 5.05, 30_000)] * 8


@pytest.mark.parametrize("volume, reasons", [(400_000, None), (40_000, ["breakout_volume_fail"])])
def test_the_level_entry_takes_the_batch_trade_with_and_without_breakout_volume(gap, volume, reasons):
    write_pool(gap, pool_row("ABC", pm_high=5.10), pool_row("XYZ", rvol_pm=3.0))
    rows = LEVEL + [(5.03, 5.20, 5.02, 5.18, volume)] + LEVEL_RUN
    sig, sim = simulated("e1", rows, {"pm_high": 5.10})
    assert sim.tags["breakout_volume_ok"] == (reasons is None)
    assert reasons is None or [e[3] for e in sim.exits] == reasons
    b = session(tape_of(rows))
    closed = same_trade(gap, b, sim, "e1")
    j = journal(gap)
    placed = one(j, "entry_placed")                                    # one order rested from 09:31 until it filled
    assert (placed["trigger"], placed["stop"], placed["limit"]) == (5.11, 4.94, 5.12)
    assert closed["entry"] == pytest.approx(5.12)


def test_the_red_to_green_entry_is_repriced_each_minute_and_takes_the_batch_trade(gap):
    sig, sim = simulated("e4", TURN)
    assert (sig.trigger, sig.stop, sig.bar_index) == (5.01, 4.83, 2)
    b = session(tape_of(TURN))
    same_trade(gap, b, sim, "e4")
    placed = events(journal(gap), "entry_placed")
    # 09:31: two rules ask for the same order and the lower rule number names it; then e4 at each new bar
    assert [(p["code"], p["trigger"], p["stop"]) for p in placed] == [("e2", 5.06, 4.94), ("e4", 5.01, 4.84),
                                                                      ("e4", 5.01, 4.83)]
    assert [p["attempt"] for p in placed] == [1, 2, 3] and len(b.placed) == len(set(b.placed))
    cancelled = events(journal(gap), "entry_cancelled")
    assert [c["why"] for c in cancelled] == ["expired", "expired"]     # each ended with its minute, before the next rested
    assert sum(1 for c in b.placed if b.orders[c].side == "buy") == 3


@pytest.mark.parametrize("what, volume", [("fill", 300_000), ("fill", 4_000), ("stall", 300_000), ("stopped", 300_000)])
def test_the_five_minute_entry_takes_the_batch_trade(gap, what, volume):
    from gap_days import PM, after, flag_setup
    setup, trigger, stop = flag_setup()
    rows = setup + after(what, trigger, stop, volume)
    pm = PM.assign(symbol="ABC")
    write_pool(gap, pool_row("ABC", overhead_levels=[4.10]), pool_row("XYZ", rvol_pm=3.0), pm=pm)
    ctx = {"pm_bars": PM, "overhead": [4.10]}                          # 4.10 overhead: the opening-range rules have no room
    sig, sim = simulated("e3", rows, ctx)
    assert sig.setup.startswith("GG-3") and sim is not None
    b = session(tape_of(rows))
    same_trade(gap, b, sim, "e3")
    assert one(journal(gap), "gap_primary")["pm_bars"] == 60


def test_the_five_minute_entry_that_is_never_reached_is_no_trade(gap):
    from gap_days import PM, after, flag_setup
    setup, trigger, stop = flag_setup()
    write_pool(gap, pool_row("ABC", overhead_levels=[4.10]), pm=PM.assign(symbol="ABC"))
    b = session(tape_of(setup + after("never", trigger, stop)))
    j = journal(gap)
    placed = one(j, "entry_placed")
    assert placed["code"] == "e3" and (placed["trigger"], placed["stop"]) == (4.53, 4.40)
    assert one(j, "gap_day_done")["reason"] == "no_signal" and b.fills == []
    flat_and_clean(b)


# ---- entries that must not happen ----------------------------------------------------------------------------------------------
def test_without_the_days_pool_there_is_no_primary_and_no_order(gap):
    (gap / "candidates" / f"{DAY}.parquet").unlink()
    b = session(tape_of(RUN))
    j = journal(gap)
    chosen = one(j, "gap_primary")
    assert chosen["symbol"] is None and chosen["why"] == "pool_missing"
    assert b.placed == [] and one(j, "session_end")["primary"] is False


@pytest.mark.parametrize("damage, why", [
    (lambda root: write_pool(root, pool_row("ABC", date=PREV)), "pool_stale"),
    (lambda root: write_pool(root, {k: v for k, v in pool_row("ABC").items() if k != "date"}), "pool_stale"),
    (lambda root: (root / "candidates" / f"{DAY}.parquet").write_text("not a parquet file"), "pool_unreadable"),
    (lambda root: write_pool(root, pool_row("ABC", float_shares=90_000_000.0)), "no_name_passed"),
    (lambda root: write_pool(root, pool_row("ABC"), pm=minute_bars([OPEN], start_et="09:30").assign(symbol="ABC")),
     "pm_bars_stale"),
])
def test_a_pool_that_is_not_this_sessions_or_cannot_be_read_selects_nothing(gap, damage, why):
    damage(gap)
    b = session(tape_of(RUN))
    assert one(journal(gap), "gap_primary")["why"] == why and b.placed == []


def test_a_primary_whose_spread_is_too_wide_is_not_ordered(gap):
    b = session(tape_of(RUN, spread=0.08))
    j = journal(gap)
    blocked = events(j, "signal_blocked")
    assert blocked and all(r["blockers"][0] == "spread" and r["dead"] for r in blocked)
    assert b.placed == [] and one(j, "gap_day_done")["reason"] == "missed"


def test_a_trigger_reached_while_nothing_rested_still_spends_the_day(gap):
    tape = tape_of(RUN)
    q = tape.quotes["ABC"]
    wide = q.t < pd.Timestamp(at(9, 31, 30))                           # eight cents wide until 09:31:30, two after
    tape.quotes["ABC"] = q.assign(ap=q.ap.where(~wide, q.bp + 0.08))
    b = session(tape)
    j = journal(gap)
    assert one(j, "signal_blocked")["blockers"][0] == "spread"
    done = one(j, "gap_day_done")
    assert done["reason"] == "missed" and done["code"] == "e2"
    assert b.placed == []                                              # the later rules' orders are never sent


def test_one_trade_a_day_a_later_signal_is_not_traded(gap):
    # stopped out at 09:32; then the first five minutes' high breaks at 09:36: the ladder's second leg on a fresh day
    again = STOPPED + [(4.92, 4.99, 4.90, 4.98, 60_000), (4.98, 5.09, 4.97, 5.08, 60_000),
                       (5.08, 5.10, 5.05, 5.09, 60_000), (5.09, 5.30, 5.08, 5.28, 60_000)]
    b = session(tape_of(again))
    j = journal(gap)
    assert one(j, "trade_closed")["reason"] == "stop" and len(events(j, "entry_placed")) == 1
    assert sum(1 for c in b.placed if b.orders[c].side == "buy") == 1
    assert one(j, "gap_day_done")["reason"] == "traded"
    flat_and_clean(b)


def test_the_day_that_stopped_out_offers_a_second_order_that_only_the_rule_refuses():
    # after the stop-out the rules themselves still have a valid order that the tape reaches: one trade a day is
    # what keeps the runner from sending it (the test above)
    again = STOPPED + [(4.92, 4.99, 4.90, 4.98, 60_000), (4.98, 5.09, 4.97, 5.08, 60_000),
                       (5.08, 5.10, 5.05, 5.09, 60_000), (5.09, 5.30, 5.08, 5.28, 60_000)]
    bars = minute_bars(day_of(again))
    red = sl.gap_e4(bars.iloc[:4], {"overhead": [99.0]}, 574)          # 09:34: bars have closed under the open
    assert red is not None and red.trigger == 5.01                     # an order a second attempt would rest ...
    assert float(bars.h.iloc[4]) >= 5.01                               # ... and the 09:34 bar reaches it


def test_the_day_stop_blocks_the_entry(gap):
    rows = [{"event": "trade_closed", "day": str(DAY), "trade_id": f"t{i}", "R": r, "origin": "entry"}
            for i, r in enumerate([-0.5, -0.4, -0.3])]
    f = gap / "live" / "smallcap_journal.jsonl"
    f.parent.mkdir(parents=True)
    f.write_text("".join(json.dumps(r) + "\n" for r in rows))
    b = session(tape_of(RUN))
    j = journal(gap)
    assert one(j, "armed")["day_stop"] == "3 losers in a row"
    assert events(j, "signal_blocked")[0]["blockers"] == ["day_stop:3 losers in a row"] and b.placed == []


def test_the_order_budget_ends_repricing_before_the_days_cap(gap, monkeypatch):
    monkeypatch.setattr(runner_s, "GAP_ENTRY_ORDERS_MAX", 2)
    b = session(tape_of(TURN))
    j = journal(gap)
    done = one(j, "gap_day_done")
    assert done["reason"] == "order_budget" and done["orders"] == 2
    assert len(events(j, "entry_placed")) == 2 and b.fills == []
    flat_and_clean(b)


@pytest.mark.parametrize("on, said", [(frozenset(), "HYP-0070 is not switched on"),
                                      (frozenset({"HYP-0070", "HYP-0071"}), "both switched on")])
def test_gap_hunter_orders_nothing_unless_it_alone_is_switched_on(gap, monkeypatch, on, said):
    monkeypatch.setattr(runner_s, "switched_on", lambda: on)
    b = session(tape_of(RUN))
    j = journal(gap)
    assert any(said in r for r in one(j, "armed")["entries_off"]) and b.placed == []
    assert not events(j, "entry_placed") and not events(j, "trade_closed")
    if on:                                                             # it ran as Gap Hunter, with every entry refused
        assert events(j, "signal_blocked")[0]["blockers"][0].startswith("entries_off:HYP-0071 and HYP-0070")


def test_the_trial_a_session_runs_is_the_one_that_is_switched_on():
    assert runner_s.session_trial(frozenset({"HYP-0071"})) == ("HYP-0071", None)
    assert runner_s.session_trial(frozenset({"HYP-0070", "HYP-0099"})) == ("HYP-0070", None)
    trial, why = runner_s.session_trial(frozenset())
    assert trial == "HYP-0070" and "not switched on" in why
    trial, why = runner_s.session_trial(frozenset({"HYP-0070", "HYP-0071"}))
    assert trial == "HYP-0071" and "both switched on" in why


def test_the_kill_file_cancels_the_resting_entry_and_blocks_the_next(gap):
    write_pool(gap, pool_row("ABC", pm_high=5.10))

    def raise_kill(now, b):
        if now >= at(9, 32, 15):
            (gap / "var" / "smallcap" / "KILL").touch()

    b = session(tape_of(LEVEL + [(5.03, 5.20, 5.02, 5.18, 400_000)] + LEVEL_RUN), hook=raise_kill)
    j = journal(gap)
    assert one(j, "entry_cancelled")["why"] == "kill_file" and b.fills == []
    assert "kill_file" in events(j, "signal_blocked")[0]["blockers"]
    flat_and_clean(b)


# ---- a crash, and the restart ------------------------------------------------------------------------------------------------
def test_a_crash_while_the_entry_rests_resumes_the_same_order(gap):
    write_pool(gap, pool_row("ABC", pm_high=5.10), pool_row("XYZ", rvol_pm=3.0))
    rows = LEVEL + [(5.03, 5.20, 5.02, 5.18, 400_000)] + LEVEL_RUN
    _, sim = simulated("e1", rows, {"pm_high": 5.10})
    tape = tape_of(rows)
    b = crashed(tape, at(9, 32, 30))
    assert len(b.open_orders()) == 1 and b.positions() == []           # died with the entry resting
    session(tape, start=(9, 33), broker=b)
    same_trade(gap, b, sim, "e1")
    j = journal(gap)
    assert len(events(j, "entry_placed")) == 1 and len(events(j, "gap_primary")) == 1
    assert events(j, "armed")[-1]["resumed_plan"] is not None
    assert len(b.placed) == len(set(b.placed)) and sum(1 for c in b.placed if b.orders[c].side == "buy") == 1


def test_a_crash_in_the_position_before_the_first_target_resumes_the_exit(gap):
    _, sim = simulated("e2", TRAILED)
    tape = tape_of(TRAILED)
    b = crashed(tape, at(9, 32, 30))
    assert [p.qty for p in b.positions()] == [sim.qty] and len(b.own_sells("ABC")) == 1
    (gap / "candidates" / f"{DAY}.parquet").unlink()                   # the pool is gone: the exit needs none of it
    session(tape, start=(9, 33), broker=b)
    closed = same_trade(gap, b, sim, "e2")
    assert closed["reason"] == "runner_prior_5m_low" and len(b.placed) == len(set(b.placed))
    assert len(events(journal(gap), "entry_placed")) == 1


def test_a_crash_after_the_first_target_resumes_the_trailed_stop_and_books_once(gap):
    _, sim = simulated("e2", TRAILED)
    tape = tape_of(TRAILED)
    b = crashed(tape, at(9, 36, 30))
    assert [p.qty for p in b.positions()] == [sim.qty - sim.qty // 2]  # half is sold, the rest is stopped at breakeven
    assert [o.stop_price for o in b.own_sells("ABC")] == [5.07]
    session(tape, start=(9, 37), broker=b)
    closed = same_trade(gap, b, sim, "e2")
    assert closed["reason"] == "runner_prior_5m_low" and closed["R"] > 1.5
    j = journal(gap)
    assert len(events(j, "partial_filled")) == 1 and len(events(j, "entry_placed")) == 1
    assert len(b.placed) == len(set(b.placed))
    va = json.loads((gap / "var" / "smallcap" / "virtual_account.json").read_text())
    assert len(va["recorded_trades"]) == 1


def test_a_restart_after_the_days_attempt_takes_no_second_one(gap):
    tape = tape_of(GAPPED + RUN[2:])
    b = crashed(tape, at(9, 33, 30))                                   # after the 09:31 order was reached unfilled
    session(tape, start=(9, 34), broker=b)
    j = journal(gap)
    assert len(events(j, "gap_day_done")) == 1 and len(events(j, "entry_placed")) == 1 and b.fills == []
    assert events(j, "session_end")[-1]["gap_done"] == "no_fill"


def test_a_first_start_after_the_trigger_was_reached_is_a_missed_day(gap):
    b = session(tape_of(RUN), start=(9, 40))                           # nothing rested at 09:31: the attempt is spent
    j = journal(gap)
    assert one(j, "gap_day_done")["reason"] == "missed" and b.placed == []


# ---- what the journal and the plan files may carry ----------------------------------------------------------------------------
def test_the_journal_names_rules_by_code_and_never_carries_a_setup_or_a_headline(gap):
    from gap_days import PM, after, flag_setup
    setup, trigger, stop = flag_setup()
    write_pool(gap, pool_row("ABC", overhead_levels=[4.10], catalyst_status="qualifying", catalyst_category="earnings",
                             catalyst_score=0.8, headlines_n=2, catalyst_headline="Example Corp beats"),
               pm=PM.assign(symbol="ABC"))
    session(tape_of(setup + after("fill", trigger, stop)))
    raw = (gap / "live" / "smallcap_journal.jsonl").read_text()
    assert '"code": "e3"' in raw and '"trial": "HYP-0071"' in raw
    # every word a row carries, without the hash chain (a hash is hex: it can spell "abcd" by chance)
    text = "\n".join(json.dumps({k: v for k, v in json.loads(line).items() if k != "prev_sha256"})
                     for line in raw.splitlines())
    for word in ("headline", "catalyst", "earnings", "Example Corp", "GG-", "bull_flag", "flat_top", "abcd", "orb",
                 "red_to_green", "continuation", "level_break", "pm_pattern", "pm_high"):
        assert word not in text, word
    plans = "".join(f.read_text() for f in (gap / "var" / "smallcap" / "plans").glob("*.json"))
    assert "GG-" not in plans and "bull_flag" not in plans and "headline" not in plans


def test_a_gap_plan_keeps_its_own_fields_across_a_restart(gap):
    p = runner_s.GapPlan(date=str(DAY), strategy="S", symbol="ABC", qty=5, trigger=5.06, limit=5.07, stop=5.07,
                         target=0.0, attempt=3, seq=runner_s.plan_seq(3), stop0=4.94, partial_qty=2,
                         partial_ids=["x"], code="e2", signal_t="2024-03-01T14:30:00+00:00",
                         expires="2024-03-01T09:32:00-05:00", spread=0.02, wt={"partial_done": True})
    store = runner_s.Store()
    store.save(p)
    (back,) = store.load_all()
    assert isinstance(back, runner_s.GapPlan) and back == p and back.initial_stop == 4.94
    staged = runner_s.staged_of(back)
    assert (staged.trigger, staged.stop, staged.expires_at.minute) == (5.06, 4.94, 32)
    assert runner_s.staged_of(runner_s.GapPlan(date=str(DAY), strategy="S", symbol="ABC", qty=1, trigger=1.0,
                                               limit=1.1, stop=0.9, target=0.0)) is None


def test_a_restart_between_repriced_orders_numbers_the_next_plan_after_the_days_last(gap):
    _, sim = simulated("e4", TURN)
    tape = tape_of(TURN)
    b = crashed(tape, at(9, 32, 40))                                   # two entry orders sent; the second is resting
    assert sum(1 for c in b.placed if b.orders[c].side == "buy") == 2
    session(tape, start=(9, 33), broker=b)
    same_trade(gap, b, sim, "e4")
    j = journal(gap)
    assert [p["attempt"] for p in events(j, "entry_placed")] == [1, 2, 3] and not events(j, "entry_not_placed")
    assert len(b.placed) == len(set(b.placed))                         # no order id was sent twice


def test_an_entry_stopped_on_the_bar_it_filled_on_is_the_days_trade(gap):
    # 09:31 breaks the high and falls through the stop in the same minute: in and out before the next poll
    rows = [OPEN, (5.03, 5.10, 4.90, 4.92, 80_000)] + RUN[2:]
    _, sim = simulated("e2", rows)
    assert [e[3] for e in sim.exits] == ["stop"] and sim.exits[0][0] == sim.entry_time
    b = session(tape_of(rows))
    closed = same_trade(gap, b, sim, "e2")
    j = journal(gap)
    assert closed["reason"] == "stop" and one(j, "gap_day_done")["reason"] == "traded"   # a trade, not a missed order
    assert len(events(j, "entry_placed")) == 1                         # and the later rules' orders are never sent


def test_a_filled_plan_of_today_is_the_days_trade_even_when_the_journal_lost_it(gap):
    # the plan file says today's trade happened and closed; the journal row that says so was never written
    p = runner_s.GapPlan(date=str(DAY), strategy="S", symbol="ABC", qty=10, trigger=5.06, limit=5.07, stop=4.94,
                         target=0.0, attempt=1, seq=runner_s.plan_seq(1) + 3, filled_qty=10, avg_entry=5.07,
                         exit_fill_price=4.93, exit_reason="stop", state="closed", entry_counted=True, recorded=True,
                         code="e2", signal_t="2024-03-01T14:30:00+00:00", expires="2024-03-01T09:32:00-05:00")
    runner_s.Store().save(p)
    b = session(tape_of(NO_ENTRY[:1] + RUN[2:]), start=(9, 34))        # a tape on which a fresh day would order
    j = journal(gap)
    assert b.placed == [] and not events(j, "entry_placed")
    assert one(j, "session_end")["gap_done"] == "traded"


def test_a_resting_order_gives_way_to_a_lower_trigger_after_a_confirmed_cancel(gap):
    # e1 rests over a pre-market pattern's level from 09:32; 09:32 closes under the open, so e4 has an order under it.
    # (A quiet bar follows the entry bar: the replay broker fills any stop placed in the minute after an entry
    # against the entry bar's low, which is right for the first stop and wrong for a stop moved to breakeven then.)
    from wt.signals.patterns import Pattern
    level = {"pm_pattern": "bull_flag", "pm_pattern_trigger": 5.10, "pm_pattern_stop": 4.90}
    ctx = {"pm_pattern": Pattern("bull_flag", 5.10, 4.90, -1, 5.10)}
    write_pool(gap, pool_row("ABC", **level), pool_row("XYZ", rvol_pm=3.0))
    rows = [OPEN, (5.02, 5.04, 5.00, 5.02, 50_000), (5.02, 5.03, 4.96, 4.98, 50_000), (4.98, 5.03, 4.97, 5.02, 50_000),
            (5.02, 5.20, 5.01, 5.18, 400_000), (5.18, 5.20, 5.15, 5.18, 60_000)] + LEVEL_RUN
    sig, sim = simulated("e4", rows, ctx)
    assert (sig.trigger, sig.stop, sig.bar_index) == (5.04, 4.94, 3)
    other, _ = simulated("e1", rows, ctx)
    assert (other.trigger, other.stop) == (5.11, 4.91)                 # the same 09:34 bar would have filled e1 too
    b = session(tape_of(rows))
    same_trade(gap, b, sim, "e4")                                      # the lower trigger is the day's trade
    j = journal(gap)
    assert [(p["code"], p["trigger"]) for p in events(j, "entry_placed")] == \
        [("e2", 5.06), ("e1", 5.11), ("e4", 5.04), ("e4", 5.04)]
    assert [(c["code"], c["why"], c["state"]) for c in events(j, "entry_cancelled")] == \
        [("e2", "expired", "aborted"), ("e1", "replaced", "aborted"), ("e4", "expired", "aborted")]
    buys = [c for c in b.placed if b.orders[c].side == "buy"]
    assert len(buys) == 4 and len(b.placed) == len(set(b.placed))
    # one open buy at a time: each was cancelled before the next was accepted
    assert [b.orders[c].status.name for c in buys] == ["CANCELED", "CANCELED", "CANCELED", "FILLED"]


def test_nothing_new_rests_while_the_old_orders_cancel_is_not_confirmed(gap):
    # the day on which e1 gives way to e4, with a broker that loses the first cancel of e1's order
    from wt.signals.patterns import Pattern
    level = {"pm_pattern": "bull_flag", "pm_pattern_trigger": 5.10, "pm_pattern_stop": 4.90}
    write_pool(gap, pool_row("ABC", **level), pool_row("XYZ", rvol_pm=3.0))
    rows = [OPEN, (5.02, 5.04, 5.00, 5.02, 50_000), (5.02, 5.03, 4.96, 4.98, 50_000), (4.98, 5.03, 4.97, 5.02, 50_000),
            (5.02, 5.20, 5.01, 5.18, 400_000), (5.18, 5.20, 5.15, 5.18, 60_000)] + LEVEL_RUN
    _, sim = simulated("e4", rows, {"pm_pattern": Pattern("bull_flag", 5.10, 4.90, -1, 5.10)})
    lost, most = [], [0]

    def hook(now, b):
        if not hasattr(b, "real_cancel"):
            b.real_cancel = b.cancel

            def cancel(cid):
                o = b.orders.get(cid)
                if o is not None and o.side == "buy" and o.stop_price == 5.11 and not lost:
                    lost.append(cid)                                   # the cancel never reaches the broker
                    return
                b.real_cancel(cid)
            b.cancel = cancel
        most[0] = max(most[0], sum(1 for o in b.open_orders() if o.side == "buy"))

    b = session(tape_of(rows), hook=hook)
    assert len(lost) == 1 and most[0] == 1                             # never two open buys, at any tick of the clock
    same_trade(gap, b, sim, "e4")
    j = journal(gap)
    cancelled = [(c["code"], c["why"], c["state"]) for c in events(j, "entry_cancelled")]
    assert cancelled[:3] == [("e2", "expired", "aborted"), ("e1", "replaced", "entry_working"),
                             ("e1", "replaced", "aborted")]
    placed = events(j, "entry_placed")
    assert [p["code"] for p in placed] == ["e2", "e1", "e4", "e4"] and not events(j, "entry_not_placed")
    assert j.index(placed[2]) > j.index(events(j, "entry_cancelled")[2])    # placed only after the confirmed cancel
