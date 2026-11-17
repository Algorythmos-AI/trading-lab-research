"""EXP-0037 (DEC-0054): the three variant switches in the dry run, the match, the verdict and the session list."""
from __future__ import annotations

import datetime as dt
import importlib.util
import json
import random
import subprocess
import sys
from pathlib import Path

import pytest

from test_options_clone_dry_run import CFG, MARKS, RISK, SYM, minutes, obars
from test_options_clone_session import DAY, at
from wt.options import dryrun, exp0037, regime, setups, variants
from wt.options.regime import NEW_YORK, Tape
from wt.options.setups import Mark, Signal

ROOT = Path(__file__).resolve().parents[2]
RCFG = CFG["setups"]["retest"]
G = CFG["gates"]


def _driver():
    spec = importlib.util.spec_from_file_location("exp0037_replay", ROOT / "scripts" / "exp0037_replay.py")
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def bars_from(closes, lows=None, highs=None, start="10:00"):
    t0 = at(start)
    out = []
    for i, c in enumerate(closes):
        lo = lows[i] if lows else c - 0.1
        hi = highs[i] if highs else c + 0.1
        s = t0 + dt.timedelta(minutes=2 * i)
        out.append(regime.Bar(s, s + dt.timedelta(minutes=2), c, hi, lo, c, 1000.0, 1000.0 * c))
    return out


def tape(close, vwap):
    return Tape(close, vwap, close, close, 1.0, close + 1, close - 1, 0.5, "range")


def run(variant=None, path=lambda t: 1.40):
    return dryrun.replay_day(DAY, minutes(), MARKS, lambda s: obars(path) if s == SYM else [], CFG, RISK, [], 1.0,
                             variant=variant)


# ---------------------------------------------------------------- the switch off is the control
def test_an_unknown_variant_is_refused():
    with pytest.raises(ValueError):
        run("loosen_everything")


@pytest.mark.parametrize("variant", [None, *variants.VARIANTS])
def test_where_no_variant_applies_every_variant_takes_the_controls_trades(variant):
    path = (lambda t: 1.40 if t < at("10:29") else 2.20)
    assert run(variant, path).trades == run(None, path).trades


def test_each_trade_records_its_signal_bar_and_level():
    (tr,) = run().trades
    assert tr["signal_bar"] and tr["level"] == "PDH"


def test_check_first_the_control_equals_the_pre_switch_engine():
    drv = _driver()
    try:
        old = drv.pre_switch_engine()
    except subprocess.CalledProcessError:
        pytest.skip("the pre-switch commit is not in this clone's history")
    for path in (lambda t: 1.40, lambda t: 1.40 if t < at("10:29") else 2.20, lambda t: 1.40 if t < at("10:28") else 1.0):
        for mult in (1.0, 2.0):
            a = old.replay_day(DAY, minutes(), MARKS, lambda s, p=path: obars(p) if s == SYM else [], CFG, RISK, [], mult)
            b = dryrun.replay_day(DAY, minutes(), MARKS, lambda s, p=path: obars(p) if s == SYM else [], CFG, RISK, [], mult)
            assert a.trades and exp0037.same_as_pre_switch(a.trades, b.trades)
            assert a.left_out == b.left_out and a.pnl == b.pnl
    sys.modules.pop("wt.options._dryrun_pre_switch", None)


# ---------------------------------------------------------------- HYP-0062 room open sky
def test_open_sky_reads_a_measured_level_only_when_no_mark_lies_beyond():
    sig = Signal("retest", "call", Mark("PWH", 100.0), 100.5, 99.5, "10:30")
    marks = [Mark("PWH", 100.0), Mark("PDL", 95.0)]
    g = setups.gate(sig, tape(100.5, 100.0), None, marks, 5.0, G)
    assert not g.checks["room"][0] and not g.checks["reach"][0]          # the control refuses it
    g2, lvl = variants.open_sky(g, sig, marks, 5.0, G)
    assert lvl == pytest.approx(100.5 + 2.0 * 1.0) and g2.checks["room"][0] and g2.checks["reach"][0]
    _, lvl = variants.open_sky(setups.gate(sig, tape(100.5, 100.0), None, marks, 1.5, G), sig, marks, 1.5, G)
    g3, _ = variants.open_sky(setups.gate(sig, tape(100.5, 100.0), None, marks, 1.5, G), sig, marks, 1.5, G)
    assert g3.checks["room"][0] and not g3.checks["reach"][0]            # 2.0 away, 1.5 left in the day
    beyond = [*marks, Mark("PMH", 101.0)]
    g4 = setups.gate(sig, tape(100.5, 100.0), None, beyond, 5.0, G)
    before = g4.as_json()
    g5, lvl = variants.open_sky(g4, sig, beyond, 5.0, G)
    assert lvl is None and g5.as_json() == before


