"""EXP-0042 diagnostics (wt.research.b_audit): hand-checked cases on synthetic trades, no files, no network."""
from __future__ import annotations

import datetime as dt
import math

import numpy as np
import pytest
from scipy import stats as st

from wt.research import b_audit as ba


def trades(rs, start=dt.date(2020, 1, 1), mfe=None, entry="15:00"):
    out = []
    for i, r in enumerate(rs):
        d = start + dt.timedelta(days=i)
        h, m = (int(x) for x in entry.split(":"))
        et = dt.datetime(d.year, d.month, d.day, h, m, tzinfo=ba.ET)
        out.append(ba.Trade(d, float(r), "target" if r > 0 else "stop", None if mfe is None else mfe[i], et))
    return out


def test_parse_reads_utc_entry_in_new_york_time():
    t = ba.parse_trades([{"date": "2019-01-04", "R": -0.1, "exit_reason": "trail", "mfe_R": 0.1,
                          "entry_time": "2019-01-04 15:30:00+00:00"}])[0]
    assert t.entry_et is not None and (t.entry_et.hour, t.entry_et.minute) == (10, 30)
    assert ba.entry_mark(t) == "10:30" and ba.runner_can_trade(t) is True
    with pytest.raises(ValueError):
        ba.parse_trades([{"date": "2019-01-04", "R": 0, "entry_time": "2019-01-04 15:30:00"}])


def test_runner_cutoff_is_1530_new_york_across_dst():
    summer = ba.parse_trades([{"date": "2024-07-01", "R": 1, "entry_time": "2024-07-01 19:30:00+00:00"}])[0]
    winter = ba.parse_trades([{"date": "2024-01-02", "R": 1, "entry_time": "2024-01-02 20:29:00+00:00"}])[0]
    assert ba.runner_can_trade(summer) is False          # 15:30 EDT
    assert ba.runner_can_trade(winter) is True           # 15:29 EST
    assert ba.entry_mark(winter) == "15:00"


def test_distribution_hand_case():
    d = ba.distribution(trades([2, -1, -1, 2, -1]), draws=200)
    assert d["n"] == 5 and d["expectancy_R"] == pytest.approx(0.2)
    assert d["win_rate"] == pytest.approx(0.4) and d["profit_factor"] == pytest.approx(4 / 3)
    assert d["max_drawdown_R"] == pytest.approx(-2.0) and d["max_drawdown_trades"] == 2
    assert d["longest_losing_run"] == 2 and d["total_R"] == pytest.approx(1.0)
    assert d["top5_share_of_R"] == pytest.approx(1.0)


def test_distribution_edges():
    assert ba.distribution([]) == {"n": 0}
    one = ba.distribution(trades([0.5]))
    assert one["n"] == 1 and "ci95_trade" not in one and one["per_trade_sharpe"] == 0.0
    losers = ba.distribution(trades([-1, -1, -0.5]), draws=100)
    assert losers["profit_factor"] == 0.0 and losers["top5_share_of_R"] is None
    assert losers["longest_losing_run"] == 3 and losers["max_drawdown_R"] == pytest.approx(-2.5)


def test_bootstrap_is_deterministic_under_seed():
    t = trades(np.random.default_rng(1).normal(0.1, 1, 60))
    assert ba.distribution(t, seed=7, draws=500) == ba.distribution(t, seed=7, draws=500)
    assert ba.distribution(t, seed=7, draws=500)["ci95_trade"] != ba.distribution(t, seed=8, draws=500)["ci95_trade"]


def test_walk_forward_matches_g1_rules():
    a = trades([0.5] * 40, start=dt.date(2019, 1, 2))     # good in its fit window, all before 2020-02
    b = trades([0.1] * 600, start=dt.date(2019, 1, 2))
    pooled, picks = ba.walk_forward({"a": a, "b": b}, dt.date(2019, 1, 2), dt.date(2020, 12, 31))
    assert picks[0] == ("2020-01-01", "a")                  # a has >= 20 fit trades and the better mean
    assert all(p[1] == "b" for p in picks[1:])
    assert all(dt.date(2020, 1, 1) <= t.date for t in pooled)
    assert ba.folds(dt.date(2019, 1, 2), dt.date(2025, 9, 25))[-1] == (dt.date(2024, 7, 1), dt.date(2025, 7, 1),
                                                                       dt.date(2025, 9, 25))
    assert len(ba.folds(dt.date(2019, 1, 2), dt.date(2025, 9, 25))) == 23


