"""DEC-0011 on round-3 evaluation, synthetic trades only: per-fill cost stress, stop-slippage stress, realised $,
global DSR trial count and day-block CIs under --method dec0011; the legacy report is unchanged."""
import json
import sys
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pandas as pd
import pytest

from synth_trades import sim

from wt.backtest.engine import Costs
from wt.backtest.management import M1HalfBreakeven, M3FixedTarget
from wt.backtest.stats import deflated_sharpe_prob
from wt.backtest.stress import realised_usd, stressed_pnl, stressed_R
from wt.research.trials import global_trial_count

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
import r3_eval  # noqa: E402
import r3_run  # noqa: E402

@pytest.fixture(autouse=True)
def guard(monkeypatch):
    """The clean-tree guard is unit-tested in test_manifest; here only whether a method calls it."""
    calls = []
    monkeypatch.setattr(r3_eval, "assert_clean_for_preregistered_run", lambda: calls.append("checked"))
    return calls


RECORDED_ROW_KEYS = {"date", "symbol", "setup", "attempt", "priority", "entry_time", "entry", "stop0", "qty", "R",
                     "exit_reason", "exit_time", "tags"}


def synth_rows(n=260, seed=1):
    """Round-3-shaped rows built by the real engine and r3_run.trade_row; integer shares, so actual risk != $6."""
    rng = np.random.default_rng(seed)
    days = pd.bdate_range("2019-06-03", "2025-09-25")
    rows = []
    for i in sorted(rng.choice(len(days), n, replace=True)):         # replace=True: some days trade twice
        p = float(rng.choice([3.1, 7.3, 13.7, 19.9]))
        slip = float(rng.choice([0.01, 0.02]))
        tr = sim(rng.choice(["win", "stop", "flat"], p=[0.45, 0.4, 0.15]), p, round(0.02 * p + 0.03, 2),
                 Costs(slippage_per_share=slip))
        tr.tags.update(trigger=p, slip=slip)
        c = SimpleNamespace(attempt=1, priority=1)
        r = tr.r_multiple(Costs(slippage_per_share=slip))
        rows.append(r3_run.trade_row(days[i].date(), c, tr, r, fills=True))
    return json.loads(json.dumps(rows, default=str))                   # the JSON round trip r3_run's file makes


def write_results(tmp_path, monkeypatch, rows, method="dec0011", name="EXP-T"):
    monkeypatch.setattr(r3_eval, "ROOT", tmp_path)
    exp = tmp_path / "research" / "experiments" / name
    exp.mkdir(parents=True, exist_ok=True)
    body = {"trades": {"F:GG-2": {"600.0": rows, "1000.0": rows}},
            "control_means": {"F:GG-2": list(np.random.default_rng(3).normal(-0.3, 0.05, 200))}}
    if method:
        body["method"] = method
    (exp / "results_F.json").write_text(json.dumps(body))
    return exp


def oos(rows):
    df = pd.DataFrame(rows)
    return df[df.date >= "2020-01-01"].reset_index(drop=True)


def test_trade_row_keeps_its_recorded_shape_unless_fills_are_asked_for():
    tr = sim("win", 7.3, 0.18, Costs(slippage_per_share=0.01))
    tr.tags.update(slip=0.01)
    c = SimpleNamespace(attempt=1, priority=2)
    assert set(r3_run.trade_row("2024-03-01", c, tr, 1.0)) == RECORDED_ROW_KEYS          # forward ledger unchanged
    row = r3_run.trade_row("2024-03-01", c, tr, 1.0, fills=True)
    assert set(row) - RECORDED_ROW_KEYS == {"pnl", "risk_usd", "fills", "costs"}
    assert [f[4] for f in row["fills"]] == tr.exit_kinds and row["pnl"] == tr.pnl(Costs(slippage_per_share=0.01))


def test_unstressed_fills_reproduce_R_and_realised_dollars():
    df = pd.DataFrame(synth_rows(80))
    assert np.array_equal(stressed_R(df), df.R.to_numpy())
    assert realised_usd(df) == pytest.approx(float((df.R * df.risk_usd).sum()), abs=1e-9)


@pytest.mark.parametrize("kind, mgmt", [("stop", M3FixedTarget), ("win", M3FixedTarget), ("flat", M3FixedTarget),
                                        ("win", M1HalfBreakeven)])
@pytest.mark.parametrize("m, k", [(1.5, 1.0), (2.0, 1.0), (1.0, 3.0), (2.0, 2.0)])
def test_per_fill_stress_equals_resimulating_at_stressed_costs(kind, mgmt, m, k):
    base = Costs(slippage_per_share=0.02, commission_per_order=0.35)
    # a thin entry bar caps qty at 50 shares at any fill price, so the stressed re-run trades the same size
    tr = sim(kind, 10.0, 0.5, base, mgmt(), risk=1e9, cash=1e9, vol=500)
    again = sim(kind, 10.0, 0.5, replace(base, cost_multiplier=m, stop_slip_multiplier=k), mgmt(), risk=1e9, cash=1e9, vol=500)
    assert tr.qty == again.qty == 50 and [e[3] for e in tr.exits] == [e[3] for e in again.exits]
    expect = again.pnl(replace(base, cost_multiplier=m, stop_slip_multiplier=k))
    assert stressed_pnl(tr, base, m, k, slip_limits=False) == pytest.approx(expect, abs=1e-9)