def test_open_sky_for_a_put_measures_downward():
    sig = Signal("retest", "put", Mark("PWL", 100.0), 99.5, 100.5, "10:30")
    assert variants.measured_level(sig, [Mark("PWL", 100.0), Mark("PDH", 104.0)], G) == pytest.approx(97.5)


# ---------------------------------------------------------------- HYP-0064 rejection, SPY trend only
def test_spy_trend_reads_only_spy_for_a_rejection():
    sig = Signal("rejection", "put", Mark("PWH", 100.0, True), 99.8, 100.4, "10:30")
    name_above = tape(99.8, 99.0)                    # the name above its VWAP: the control's trend refuses a put
    g = setups.gate(sig, name_above, tape(500.0, 501.0), [], 5.0, G)
    assert not g.checks["trend"][0]
    assert variants.spy_trend(g, sig, name_above, tape(500.0, 501.0)).checks["trend"][0]       # SPY below its VWAP
    g = setups.gate(sig, name_above, tape(502.0, 501.0), [], 5.0, G)
    assert not variants.spy_trend(g, sig, name_above, tape(502.0, 501.0)).checks["trend"][0]   # SPY against a put


def test_spy_trend_leaves_a_retest_alone():
    sig = Signal("retest", "put", Mark("PWH", 100.0), 99.8, 100.4, "10:30")
    g = setups.gate(sig, tape(99.8, 99.0), tape(500.0, 501.0), [], 5.0, G)
    assert variants.spy_trend(g, sig, tape(99.8, 99.0), tape(500.0, 501.0)).as_json() == g.as_json()


# ---------------------------------------------------------------- HYP-0063 retest, free confirmation
def test_retest_parts_fires_exactly_when_the_controls_retest_does():
    rnd = random.Random(20261163)
    m = Mark("L", 100.0)
    seen = 0
    for _ in range(4000):
        closes = [100.0 + rnd.choice([-0.6, -0.3, 0.2, 0.4, 0.7, 1.0]) * rnd.random() for _ in range(rnd.randint(3, 12))]
        lows = [c - rnd.random() * 1.2 for c in closes]
        highs = [c + rnd.random() * 1.2 for c in closes]
        bars = bars_from(closes, lows, highs)
        ctrl = {(s.side, s.level.price) for s in setups.retest(bars, [m], 1.0, RCFG)}
        mine = {(side, m.price) for side in ("call", "put") if variants.retest_parts(bars, m, side, 1.0, RCFG)}
        assert ctrl == mine
        seen += bool(ctrl)
    assert seen > 20


def test_retest_parts_finds_the_break_and_the_touch():
    assert variants.retest_parts(confirm_bars(), Mark("L", 100.0), "call", 1.0, RCFG) == (1, 2)
    assert variants.retest_parts(confirm_bars(), Mark("L", 100.0), "put", 1.0, RCFG) is None


def confirm_bars():
    # break above 100 at bar 1, touch at bar 2 (low within 1 ATR), first confirmation at bar 3 (close > 100.3)
    return bars_from([99.8, 100.4, 100.3, 100.6], lows=[99.6, 100.1, 99.9, 100.4])


