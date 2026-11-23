"""wt.risk.execution_stops (DEC-0073 section 1): the five execution stops, read from journal rows. Constructed rows
only; the runner's own use of them is in test_runner_s_xstops.py."""
from __future__ import annotations

import json

import pytest

from wt.ops import control
from wt.risk import execution_stops as xs
from wt.risk.virtual_account import STOP_RULE_PREFIX, StateError, VirtualAccount

RULES = xs.Rules(decision="DEC-0073", unprotected_polls=2, stop_slip_r=0.5, stop_slips=2)
DAY = "2026-11-24"


def row(event: str, ts: str = f"{DAY}T15:00:00+00:00", **kw) -> dict:
    return {"ts": ts, "event": event, **kw}


def closed(tid: str, fill: float | None, price: float | None = 9.80, entry: float = 10.0, stop: float = 9.80) -> dict:
    extra = {} if fill is None else {"stop_fill": fill, "stop_price": price}
    return row("trade_closed", trade_id=tid, entry=entry, stop=stop, exit=9.0, origin="entry", **extra)


def test_the_real_config_carries_the_records_numbers():
    r = xs.load("S")
    assert r == RULES


@pytest.mark.parametrize("bad", [{"decision": "0073"}, {"unprotected_polls": 0}, {"stop_slip_r": 0}])
def test_a_bad_config_is_refused(tmp_path, bad):
    raw = {"decision": "DEC-0073", "unprotected_polls": 2, "stop_slip_r": 0.5, "stop_slips": 2, **bad}
    (tmp_path / "risk.yaml").write_text(json.dumps({"S": {"execution_stops": raw}}))
    with pytest.raises(ValueError):
        xs.load("S", tmp_path / "risk.yaml")


def test_no_rows_no_stop():
    assert xs.evaluate(RULES, []) is None


@pytest.mark.parametrize("r", [row("short_position", symbol="AAA", qty=-3),
                               row("END_OF_DAY_NOT_FLAT", symbol="AAA", qty=-3, short=True)])
def test_x1_a_short_at_any_poll_or_at_the_close(r):
    x = xs.evaluate(RULES, [r])
    assert x is not None and x.code == "X1" and "AAA" not in x.detail


def test_x2_only_a_position_with_no_stop_after_the_close():
    assert xs.evaluate(RULES, [row("END_OF_DAY_NOT_FLAT", symbol="AAA", qty=5, protected=True)]) is None   # halted, on its stop
    assert xs.evaluate(RULES, [row("END_OF_DAY_NOT_FLAT", symbol="AAA", qty=5, protected=None)]) is None   # unread, or left for the owner
    assert xs.evaluate(RULES, [row("END_OF_DAY_NOT_FLAT", error="could not verify flat")]) is None
    x = xs.evaluate(RULES, [row("END_OF_DAY_NOT_FLAT", symbol="AAA", qty=5, protected=False)])
    assert x is not None and x.code == "X2"


def test_x3_at_the_second_poll_in_a_row():
    assert xs.evaluate(RULES, [row("unprotected", trade_id="t", polls=1)]) is None
    x = xs.evaluate(RULES, [row("unprotected", trade_id="t", polls=1), row("unprotected", trade_id="t", polls=2)])
    assert x is not None and x.code == "X3"


def gap_day(primary: str | None, *fills: tuple[str, str]) -> list[dict]:
    return [row("gap_primary", day=DAY, symbol=primary),
            *(row("entry_filled", trade_id=tid, symbol=sym) for tid, sym in fills)]


def test_x4_the_primary_once_a_day_is_on_rule():
    rows = gap_day("AAA", (f"{DAY}-S-AAA-0", "AAA"), (f"{DAY}-S-AAA-0", "AAA"))   # one trade, journaled twice
    assert xs.evaluate(RULES, rows) is None


@pytest.mark.parametrize("rows, said", [
    (gap_day("AAA", (f"{DAY}-S-BBB-0", "BBB")), "other than the day's primary"),
    (gap_day(None, (f"{DAY}-S-BBB-0", "BBB")), "no primary"),
    (gap_day("AAA", (f"{DAY}-S-AAA-0", "AAA"), (f"{DAY}-S-AAA-1", "AAA")), "2 entries"),
])
def test_x4_another_name_no_primary_or_a_second_entry(rows, said):
    x = xs.evaluate(RULES, rows)
    assert x is not None and x.code == "X4" and said in x.detail and "BBB" not in x.detail