def test_every_fill_is_its_own_order():
    base = Costs(slippage_per_share=0.0, commission_per_order=1.0, fee_per_share_sell=0.0, sec_fee_rate_sell=0.0)
    two_exits = sim("win", 10.0, 0.5, base, M1HalfBreakeven(), risk=1e9, cash=1e9, vol=500)   # partial + final
    one_exit = sim("stop", 10.0, 0.5, base, M3FixedTarget(), risk=1e9, cash=1e9, vol=500)
    assert len(two_exits.exits) == 2 and len(one_exit.exits) == 1
    assert stressed_pnl(two_exits, base, 2.0) - two_exits.pnl(base) == pytest.approx(-3.0)   # entry + 2 exits
    assert stressed_pnl(one_exit, base, 2.0) - one_exit.pnl(base) == pytest.approx(-2.0)


def test_stop_stress_reprices_stop_fills_only():
    base = Costs(slippage_per_share=0.02)
    stopped = sim("stop", 10.0, 0.5, base, M3FixedTarget(), risk=1e9, cash=1e9, vol=500)
    target = sim("win", 10.0, 0.5, base, M3FixedTarget(), risk=1e9, cash=1e9, vol=500)
    assert stopped.exit_kinds == ["stop"] and target.exit_kinds == ["limit"]
    q = stopped.exits[0][2]
    assert stressed_pnl(stopped, base, stop_mult=3.0) - stopped.pnl(base) == pytest.approx(-2 * 0.02 * q, rel=1e-3)
    assert stressed_pnl(target, base, stop_mult=3.0) == target.pnl(base)


def test_realised_dollars_follow_actual_risk_not_nominal():
    rows = pd.DataFrame([{"date": "2024-03-01", "entry": 200.0, "stop0": 195.0, "qty": 1, "R": 2.0},    # $5 risked
                         {"date": "2024-03-04", "entry": 5.10, "stop0": 5.03, "qty": 85, "R": -1.0}])  # $5.95
    nominal = float((rows.R * 6.0).sum())
    assert nominal == pytest.approx(6.0)
    assert realised_usd(rows) == pytest.approx(2 * 5.0 - 5.95)
    assert realised_usd(rows.assign(pnl=[9.97, -6.02])) == pytest.approx(3.95)                 # Trade.pnl wins


def test_dec0011_report(tmp_path, monkeypatch, guard):
    rows = synth_rows()
    exp = write_results(tmp_path, monkeypatch, rows)
    out = r3_eval.main("EXP-T", holdout=False, method="dec0011")["F:GG-2"]
    s, df = out["stats"], oos(rows)
    assert s["n"] == len(df) and s["ci95_block"] == "day"
    assert s["dsr_prob"] == deflated_sharpe_prob(s["per_trade_sharpe"], s["n"], global_trial_count(), s["skew"], s["kurtosis"])
    per_fill = float(stressed_R(df, cost_mult=1.5).mean())
    legacy_formula = float(r3_eval.stressed(df, 1.5).mean())
    assert s["stress_1.5x"]["expectancy_R"] == pytest.approx(per_fill)
    assert per_fill < legacy_formula                     # same slippage per share, plus per-order and sell fees
    assert s["expectancy_R"] > s["stop_stress_2.0x"]["expectancy_R"] > s["stop_stress_3.0x"]["expectancy_R"]
    assert out["capital"]["600.0"]["pnl_usd"] == round(float(df.pnl.sum()), 2)
    assert out["capital"]["600.0"]["pnl_usd"] != round(float(df.R.sum() * 6.0), 2)     # nominal $ would differ
    assert (exp / "r3_eval_dec0011.json").exists() and not (exp / "r3_eval.json").exists()
    assert "stop-slippage stress" in (exp / "r3_eval_dec0011.md").read_text()
    man = json.loads((exp / "manifest_r3_eval_dec0011.json").read_text())
    assert man["args"]["method"] == "dec0011" and man["args"]["dsr_trials"] == global_trial_count()
    assert man["data"]["roots"][-1].endswith("results_F.json") and guard == ["checked"]


def test_dec0011_refuses_results_simulated_with_touch_fills(tmp_path, monkeypatch):
    write_results(tmp_path, monkeypatch, synth_rows(40), method=None)
    with pytest.raises(ValueError, match="simulated with method 'legacy'"):
        r3_eval.main("EXP-T", holdout=False, method="dec0011")


def test_legacy_report_ignores_the_new_row_fields(tmp_path, monkeypatch, guard):
    rows = synth_rows(200)
    bare = [{k: v for k, v in r.items() if k in RECORDED_ROW_KEYS} for r in rows]
    write_results(tmp_path, monkeypatch, rows, method=None, name="EXP-A")
    write_results(tmp_path, monkeypatch, bare, method=None, name="EXP-B")
    a, b = r3_eval.main("EXP-A", holdout=False), r3_eval.main("EXP-B", holdout=False)
    assert a == b and "ci95_block" not in a["F:GG-2"]["stats"] and "stop_stress_2.0x" not in a["F:GG-2"]["stats"]
    assert guard == []                                    # legacy runs are not held to the pre-registration guard