def test_a_carry_waits_then_confirms_on_a_later_close_beyond_the_touch():
    b = confirm_bars()
    (sig,) = setups.retest(b, [Mark("L", 100.0)], 1.0, RCFG)
    c = variants.carry_of("SPY", sig, b, 1.0, RCFG)
    assert c is not None and c.ref == pytest.approx(100.3) and c.first_end == b[-1].end
    assert variants.carry_state(c, b, RCFG) == "wait"
    b2 = [*b, *bars_from([100.2], start="10:08")]                     # above the level, not beyond the touch close
    assert variants.carry_state(c, b2, RCFG) == "wait"
    b3 = [*b2, *bars_from([100.5], start="10:10")]
    assert variants.carry_state(c, b3, RCFG) == "confirm"
    s = variants.carried_signal(c, b3, 0.8, RCFG)
    assert s.entry == pytest.approx(100.5) and s.invalidation == pytest.approx(100.0 - 0.8) and s.bar_end == "10:12"


def test_a_carry_dies_on_a_close_back_through_the_level_or_after_the_window():
    b = confirm_bars()
    (sig,) = setups.retest(b, [Mark("L", 100.0)], 1.0, RCFG)
    c = variants.carry_of("SPY", sig, b, 1.0, RCFG)
    assert variants.carry_state(c, [*b, *bars_from([99.9, 100.8], start="10:08")], RCFG) == "dead"
    later = [*b, *bars_from([100.2] * 6 + [100.9], start="10:08")]   # the 7th bar after the first confirmation
    assert variants.carry_state(c, later[:-1], RCFG) == "wait"
    assert variants.carry_state(c, later, RCFG) == "dead"


def test_carry_step_keeps_a_passing_block_and_drops_a_lasting_one():
    b = confirm_bars()
    tp = Tape(b[-1].c, 99.0, b[-1].c, b[-1].c, 1.0, 101.0, 99.0, 0.5, "range")
    marks = [Mark("L", 100.0)]
    carries: dict[str, list[variants.Carry]] = {}
    dryrun._carry_step(carries, "SPY", b, marks, tp, CFG, set(), lasting=False, passing=True)
    assert len(carries["SPY"]) == 1                                   # a position open: carried
    other: dict[str, list[variants.Carry]] = {}
    dryrun._carry_step(other, "SPY", b, marks, tp, CFG, set(), lasting=True, passing=True)
    assert other["SPY"] == []                                          # the day's count used up: not carried
    read: dict[str, list[variants.Carry]] = {}
    dryrun._carry_step(read, "SPY", b, marks, tp, CFG, {("SPY", "call", 100.0)}, lasting=False, passing=True)
    assert read["SPY"] == []                                           # the control read it: nothing to carry
    b3 = [*b, *bars_from([100.2, 100.5], start="10:08")]
    tp3 = Tape(100.5, 99.0, 100.5, 100.5, 1.0, 101.0, 99.0, 0.5, "range")
    blocked = {"SPY": list(carries["SPY"])}
    dryrun._carry_step(blocked, "SPY", b3, marks, tp3, CFG, set(), lasting=True, passing=False)
    assert blocked["SPY"] == []                                        # its confirmation met a lasting block
    free = {"SPY": list(carries["SPY"])}
    (got,) = dryrun._carried(free, "SPY", b3, marks, 1.0, RCFG, [])
    assert got.setup == "retest" and got.bar_end == "10:12"
    assert len(free["SPY"]) == 1           # kept until its signal is read: an entry at the same close leaves it waiting
    away = {"SPY": list(carries["SPY"])}
    assert dryrun._carried(away, "SPY", b3, [], 1.0, RCFG, []) == [] and len(away["SPY"]) == 1   # not near: waits


# ---------------------------------------------------------------- the match and the verdict
def tr(session, rop, bar="10:30", setup="retest"):
    return {"session": session, "root": "SPY", "setup": setup, "side": "call", "signal_bar": bar, "rop": rop}


def test_groups_split_added_and_displaced():
    control = [tr("2026-12-01", 0.1), tr("2026-12-02", -0.2)]
    variant = [tr("2026-12-01", 0.1), tr("2026-12-02", 0.3, bar="10:40")]
    added, displaced = exp0037.groups(control, variant)
    assert [t["signal_bar"] for t in added] == ["10:40"] and [t["session"] for t in displaced] == ["2026-12-02"]