def test_x4_reads_only_gap_hunter_days_and_never_an_orphan():
    other_day = [row("entry_filled", trade_id="2026-11-25-S-AAA-0", symbol="AAA"),
                 row("entry_filled", trade_id="2026-11-25-S-BBB-1", symbol="BBB")]   # the reversal rule's day
    orphan = row("entry_filled", trade_id=f"{DAY}-S-ZZZ-0-orphan", symbol="ZZZ")
    assert xs.evaluate(RULES, [*gap_day("AAA", (f"{DAY}-S-AAA-0", "AAA")), orphan, *other_day]) is None


def test_x5_two_stop_fills_over_half_an_r_from_the_stop_orders_own_fill():
    assert xs.evaluate(RULES, [closed("a", 9.65)]) is None                            # 0.75R: one only
    assert xs.evaluate(RULES, [closed("a", 9.65), closed("b", 9.71)]) is None         # 0.45R: under the line
    assert xs.evaluate(RULES, [closed("a", 9.65), closed("a", 9.65)]) is None         # the same trade twice
    assert xs.evaluate(RULES, [closed("a", 9.65), closed("b", None)]) is None         # not a stop exit
    x = xs.evaluate(RULES, [closed("a", 9.65), closed("b", 9.60)])
    assert x is not None and x.code == "X5" and x.detail.startswith("2 stop exits")
    trailed = closed("c", 10.05, price=10.30)                                         # a trailed stop, 1.25R under it
    assert xs.slips([closed("a", 9.65), trailed], RULES) == 2


def test_rows_before_the_last_reset_do_not_count_and_a_new_fault_does():
    old = row("short_position", ts=f"{DAY}T15:00:00+00:00", symbol="AAA", qty=-1)
    history = [{"at": f"{DAY}T20:00:00+00:00", "reason": "stop rule X1: the account was short (DEC-0073)"},
               {"at": f"{DAY}T21:00:00+00:00", "reason": "stop rule cum_r: -6R (DEC-0066)"}]   # another rule's reset
    since = xs.last_reset(history, "DEC-0073")
    assert since == f"{DAY}T20:00:00+00:00"
    assert xs.evaluate(RULES, [old], since) is None
    new = row("unprotected", ts=f"{DAY}T20:30:00+00:00", trade_id="t", polls=2)
    x = xs.evaluate(RULES, [old, new], since)
    assert x is not None and x.code == "X3"


def test_the_latch_reason_names_the_record_and_only_a_new_record_clears_it(tmp_path):
    x = xs.evaluate(RULES, [row("short_position", symbol="AAA", qty=-1)])
    assert x is not None
    why = xs.latch_reason(x, RULES)
    assert why.startswith(STOP_RULE_PREFIX) and why.endswith("(DEC-0073)") and "AAA" not in why
    va = VirtualAccount()
    va.latch(why)
    path = tmp_path / "virtual_account.json"
    va.save(path)
    code, msg = control.reset_latch_s("cleared, see DEC-0073", va_path=path, lock_root=tmp_path / "locks")
    assert code == 4 and "nothing was changed" in msg and VirtualAccount.load(path).latched
    with pytest.raises(StateError):
        from wt.risk.virtual_account import reset_latch
        reset_latch(path, "DEC-9999 does not exist")
    code, _ = control.reset_latch_s("DEC-0071: the cause is fixed", va_path=path, lock_root=tmp_path / "locks")
    after = VirtualAccount.load(path)
    assert code == 0 and not after.latched
    assert xs.last_reset(after.latch_history, "DEC-0073") == after.latch_history[-1]["at"]


def test_the_reset_refuses_while_the_desk_runs(tmp_path):
    from wt.ops import locks
    va = VirtualAccount()
    va.latch("stop rule X1: the account was short (DEC-0073)")
    path = tmp_path / "virtual_account.json"
    va.save(path)
    for held in ("paper-s", locks.RUNNER_LOCK_S):
        with locks.job_lock(held, tmp_path / "locks") as got:
            assert got
            code, msg = control.reset_latch_s("DEC-0071: fixed", va_path=path, lock_root=tmp_path / "locks")
        assert code == 3 and "paper-s is running" in msg and VirtualAccount.load(path).latched