def test_dsr_one_trial_is_the_probabilistic_sharpe_ratio():
    r = np.random.default_rng(3).normal(0.15, 1.0, 400)
    t = trades(r)
    sr = r.mean() / r.std(ddof=1)
    g3, g4 = st.skew(r), st.kurtosis(r, fisher=False)
    psr = st.norm.cdf(sr * math.sqrt(len(r) - 1) / math.sqrt(1 - g3 * sr + (g4 - 1) / 4 * sr ** 2))
    assert ba.dsr(t, 1) == pytest.approx(psr)
    assert ba.dsr(t, 87) < ba.dsr(t, 65) < ba.dsr(t, 12) < ba.dsr(t, 1)


def test_pbo_noise_is_near_half_and_a_planted_edge_is_near_zero():
    rng = np.random.default_rng(11)
    noise = rng.normal(0, 1, (800, 10))
    assert 0.3 < ba.pbo_cscv(noise, 16)["pbo"] < 0.7
    planted = noise.copy()
    planted[:, 4] += 0.5
    res = ba.pbo_cscv(planted, 16)
    assert res["pbo"] < 0.05 and res["splits"] == 12870
    with pytest.raises(ValueError):
        ba.pbo_cscv(noise[:, :1])
    with pytest.raises(ValueError):
        ba.pbo_cscv(noise, 15)


def test_daily_matrix_zero_fills():
    names, dates, m = ba.daily_matrix({"x": trades([1, 2]), "y": trades([3], start=dt.date(2020, 1, 2))})
    assert names == ["x", "y"] and len(dates) == 2
    assert m.tolist() == [[1.0, 0.0], [2.0, 3.0]]


def test_power_and_track_record():
    n = ba.trades_for_power(0.1, 1.0)
    assert n == pytest.approx(((st.norm.ppf(0.95) + st.norm.ppf(0.8)) * 10) ** 2)
    assert ba.power_at(round(n), 0.1, 1.0) == pytest.approx(0.8, abs=0.01)
    assert math.isinf(ba.trades_for_power(0.0, 1.0)) and math.isinf(ba.min_track_record(-0.1, 0, 3))
    assert ba.min_track_record(0.1, 0.0, 3.0) == pytest.approx(1 + (1 + 0.5 * 0.01) * (st.norm.ppf(0.95) / 0.1) ** 2)


def test_sprt_boundaries():
    d = ba.sprt_design(0.05, 0.8, 0.05, 0.20)
    assert d["upper_offset_R"] == pytest.approx(0.64 * math.log(0.8 / 0.05) / 0.05)
    assert d["lower_offset_R"] == pytest.approx(0.64 * math.log(0.2 / 0.95) / 0.05)
    assert ba.sprt_lower_at(d, 10) == pytest.approx(d["lower_offset_R"] + 10 * 0.025)
    assert d["expected_trades_if_no_edge"] > 0 and d["expected_trades_if_edge"] > 0
    with pytest.raises(ValueError):
        ba.sprt_design(0.0, 1.0)


def test_cost_slope():
    c = ba.cost_slope({1.0: 0.12, 1.5: 0.10, 2.0: 0.08})
    assert c["slope_per_1x"] == pytest.approx(-0.04) and c["break_even_multiple"] == pytest.approx(4.0)
    assert ba.cost_slope({1.0: 0.1})["slope_per_1x"] is None


def test_exit_quality():
    q = ba.exit_quality(trades([2, -1, 0.5], mfe=[2.1, 1.2, 1.0]))
    assert q["share_reaching_2R_mfe"] == pytest.approx(1 / 3)
    assert q["share_of_losers_that_were_1R_up"] == 1.0
    assert q["mean_R_over_mfe_of_winners"] == pytest.approx((2 / 2.1 + 0.5) / 2)
    assert ba.exit_quality(trades([1])) == {"n_with_mfe": 0}


def test_scorecard_paper_line_parses():
    import importlib.util
    from pathlib import Path
    spec = importlib.util.spec_from_file_location("b_audit_cli", Path(__file__).parents[2] / "scripts/b_audit.py")
    assert spec and spec.loader
    cli = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(cli)
    text = ("- Sessions armed: **33** · clean (count for G2): **28** · trades closed: **9** · E[R] -0.365 · "
            "win 33% · cum -3.29R")
    assert cli.paper_aggregate(text) == {"sessions_armed": 33, "trades_closed": 9, "mean_R": -0.365, "cum_R": -3.29}
    with pytest.raises(ValueError):
        cli.paper_aggregate("nothing here")


def _cli():
    import importlib.util
    from pathlib import Path
    spec = importlib.util.spec_from_file_location("b_audit_cli2", Path(__file__).parents[2] / "scripts/b_audit.py")
    assert spec and spec.loader
    cli = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(cli)
    return cli