def test_too_few_added_trades_gives_no_verdict():
    v = exp0037.verdict("room_open_sky", [], [tr("2026-12-01", 0.5)], [], [tr("2026-12-01", 0.4)])
    assert v["verdict"] == "too_few" and v["range_1x"] is None and v["hypothesis"] == "HYP-0062"


def _many(rop, n_sessions=20, per=2, bar="10:40"):
    return [tr(f"2026-12-{d + 1:02d}", rop, bar=f"{bar[:3]}{40 + i}") for d in range(n_sessions) for i in range(per)]


def test_supported_needs_all_three_tests():
    ctrl = _many(0.0, bar="11:00")
    good = ctrl + _many(0.2)
    v = exp0037.verdict("retest_free_confirm", ctrl, good, ctrl, ctrl + _many(0.1))
    assert v["verdict"] == "supported" and v["added"] == 40 and v["added_sessions"] == 20 and v["range_1x"][0] > 0
    assert v["seed"] == 20261163
    worse_2x = exp0037.verdict("retest_free_confirm", ctrl, good, ctrl, ctrl + _many(-0.1))
    assert worse_2x["verdict"] == "falsified" and not worse_2x["tests"]["mean_2x_above_0"]
    rich = _many(0.5, bar="11:00")
    displacing = _many(0.2)                    # a variant that loses every one of the control's trades
    lost = exp0037.verdict("retest_free_confirm", rich, displacing, rich, displacing)
    assert lost["verdict"] == "falsified" and not lost["tests"]["total_not_below_control"] and lost["displaced"] == 40


def test_the_session_range_resamples_sessions_with_the_frozen_generator_and_interval():
    import numpy as np
    rop = [0.1, -0.2, 0.3, 0.05, 0.4, -0.1]
    days = ["a", "a", "b", "c", "c", "d"]
    sums, counts = np.array([-0.1, 0.3, 0.45, -0.1]), np.array([2, 1, 2, 1])
    pick = np.random.Generator(np.random.PCG64(20261162)).integers(0, 4, size=(5000, 4))
    boots = sums[pick].sum(axis=1) / counts[pick].sum(axis=1)
    want = np.percentile(boots, [0.8333, 99.1667], method="linear")
    assert exp0037.session_range(rop, days, 20261162) == pytest.approx(tuple(want), abs=1e-12)
    assert exp0037.INTERVAL == (0.8333, 99.1667) and exp0037.RESAMPLES == 5000
    assert exp0037.SEEDS == {"room_open_sky": 20261162, "retest_free_confirm": 20261163,
                             "rejection_spy_trend": 20261164}


def test_the_session_range_is_fixed_by_its_seed():
    rop = [0.1, -0.2, 0.3, 0.05, 0.4, -0.1]
    days = ["a", "a", "b", "c", "c", "d"]
    assert exp0037.session_range(rop, days, 1) == exp0037.session_range(rop, days, 1)
    lo, hi = exp0037.session_range(rop, days, 1)
    assert lo < sum(rop) / len(rop) < hi


def test_end_to_end_a_retest_blocked_by_an_open_position_is_taken_on_the_next_confirmation():
    # QQQ and SPY on the same tape and marks: both retests confirm at 10:26; QQQ (first in order) is entered, so
    # SPY's confirmation meets an open position. QQQ's contract hits its target at 10:27, and the 10:28 bar closes
    # beyond the touch bar's close again.
    one = minutes()["SPY"]
    mins = {"QQQ": one, "SPY": one}
    marks = {"QQQ": MARKS["SPY"], "SPY": MARKS["SPY"]}
    q_sym, s_sym = "QQQ261019C00581000", SYM
    up = obars(lambda t: 1.40 if t < at("10:27") else 2.20)
    flat = obars(lambda t: 1.40)

    def ob(s):
        return up if s == q_sym else flat if s == s_sym else []
    ctrl = dryrun.replay_day(DAY, mins, marks, ob, CFG, RISK, [], 1.0)
    var = dryrun.replay_day(DAY, mins, marks, ob, CFG, RISK, [], 1.0, variant="retest_free_confirm")
    assert [(t["root"], t["signal_bar"]) for t in ctrl.trades] == [("QQQ", "10:26")]
    assert ctrl.trades[0]["exit_reason"] == "target"
    assert [(t["root"], t["signal_bar"]) for t in var.trades] == [("QQQ", "10:26"), ("SPY", "10:28")]
    assert var.trades[0] == ctrl.trades[0]
    added, displaced = exp0037.groups([{**t, "session": "d"} for t in ctrl.trades],
                                      [{**t, "session": "d"} for t in var.trades])
    assert [t["root"] for t in added] == ["SPY"] and displaced == []


