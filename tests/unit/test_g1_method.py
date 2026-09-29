"""DEC-0011 on the G1 path (EXP-0017), synthetic data only: g1_etf --method dec0011 simulates trade-through targets
and writes per-fill rows; g1_eval --method dec0011 takes the global DSR count, day-block CIs and fill stress. The
legacy defaults are unchanged."""
import importlib.util
import json
from pathlib import Path

import numpy as np
import pandas as pd
import pytest
from synth_trades import sim

from wt.backtest.engine import Costs, EntrySignal
from wt.backtest.stats import deflated_sharpe_prob
from wt.backtest.stress import detail
from wt.research.trials import global_trial_count

ROOT = Path(__file__).resolve().parents[2]


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / f"scripts/{name}.py")
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


g1_eval, g1_etf = load("g1_eval"), load("g1_etf")


def results(n=700, seed=2, fills=True):
    rng = np.random.default_rng(seed)
    days = pd.bdate_range("2019-01-02", "2025-09-25")
    trades = []
    for i in sorted(rng.choice(len(days), n, replace=True)):
        cst = Costs(slippage_per_share=0.022)
        tr = sim(rng.choice(["win", "stop", "flat"], p=[0.45, 0.4, 0.15]), 480.0, 1.2, cst, risk=6, cash=1e9)
        row = {"date": str(days[i].date()), "symbol": "QQQ", "R": tr.r_multiple(cst), "exit_reason": tr.exits[-1][3]}
        trades.append(row | (detail(tr, cst) if fills else {}))
    return json.loads(json.dumps(trades, default=str))


def write(tmp_path, monkeypatch, trades, method):
    monkeypatch.setattr(g1_eval, "ROOT", tmp_path)
    exp = tmp_path / "research/experiments/EXP-G"
    exp.mkdir(parents=True, exist_ok=True)
    body = {"n_trials": 12, "results": {"B|QQQ|noise|M3": {"trades": trades}}} | ({"method": method} if method else {})
    (exp / "results.json").write_text(json.dumps(body))
    return exp


def test_legacy_eval_counts_the_experiments_own_trials(tmp_path, monkeypatch):
    exp = write(tmp_path, monkeypatch, results(fills=False), None)
    s = g1_eval.main("EXP-G")["B"]["stats"]
    assert s["dsr_prob"] == deflated_sharpe_prob(s["per_trade_sharpe"], s["n"], 12, s["skew"], s["kurtosis"])
    assert "Trials counted for DSR: **12**" in (exp / "g1_report.md").read_text()
    assert "ci95_block" not in s and not any("stress" in k for k in s)


def test_dec0011_eval_uses_the_global_count_day_blocks_and_fill_stress(tmp_path, monkeypatch):
    exp = write(tmp_path, monkeypatch, results(), "dec0011")
    s = g1_eval.main("EXP-G", method="dec0011")["B"]["stats"]
    n_global = global_trial_count()
    assert n_global > 12
    assert s["dsr_prob"] == deflated_sharpe_prob(s["per_trade_sharpe"], s["n"], n_global, s["skew"], s["kurtosis"])
    assert s["ci95_block"] == "day"
    assert s["stress_1.5x"]["expectancy_R"] < s["expectancy_R"]
    assert s["expectancy_R"] > s["stop_stress_2.0x"]["expectancy_R"] > s["stop_stress_3.0x"]["expectancy_R"]
    assert f"Trials counted for DSR: **{n_global}**" in (exp / "g1_report_dec0011.md").read_text()
    assert not (exp / "g1_eval.json").exists()


def test_dec0011_eval_refuses_legacy_results(tmp_path, monkeypatch):
    write(tmp_path, monkeypatch, results(60, fills=False), None)
    with pytest.raises(ValueError, match="simulated with method 'legacy'"):
        g1_eval.main("EXP-G", method="dec0011")


def etf_day(d: pd.Timestamp) -> pd.DataFrame:
    """390 one-minute bars at ~100 that trigger 100.50 at bar 11 and only TOUCH the 101.50 target at bar 20."""
    o = np.full(390, 100.8)
    o[:12] = 100.2
    h, lo = o + 0.05, o - 0.05
    h[11], h[20] = 100.6, 101.5
    t = pd.date_range(d.tz_localize("America/New_York") + pd.Timedelta(hours=9, minutes=30), periods=390, freq="1min")
    return pd.DataFrame({"symbol": "X", "t": t.tz_convert("UTC"), "o": o, "h": h, "l": lo, "c": o, "v": 1e6,
                         "date": [d.date()] * 390})


@pytest.mark.parametrize("method, exit_reason", [("legacy", "target"), ("dec0011", "eod_flatten")])
def test_g1_etf_runs_the_chosen_fill_model(monkeypatch, method, exit_reason):
    bars = pd.concat([etf_day(d) for d in pd.bdate_range("2024-01-02", periods=24)], ignore_index=True)
    saved = {}
    monkeypatch.setattr(g1_etf, "load", lambda sym: bars.assign(symbol=sym))
    signal = EntrySignal(10, trigger=100.5, stop=100.0, target=101.5, setup="t")
    monkeypatch.setattr(g1_etf.setups, "a_orb_5m", lambda *a, **k: signal)
    monkeypatch.setattr(g1_etf.setups, "b_intraday_momentum", lambda *a, **k: signal)
    monkeypatch.setattr(g1_etf, "save_experiment", lambda exp, cfgs, res: saved.update(res))
    g1_etf.main("EXP-X", method)
    rows = [r for v in saved["results"].values() for r in v["trades"]]
    fixed_target = [r for k, v in saved["results"].items() if k.endswith("|M3") for r in v["trades"]]
    assert fixed_target and {r["exit_reason"] for r in fixed_target} == {exit_reason}
    assert saved.get("method") == (None if method == "legacy" else method)
    assert all(("fills" in r) == (method != "legacy") for r in rows)