def test_rounding_and_trading_calendar():
    pytest.importorskip("exchange_calendars")      # dev lock only; the deploy's staging suite has the runtime lock
    cli = _cli()
    assert cli.rounded({"a": [0.1234567891234, math.inf, 0.0, 3]}) == {"a": [0.123456789, math.inf, 0.0, 3]}
    sessions = cli.xnys_sessions(dt.date(2019, 11, 1), dt.date(2020, 1, 31))
    firsts = cli.first_sessions(sessions)
    assert dt.date(2020, 1, 2) in firsts and dt.date(2020, 1, 1) not in sessions      # New Year's Day is a holiday
    assert sessions[dt.date(2019, 11, 29)] == dt.time(13, 0)                          # the day after Thanksgiving


def test_runner_constants_match_the_runner_source():
    import re
    from pathlib import Path
    src = (Path(__file__).parents[2] / "src/wt/live/runner_b.py").read_text()
    flat = re.search(r"flatten_dt, market_dt, verify_dt = \(close_dt - dt\.timedelta\(minutes=m\) for m in \((\d+),", src)
    entry = re.search(r"now < flatten_dt - dt\.timedelta\(minutes=(\d+)\)", src)
    assert flat and entry
    assert int(flat.group(1)) == ba.FLATTEN_BEFORE_CLOSE_MIN and int(entry.group(1)) == ba.NO_ENTRY_BEFORE_FLATTEN_MIN
    assert ba.entry_cutoff() == dt.time(15, 30) and ba.entry_cutoff(dt.time(13, 0)) == dt.time(12, 30)
    half = trades([1], start=dt.date(2019, 11, 29), entry="12:30")[0]
    assert ba.runner_can_trade(half, dt.time(13, 0)) is False and ba.runner_can_trade(half) is True


def test_rc1_footprint():
    assert ba.rc1_footprint(trades([1], entry="09:45")[0])
    assert ba.rc1_footprint(trades([1], entry="11:15")[0]) and ba.rc1_footprint(trades([1], entry="12:45")[0])
    assert not ba.rc1_footprint(trades([1], entry="10:00")[0]) and not ba.rc1_footprint(trades([1], entry="11:31")[0])


def test_walk_forward_ties_and_the_20_trade_minimum():
    start = dt.date(2019, 1, 2)
    a = trades([0.2] * 19, start=start)                     # 19 fit trades: never eligible
    b = trades([0.1] * 30, start=start)
    c = trades([0.1] * 30, start=start)                     # ties b: the first in input order wins
    _, picks = ba.walk_forward({"a": a, "b": b, "c": c}, start, dt.date(2020, 3, 31))
    assert picks == [("2020-01-01", "b")]


def test_pbo_near_one_when_the_in_sample_winner_is_a_mirage():
    rng = np.random.default_rng(5)
    m = rng.normal(0, 0.1, (640, 6))
    # config 0 is excellent in the first half of every block and bad in the second: chosen in sample, loses out of it
    for blk in range(16):
        m[blk * 40: blk * 40 + 20, 0] += 1.0
        m[blk * 40 + 20: blk * 40 + 40, 0] -= 1.0
    res = ba.pbo_cscv(m, 16)
    assert sum(res["is_best_counts"]) == res["splits"]
    assert 0.0 <= res["pbo"] <= 1.0


def test_dsr_with_trial_variance_and_sharpe_variance():
    rng = np.random.default_rng(9)
    v = {"x": trades(rng.normal(0.1, 1, 300)), "y": trades(rng.normal(-0.1, 1, 300)), "z": trades(rng.normal(0.0, 1, 300))}
    sv = ba.sharpe_variance(v)
    assert sv > 0
    assert ba.dsr(v["x"], 10, sv) <= ba.dsr(v["x"], 10, 1e-6) + 1e-12 or sv < 1 / 300
    assert ba.sharpe_variance({"x": v["x"]}) == 0.0


def test_cost_slope_rising_has_no_break_even():
    assert ba.cost_slope({1.0: 0.1, 2.0: 0.2})["break_even_multiple"] is None


def test_sprt_expected_lengths_closed_form():
    d = ba.sprt_design(0.05, 0.8, 0.05, 0.20)
    a, b = math.log(0.8 / 0.05), math.log(0.2 / 0.95)
    k = 0.05 ** 2 / (2 * 0.64)
    assert d["expected_trades_if_no_edge"] == pytest.approx(((0.95 * b) + 0.05 * a) / -k)
    assert d["expected_trades_if_edge"] == pytest.approx((0.2 * b + 0.8 * a) / k)