def test_the_scorecard_line_counts_only():
    rows = [row("unprotected", trade_id="t", polls=1), closed("a", 9.65)]
    line = xs.state_line(RULES, rows)
    assert "most 1 of 2" in line and "slip 1 of 2" in line and "FIRED" not in line
    assert "FIRED: X3" in xs.state_line(RULES, [*rows, row("unprotected", trade_id="t", polls=2)])


# ---- X3 against the deferrals the order manager already has (DEC-0071 left them out) ---------------------------

def test_a_stop_move_whose_cancel_lands_late_leaves_at_most_one_bare_poll():
    """The runner reads X3 at the start of each poll, then reconciles. A trailed stop whose cancel is unconfirmed
    twice running and then lands shows bare at one poll start; reconcile puts a stop back before the next."""
    from test_oms_exit_hold import Clock, SlowCancel

    from wt.oms.multi import MultiOMS, MultiPlan
    b, clock = SlowCancel(), Clock()
    oms = MultiOMS(b, sell_timeout_s=1.0, sleep=lambda s: None, strategy="S", clock=clock)
    p = MultiPlan(date="2026-09-30", strategy="S", symbol="AAA", qty=4, trigger=5.06, limit=5.07, stop=4.94,
                  target=0.0)
    oms.place_entry(p)
    b.fill(p.entry_id, 5.06)
    oms.sync(p)

    def bare() -> bool:                                               # the runner's X3 reading (runner_s)
        q = sum(x.qty for x in b.positions() if x.symbol == "AAA")
        return q > 0 and not oms.held_for_exit(p) and oms.stop_cover("AAA") < q

    run, worst = 0, 0
    for k in range(6):
        run = run + 1 if bare() else 0                                # poll start
        worst = max(worst, run)
        oms.reconcile_all([p])
        if k in (0, 1):
            assert oms.move_stop(p, 5.00) is False                    # cancel sent, not confirmed: deferred
        if k == 1:
            b.settle()                                                # the cancel lands after the second try
        clock.t += 10
    assert worst == 1 and not bare()


def test_a_fault_under_the_stop_rules_latch_keeps_that_reason_and_latches_once_it_is_reset():
    va = VirtualAccount()
    va.latch("stop rule cum_r: cumulative -6.10R over 5 trades, at or under -6.0R (DEC-0066)")
    history = [{"at": "2026-11-25T21:00:00+00:00", "reason": va.latch_reason}]   # the stop rule's own reset later
    fault = row("short_position", ts="2026-11-24T15:00:00+00:00", symbol="AAA", qty=-1)
    assert xs.evaluate(RULES, [fault], xs.last_reset([], "DEC-0073")) is not None
    assert xs.last_reset(history, "DEC-0073") == ""                   # that reset does not count for DEC-0073
    assert xs.evaluate(RULES, [fault], xs.last_reset(history, "DEC-0073")).code == "X1"


def test_the_scorecard_prints_the_stock_desks_stops_from_its_own_files(tmp_path, monkeypatch):
    import sys

    sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parents[2] / "scripts"))
    import weekly_scorecard as wsc
    journal = tmp_path / "smallcap_journal.jsonl"
    journal.write_text("\n".join(json.dumps(r) for r in [row("unprotected", trade_id="t", polls=1),
                                                          closed("a", 9.65)]) + "\n")
    va = VirtualAccount()
    va.latch_history.append({"at": "2026-11-20T00:00:00+00:00", "reason": "stop rule X1: short (DEC-0073)"})
    va.save(tmp_path / "virtual_account.json")
    monkeypatch.setattr(wsc, "JOURNAL_S", journal)
    monkeypatch.setattr(wsc, "VA_S", tmp_path / "virtual_account.json")
    import datetime as dt
    lines = wsc.s_stop_lines(dt.date(2026, 11, 27))
    assert lines[0].startswith("- Stop rule (DEC-0066)")
    assert "most 1 of 2" in lines[1] and "slip 1 of 2" in lines[1] and "since the reset of 2026-11-20" in lines[1]