# ---------------------------------------------------------------- the session list and the host job
DEC_ACCEPTED = "# DEC-0054\n\n- **Status: ACCEPTED on 2026-11-20.** By the owner.\n"


def test_acceptance_is_read_from_the_status_line():
    assert exp0037.accepted_on("- **Status: PROPOSED on 2026-11-17.**") is None
    assert exp0037.accepted_on(DEC_ACCEPTED) == dt.date(2026, 11, 20)


def test_due_starts_after_acceptance_skips_non_sessions_and_stops_at_40():
    weekday = (lambda d: d.weekday() < 5)
    got = exp0037.due(dt.date(2026, 11, 20), dt.date(2026, 11, 25), weekday, [])
    assert got == [dt.date(2026, 11, 23), dt.date(2026, 11, 24), dt.date(2026, 11, 25)]
    full = exp0037.due(dt.date(2026, 11, 20), dt.date(2027, 4, 1), weekday, [])
    assert len(full) == 40 and exp0037.complete(full, dt.date(2027, 1, 30))
    assert exp0037.due(dt.date(2026, 11, 20), dt.date(2027, 4, 1), weekday, full) == []
    late = exp0037.due(dt.date(2027, 4, 20), dt.date(2027, 5, 10), weekday, [])
    assert late[-1] == dt.date(2027, 4, 30)
    assert not exp0037.complete(late, dt.date(2027, 4, 30)) and exp0037.complete(late, dt.date(2027, 5, 1))
    assert not exp0037.complete([], dt.date(2027, 5, 1))


def test_finished_through_waits_for_the_close():
    drv = _driver()
    assert drv.finished_through(dt.datetime(2026, 11, 25, 16, 0, tzinfo=NEW_YORK)) == dt.date(2026, 11, 24)
    assert drv.finished_through(dt.datetime(2026, 11, 25, 16, 20, tzinfo=NEW_YORK)) == dt.date(2026, 11, 25)


def test_the_host_job_is_scheduled_after_the_close_and_is_research_only():
    from wt.ops.schedule import JOBS
    j = JOBS["exp0037"]
    assert j.et == "Mon..Fri 17:15" and j.command == ("scripts/exp0037_replay.py", "nightly")
    assert j.mode == "backtest" and not j.trading


class FakeData:
    """Bars for SPY and QQQ on any day asked for; no contract trades. Counts the calls."""

    def __init__(self, empty=False):
        self.calls = 0
        self.empty = empty

    def bars(self, symbols, tf, start, end, adjustment=None):
        import pandas as pd
        self.calls += 1
        d = dt.date.fromisoformat(start[:10])
        rows = []
        if tf == "1Min" and not self.empty:
            t0 = dt.datetime.combine(d, dt.time(9, 30), NEW_YORK)
            for sym, base in (("SPY", 580.0), ("QQQ", 500.0)):
                for i in range(5):
                    rows.append({"symbol": sym, "t": pd.Timestamp(t0 + dt.timedelta(minutes=i)).tz_convert("UTC"),
                                 "o": base, "h": base + 0.5, "l": base - 0.5, "c": base, "v": 100.0, "vw": base})
        if tf == "1Day":
            for sym, base in (("SPY", 580.0), ("QQQ", 500.0)):
                rows.append({"symbol": sym, "t": pd.Timestamp(dt.datetime(2026, 1, 2, tzinfo=dt.UTC)),
                             "o": base, "h": base + 1, "l": base - 1, "c": base, "v": 1e6, "vw": base})
        return pd.DataFrame(rows, columns=["symbol", "t", "o", "h", "l", "c", "v", "vw"])

    def get(self, url, params):
        self.calls += 1
        return {"bars": {}}


