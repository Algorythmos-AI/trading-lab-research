"""The stocks desk's pre-registered stop (DEC-0037): three triggers, a latch, and a reset that needs a record."""
from __future__ import annotations

import datetime as dt
from pathlib import Path

import pytest
import yaml

from wt.risk import stop_rule
from wt.risk.virtual_account import STOP_RULE_PREFIX, StateError, VirtualAccount, reset_latch

ROOT = Path(__file__).resolve().parents[2]
RULE = stop_rule.StopRule(decision="DEC-0037", cum_r_max_loss=-6.0, review_at_trades=30, stop_date=dt.date(2027, 1, 30))


def closed(r: float, i: int, estimated: bool = False) -> dict:
    return {"event": "trade_closed", "trade_id": f"2026-10-{i:02d}-B-QQQM-0", "day": f"2026-10-{i:02d}", "R": r,
            "exit_price_estimated": estimated}


def test_the_shipped_config_carries_the_rule_and_names_its_record():
    rule = stop_rule.load()
    assert rule == RULE
    cfg = yaml.safe_load((ROOT / "config/risk.yaml").read_text())["B"]["stop_rule"]
    assert cfg["decision"] == "DEC-0037"


def test_only_real_closed_trades_count_once():
    rows = [closed(-1.0, 1), closed(-1.0, 1), closed(0.5, 2, estimated=True), {"event": "decision"},
            {"event": "trade_closed", "trade_id": "x", "origin": "orphan", "R": -5.0}, closed(0.2, 3),
            {"event": "trade_closed", "trade_id": "b", "day": "2026-10-04", "R": True}]
    assert stop_rule.rs_of(rows) == [-1.0, 0.2]


def test_cumulative_loss_fires_first():
    rows = [closed(-1.0, i) for i in range(1, 7)]
    fired = stop_rule.evaluate(RULE, rows, dt.date(2026, 10, 24))
    assert fired is not None and fired.kind == "cum_r" and "-6.00R" in fired.detail
    assert stop_rule.evaluate(RULE, rows[:-1], dt.date(2026, 10, 24)) is None


def test_the_review_fires_at_the_count_only_when_the_upper_bound_is_below_zero():
    losing = [closed(-0.4 if i % 2 else 0.1, i) for i in range(1, 31)]           # cum -4.5: above the cum_r line
    fired = stop_rule.evaluate(RULE, losing, dt.date(2026, 12, 1))
    assert fired is not None and fired.kind == "review" and "below zero" in fired.detail
    doubtful = [closed(-0.5 if i % 2 else 0.4, i) for i in range(1, 31)]        # mean -0.05, upper bound above zero
    assert stop_rule.evaluate(RULE, doubtful, dt.date(2026, 12, 1)) is None
    assert stop_rule.evaluate(RULE, losing[:29], dt.date(2026, 12, 1)) is None    # under the count: no review yet
    assert stop_rule.evaluate(RULE, [closed(-5.9999, 1)], dt.date(2026, 12, 1)) is None
    assert stop_rule.evaluate(RULE, [closed(-2.1, 1), closed(-1.9, 2), closed(-2.0, 3)], dt.date(2026, 12, 1)) is not None


def test_the_date_fires_whatever_the_count():
    assert stop_rule.evaluate(RULE, [], dt.date(2027, 1, 29)) is None
    fired = stop_rule.evaluate(RULE, [], dt.date(2027, 1, 30))
    assert fired is not None and fired.kind == "date" and "0 trades" in fired.detail


def test_the_latch_reason_carries_the_prefix_and_the_record():
    reason = stop_rule.latch_reason(stop_rule.Stop("cum_r", "x"), RULE)
    assert reason.startswith(STOP_RULE_PREFIX) and reason.endswith("(DEC-0037)")


def test_the_scorecard_line_says_where_each_trigger_stands():
    line = stop_rule.state_line(RULE, [closed(-1.0, 1)], dt.date(2026, 10, 24))
    assert line.startswith("- Stop rule (DEC-0037): cumulative -1.00R of -6.0R · 1 of 30 trades to the review")
    assert "FIRED" not in line
    fired = stop_rule.state_line(RULE, [closed(-1.0, i) for i in range(1, 7)], dt.date(2026, 10, 24))
    assert "**FIRED: cum_r" in fired


def test_a_stop_rule_latch_is_cleared_only_with_a_decision_record(tmp_path):
    path = tmp_path / "virtual_account.json"
    va = VirtualAccount()
    va.latch(stop_rule.latch_reason(stop_rule.Stop("cum_r", "cumulative -6.00R"), RULE))
    va.save(path)
    with pytest.raises(StateError, match="only a new decision record clears it"):
        reset_latch(path, "losses look like noise, resuming")
    with pytest.raises(StateError, match="not the rule's own"):
        reset_latch(path, "DEC-0037 says resume")                                  # the rule's own record is not new
    assert VirtualAccount.load(path).latched
    cleared = reset_latch(path, "DEC-0041 resumes B with a wider stop after the review")
    assert not cleared.latched and cleared.latch_history[-1]["note"].startswith("DEC-0041")


def test_an_ordinary_latch_still_clears_with_a_plain_reason(tmp_path):
    path = tmp_path / "virtual_account.json"
    va = VirtualAccount()
    va.latch("daily loss limit -2%")
    va.save(path)
    assert not reset_latch(path, "new session, limits reviewed").latched


def test_a_config_without_a_record_id_is_refused(tmp_path):
    bad = tmp_path / "risk.yaml"
    bad.write_text("B:\n  stop_rule: {decision: later, cum_r_max_loss: -6, review_at_trades: 30, stop_date: 2027-01-30}\n")
    with pytest.raises(ValueError, match="decision record id"):
        stop_rule.load("B", bad)
    none = tmp_path / "none.yaml"
    none.write_text("B: {allowlist: [QQQM]}\n")
    assert stop_rule.load("B", none) is None