def test_reconcile_failure_exits_2(monkeypatch):
    cli = _cli()
    def boom():
        raise cli.ReconcileError("walk-forward n: recomputed 1, recorded 2")
    monkeypatch.setattr(cli, "run", boom)
    assert cli.main([]) == 2


def test_committed_results_reproduce():
    """EXP-0042's committed results.json is exactly what the driver produces from the committed inputs (byte for byte,
    except the whole-file trial_registry hash: see check_results)."""
    import subprocess
    import sys
    from pathlib import Path
    pytest.importorskip("exchange_calendars")      # the driver reads XNYS sessions from it (dev lock only)
    root = Path(__file__).parents[2]
    if not (root / "research/experiments/EXP-0042-b-audit-diagnostics/results.json").exists():
        pytest.skip("EXP-0042 has not been run in this checkout")
    out = subprocess.run([sys.executable, str(root / "scripts/b_audit.py"), "--check"], capture_output=True, text=True)
    assert out.returncode == 0, out.stderr


# ---- --check and the trial registry hash: only what the audit reads may fail the check

def _fresh() -> dict:
    return {"inputs_sha256": {"holdout": "aa" * 32, "trial_registry": "bb" * 32},
            "registry": {"global_trials": 87, "rows": 4}, "dsr": {"prob": 0.123456789012}}


def test_check_passes_on_identical_bytes():
    cli = _cli()
    fresh = _fresh()
    assert cli.check_results(cli.dump(fresh), fresh) == (True, False)


def test_check_waives_only_the_registry_file_hash():
    cli = _cli()
    committed = _fresh()
    committed["inputs_sha256"]["trial_registry"] = "cc" * 32      # a family row or a comment was added since
    assert cli.check_results(cli.dump(committed), _fresh()) == (True, True)


@pytest.mark.parametrize("change", [
    lambda d: d["registry"].update(rows=5),                          # a new global history row
    lambda d: d["registry"].update(global_trials=97),                # a new accepted global count
    lambda d: d["dsr"].update(prob=0.5),                             # a figure computed from it
    lambda d: d["inputs_sha256"].update(holdout="dd" * 32),          # any other input
])
def test_check_fails_when_anything_else_differs(change):
    cli = _cli()
    committed = _fresh()
    committed["inputs_sha256"]["trial_registry"] = "cc" * 32
    change(committed)
    ok, _ = cli.check_results(cli.dump(committed), _fresh())
    assert not ok


def test_check_keeps_formatting_and_rounding_strict():
    cli = _cli()
    fresh = _fresh()
    assert cli.check_results(cli.dump(fresh).replace('\n "', '\n  "'), fresh)[0] is False
    unrounded = cli.dump(fresh).replace("0.123456789", "0.123456789012")
    assert cli.check_results(unrounded, fresh)[0] is False


@pytest.mark.parametrize("committed", ["", "not json", "{}", '{"inputs_sha256": {}}',
                                       '{"inputs_sha256": {"trial_registry": 1}}'])
def test_check_fails_on_a_malformed_committed_file(committed):
    assert _cli().check_results(committed, _fresh()) == (False, False)


def test_check_cli_exit_codes(monkeypatch, tmp_path, capsys):
    cli = _cli()
    monkeypatch.setattr(cli, "EXP", tmp_path)
    monkeypatch.setattr(cli, "run", _fresh)
    assert cli.main(["--check"]) == 1                                  # missing
    committed = _fresh()
    committed["inputs_sha256"]["trial_registry"] = "cc" * 32
    (tmp_path / "results.json").write_text(cli.dump(committed))
    assert cli.main(["--check"]) == 0
    assert "registry block and figures match" in capsys.readouterr().out
    committed["registry"]["rows"] = 5
    (tmp_path / "results.json").write_text(cli.dump(committed))
    assert cli.main(["--check"]) == 1


def test_registry_reads_ignore_families(tmp_path):
    """The waiver rests on this: global_trial_count and trial_history read only `history`, never `families`."""
    from wt.research.trials import global_trial_count, trial_history
    base = {"history": [{"decision": "DEC-0007", "total": 65, "status": "accepted"}],
            "families": {"O": [{"decision": "DEC-0001", "total": 3, "status": "accepted"}]}}
    import yaml
    a, b = tmp_path / "a.yaml", tmp_path / "b.yaml"
    a.write_text(yaml.safe_dump(base))
    base["families"]["O"].append({"decision": "DEC-0002", "total": 9, "status": "proposed"})
    base["families"]["Z"] = [{"decision": "DEC-0003", "total": 1, "status": "accepted"}]
    b.write_text("# a comment\n" + yaml.safe_dump(base))
    assert global_trial_count(a) == global_trial_count(b) == 65
    assert trial_history(a) == trial_history(b)