def paths(tmp_path, accepted="2027-04-26"):
    dec = tmp_path / "dec.md"
    dec.write_text(f"- **Status: ACCEPTED on {accepted}.**\n" if accepted else "- **Status: PROPOSED on 2026-11-17.**\n")
    return dec, tmp_path / "data", tmp_path / "state"


def test_nightly_does_nothing_until_accepted(tmp_path):
    drv = _driver()
    dec, cache, out = paths(tmp_path, accepted=None)
    fake = FakeData()
    got = drv.nightly(lambda: fake, dt.datetime(2027, 4, 28, 17, 15, tzinfo=NEW_YORK), dec, cache, out)
    assert got.startswith("waiting") and fake.calls == 0 and not out.exists()


def test_nightly_fetches_and_hashes_each_closed_session_once(tmp_path):
    drv = _driver()
    dec, cache, out = paths(tmp_path)
    fake = FakeData()
    got = drv.nightly(lambda: fake, dt.datetime(2027, 4, 28, 17, 15, tzinfo=NEW_YORK), dec, cache, out)
    hashes = drv.load_hashes(out)
    assert sorted(hashes) == ["2027-04-27", "2027-04-28"] and "listed 2" in got
    assert hashes["2027-04-27"] == drv.session_hash(dt.date(2027, 4, 27), cache)
    assert not (out / "result.json").exists()
    calls = fake.calls
    drv.nightly(lambda: fake, dt.datetime(2027, 4, 28, 17, 30, tzinfo=NEW_YORK), dec, cache, out)
    assert fake.calls == calls                                         # nothing new: nothing fetched
    drv.nightly(lambda: fake, dt.datetime(2027, 4, 30, 17, 15, tzinfo=NEW_YORK), dec, cache, out)
    assert sorted(drv.load_hashes(out)) == ["2027-04-27", "2027-04-28", "2027-04-29", "2027-04-30"]   # caught up


def test_a_session_with_no_bars_yet_is_not_saved_and_is_retried(tmp_path):
    drv = _driver()
    dec, cache, out = paths(tmp_path)
    with pytest.raises(RuntimeError):
        drv.nightly(lambda: FakeData(empty=True), dt.datetime(2027, 4, 27, 17, 15, tzinfo=NEW_YORK), dec, cache, out)
    assert drv.load_hashes(out) == {} and not drv.fetched(dt.date(2027, 4, 27), cache)
    drv.nightly(lambda: FakeData(), dt.datetime(2027, 4, 27, 17, 15, tzinfo=NEW_YORK), dec, cache, out)
    assert list(drv.load_hashes(out)) == ["2027-04-27"]


def test_the_evening_the_list_closes_the_replay_runs_once_and_pages(tmp_path, monkeypatch):
    drv = _driver()
    dec, cache, out = paths(tmp_path)
    try:
        drv.pre_switch_engine()
    except subprocess.CalledProcessError:
        pytest.skip("the pre-switch commit is not in this clone's history")
    paged = []
    monkeypatch.setattr(drv, "page_done", lambda n, v: paged.append((n, v)))
    got = drv.nightly(FakeData, dt.datetime(2027, 5, 3, 17, 15, tzinfo=NEW_YORK), dec, cache, out)
    assert got == "ran: 4 sessions" and paged == [(4, ["too_few"] * 3)]
    res = json.loads((out / "result.json").read_text())
    assert res["check_first"] == "passed" and set(res["verdicts"]) == set(variants.VARIANTS)
    assert (out / "report.md").exists()
    fake = FakeData()
    assert drv.nightly(lambda: fake, dt.datetime(2027, 5, 4, 17, 15, tzinfo=NEW_YORK), dec, cache, out).startswith("done")
    assert fake.calls == 0 and len(paged) == 1                         # run once
    sys.modules.pop("wt.options._dryrun_pre_switch", None)


def test_a_changed_input_stops_the_replay(tmp_path, monkeypatch):
    drv = _driver()
    dec, cache, out = paths(tmp_path)
    drv.nightly(FakeData, dt.datetime(2027, 4, 30, 17, 15, tzinfo=NEW_YORK), dec, cache, out)
    (cache / "2027-04-28" / "minutes.json").write_text("{}")
    monkeypatch.setattr(drv, "page_done", lambda n, v: None)
    with pytest.raises(SystemExit, match="input hash differs"):
        drv.nightly(FakeData, dt.datetime(2027, 5, 3, 17, 15, tzinfo=NEW_YORK), dec, cache, out)
    assert not (out / "result.json").exists()


def test_one_root_without_bars_is_not_saved(tmp_path):
    drv = _driver()
    dec, cache, out = paths(tmp_path)

    class HalfEmpty(FakeData):
        def bars(self, symbols, tf, start, end, adjustment=None):
            df = super().bars(symbols, tf, start, end, adjustment)
            return df[df.symbol != "QQQ"] if tf == "1Min" else df
    with pytest.raises(RuntimeError, match="fetch failed"):
        drv.nightly(HalfEmpty, dt.datetime(2027, 4, 27, 17, 15, tzinfo=NEW_YORK), dec, cache, out)
    assert drv.load_hashes(out) == {}


def test_a_session_that_fails_three_evenings_is_skipped_and_the_rest_carry_on(tmp_path, monkeypatch):
    drv = _driver()
    dec, cache, out = paths(tmp_path)

    class BadDay(FakeData):
        def bars(self, symbols, tf, start, end, adjustment=None):
            if tf == "1Min" and start.startswith("2027-04-27"):
                return super().bars(symbols, tf, start, end, adjustment).iloc[0:0]
            return super().bars(symbols, tf, start, end, adjustment)
    for evening in (28, 29):
        with pytest.raises(RuntimeError, match="2027-04-27"):
            drv.nightly(BadDay, dt.datetime(2027, 4, evening, 17, 15, tzinfo=NEW_YORK), dec, cache, out)
        assert "2027-04-28" in drv.load_hashes(out)                    # the next session is not held up
    drv.nightly(BadDay, dt.datetime(2027, 4, 30, 17, 15, tzinfo=NEW_YORK), dec, cache, out)
    assert drv.load_hashes(out)["2027-04-27"] == drv.SKIPPED
    monkeypatch.setattr(drv, "page_done", lambda n, v: None)
    try:
        drv.pre_switch_engine()
    except subprocess.CalledProcessError:
        pytest.skip("the pre-switch commit is not in this clone's history")
    monkeypatch.setattr(drv, "engine_changed", lambda: [])
    drv.nightly(BadDay, dt.datetime(2027, 5, 3, 17, 15, tzinfo=NEW_YORK), dec, cache, out)
    res = json.loads((out / "result.json").read_text())
    assert res["skipped"] == ["2027-04-27"] and "2027-04-27" not in res["sessions"]
    sys.modules.pop("wt.options._dryrun_pre_switch", None)


def test_a_changed_engine_stops_the_replay(tmp_path, monkeypatch):
    drv = _driver()
    dec, cache, out = paths(tmp_path)
    monkeypatch.setattr(drv, "engine_changed", lambda: ["src/wt/options/setups.py"])
    with pytest.raises(SystemExit, match="engine differs"):
        drv.nightly(FakeData, dt.datetime(2027, 5, 3, 17, 15, tzinfo=NEW_YORK), dec, cache, out)
    assert not (out / "result.json").exists()


def test_the_engine_files_here_equal_the_merged_replay_code():
    drv = _driver()
    try:
        subprocess.run(["git", "-C", str(ROOT), "cat-file", "-e", drv.ENGINE_COMMIT], check=True, capture_output=True)
    except subprocess.CalledProcessError:
        pytest.skip("the engine commit is not in this clone's history")
    assert drv.engine_changed() == []
