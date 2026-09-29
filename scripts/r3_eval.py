"""Round-3 (SPEC-0001) evaluation (EVL-02, EVL-03): fixed-rule OOS statistics and G1 gates per trial.

Inputs: research/experiments/<exp>/results_{F,P,MP-1,REV-1}.json from r3_run.py / r3_intraday.py (dev span).
Per trial, at US$600 (primary):
  - OOS span 2020-01-01 -> 2025-09-25 (2019 is warm-up, D25)
  - n, E[R], CI95, PF, win rate, max drawdown
  - DSR probability at the global trial count
  - random-control p
  - years profitable, largest month's share of profit
  - cost stress at 1.5x / 2x: each trade's R minus (m - 1) x 2 x slip / risk-per-share
    (entry + exit slippage, using the slippage stamped on the trade)
G1 gates (plan):
  - CI95 lower > 0 at 1.5x costs
  - DSR > 0.95
  - control p < 0.05
  - PF >= 1.2 at 1.5x costs
  - >= 2/3 of years profitable
  - no month > 25% of profit
  - n >= 100
Also: a capital table (US$600 / 1,000 / 2,000), exit-reason mix, and tag descriptives (breakout volume, halts,
tape features: Spearman rho with R). DESCRIPTIVE ONLY.
Holdout: `--holdout` evaluates results files produced on the holdout span. Run it once, and only for trials
whose OOS CI95 lower bound is > 0 (DEC-0005, spec evaluation.holdout_rule).
Method: `--method dec0011` (wt.research.method) evaluates only results r3_run produced with the same method, and
writes <name>_dec0011.{json,md} beside the legacy report: CI95 from day blocks, DSR at the registry's global count,
cost stress over every fill, a separate stop-slippage stress (stop fills at 2x / 3x), $ from Trade.pnl.
The G1 gates are unchanged. The default (legacy) reproduces the recorded reports.

Usage: PYTHONPATH=src .venv/bin/python scripts/r3_eval.py EXP-0015-r3-dev [--holdout] [--method dec0011]
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import stats as st

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from wt.backtest.stats import deflated_sharpe_prob, random_control_pvalue, summarize  # noqa: E402
from wt.backtest.stress import realised_usd, stressed_R  # noqa: E402
from wt.core.config import ROOT  # noqa: E402
from wt.research.manifest import assert_clean_for_preregistered_run, write_manifest  # noqa: E402
from wt.research.method import LEGACY, METHODS, Method, get_method  # noqa: E402
from wt.specs.loader import load_spec  # noqa: E402

TAP = ["tape_speed_ratio", "buy_initiated_share", "green_print_surge", "price_per_1k_shares", "ask_size_depletion",
       "bid_stepups", "post_entry_freeze", "tenS_break_seconds", "tenS_first30s_low_R"]


def stressed(df: pd.DataFrame, m: float) -> np.ndarray:
    slip = df.tags.map(lambda t: float((t or {}).get("slip", 0.01)))
    rps = (df.entry - df.stop0).clip(lower=1e-9)
    return (df.R - (m - 1) * 2 * slip / rps).to_numpy()


def trial_stats(df: pd.DataFrame, n_trials: int, control: list[float] | None, method: Method = LEGACY) -> dict:
    r = df.R.to_numpy(float)
    ci = {"block": method.bootstrap_block, "days": df.date.to_numpy() if method.bootstrap_block == "day" else None}
    s = summarize(r, **ci) if len(r) else {"n": 0}
    if s.get("n", 0) < 3:
        return s
    s["dsr_prob"] = deflated_sharpe_prob(s["per_trade_sharpe"], s["n"], n_trials, s["skew"], s["kurtosis"])
    for m in (1.5, 2.0):
        rs = stressed_R(df, cost_mult=m) if method.fill_stress else stressed(df, m)
        ss = summarize(rs, **ci)
        s[f"stress_{m}x"] = {"expectancy_R": ss["expectancy_R"], "ci95": ss["ci95_expectancy"], "profit_factor": ss["profit_factor"]}
    for k in method.stop_slip_stress:            # reported, not gated: the pre-registered gates stay as they are
        ss = summarize(stressed_R(df, stop_mult=k), **ci)
        s[f"stop_stress_{k}x"] = {"expectancy_R": ss["expectancy_R"], "ci95": ss["ci95_expectancy"], "profit_factor": ss["profit_factor"]}
    yrs = df.groupby(pd.to_datetime(df.date).dt.year).R.sum()
    s["years_profitable"] = [int((yrs > 0).sum()), int(len(yrs))]
    months = df.groupby(pd.to_datetime(df.date).dt.to_period("M")).R.sum()
    s["max_month_share_of_profit"] = float(months.max() / months[months > 0].sum()) if (months > 0).any() else None
    s["random_control_p"] = random_control_pvalue(s["expectancy_R"], np.array(control)) if control else None
    s["exit_mix"] = df.exit_reason.value_counts(normalize=True).round(3).to_dict()
    tags = pd.json_normalize(df.tags.tolist())
    desc = {}
    for col in ("breakout_volume_ok", "halt", "high_conviction_volume"):
        if col in tags:
            g = df.R.groupby(tags[col].fillna("na").astype(str).values).agg(["count", "mean"]).round(3)
            desc[col] = g.to_dict(orient="index")
    for col in TAP:
        if col in tags and tags[col].notna().sum() >= 10:
            rho, p = st.spearmanr(tags[col], df.R, nan_policy="omit")
            desc[col] = {"n": int(tags[col].notna().sum()), "spearman_rho": round(float(rho), 3), "p": round(float(p), 4)}
    s["tag_descriptives"] = desc
    return s


def gates(s: dict) -> dict:
    yp = s.get("years_profitable") or [0, 1]
    st15 = s.get("stress_1.5x") or {}
    return {"ci95_lower_gt_0_at_1.5x": (st15.get("ci95") or [0])[0] > 0,
            "dsr_gt_0.95": (s.get("dsr_prob") or 0) > 0.95,
            "control_p_lt_0.05": s.get("random_control_p") is not None and s["random_control_p"] < 0.05,
            "pf_ge_1.2_at_1.5x": (st15.get("profit_factor") or 0) >= 1.2,
            "years_ge_two_thirds": yp[1] > 0 and yp[0] / yp[1] >= 2 / 3,
            "no_month_gt_25pct": s.get("max_month_share_of_profit") is not None and s["max_month_share_of_profit"] <= 0.25,
            "n_ge_100": s.get("n", 0) >= 100}


def main(exp: str, holdout: bool, method: str = "legacy") -> dict:
    m = get_method(method)
    if not m.legacy:
        assert_clean_for_preregistered_run()     # a DEC-0011 evaluation must be reproducible from its commit
    spec = load_spec("SPEC-0001")
    ev = spec["evaluation"]
    span = ev["holdout_span"] if holdout else ev["oos_span"]
    lo, hi = (dt.date.fromisoformat(x) for x in span)
    n_trials = m.dsr_trial_count(int(ev["global_trials_after"]))
    d = ROOT / "research" / "experiments" / exp
    summary, lines = {}, [f"# {exp} — SPEC-0001 round 3 {'HOLDOUT' if holdout else 'fixed-rule OOS'} report", "",
                          f"Span {lo} → {hi}; DSR trials = {n_trials} (global). Primary account US$600; capital table below.", ""]
    if not m.legacy:
        lines[-1:-1] = [f"Method **{m.name}** (DEC-0011): CI95 by {m.bootstrap_block} blocks, stress over every fill, "
                        f"stop-slippage stress {list(m.stop_slip_stress)}, $ = realised Trade.pnl."]
    for f in sorted(d.glob("results_*.json")):
        res = json.loads(f.read_text())
        if not m.legacy and res.get("method") != m.name:     # never mix fill models inside one corrected report
            raise ValueError(f"{f.name} was simulated with method {res.get('method', 'legacy')!r}; "
                             f"--method {m.name} evaluates only results r3_run produced with --method {m.name}")
        controls = res.get("control_means", {})
        for trial, by_eq in res["trades"].items():
            per_eq = {}
            for eq, rows in by_eq.items():
                df = pd.DataFrame(rows)
                if len(df):
                    df["d"] = pd.to_datetime(df.date).dt.date
                    df = df[(df.d >= lo) & (df.d <= hi) & df.R.notna()].reset_index(drop=True)
                per_eq[eq] = df
            main_df = per_eq.get("600.0", pd.DataFrame())
            s = trial_stats(main_df, n_trials, controls.get(trial), m) if len(main_df) else {"n": 0}
            g = gates(s) if s.get("n", 0) >= 3 else {}
            cap = {eq: {"n": int(len(x)), "E_R": round(float(x.R.mean()), 3) if len(x) else None,
                        "pnl_usd": round(realised_usd(x) if m.pnl == "realised" else
                                         float((x.R * float(eq) * spec["risk"]["per_trade_risk_pct_of_equity"] / 100).sum()), 2) if len(x) else 0.0}
                   for eq, x in per_eq.items()}
            skips = {k: v for k, v in res.get("skips", {}).get(trial, res.get("skips", {})).items()} if isinstance(res.get("skips"), dict) else {}
            summary[trial] = {"stats": s, "gates": g, "pass": bool(g) and all(g.values()), "capital": cap, "skips": skips}
            ci = s.get("ci95_expectancy")
            lines += [f"## {trial}", "",
                      f"- n {s.get('n', 0)} · E[R] {s.get('expectancy_R', float('nan')):+.3f} · CI95 {ci} · PF {s.get('profit_factor')} · "
                      f"win {s.get('win_rate')} · DSR {s.get('dsr_prob')} · control p {s.get('random_control_p')}",
                      f"- stress 1.5x {s.get('stress_1.5x')} · 2x {s.get('stress_2.0x')}",
                      *(["- stop-slippage stress " + " · ".join(f"{k}x {s.get(f'stop_stress_{k}x')}" for k in m.stop_slip_stress)]
                        if m.stop_slip_stress else []),
                      f"- years profitable {s.get('years_profitable')} · max month share {s.get('max_month_share_of_profit')}",
                      f"- capital {cap}",
                      f"- gates {g} → **{'PASS' if summary[trial]['pass'] else 'FAIL'}**",
                      f"- holdout eligible (CI95 lower > 0): {bool(ci and ci[0] > 0)}", ""]
    name = ("r3_holdout" if holdout else "r3_eval") + ("" if m.legacy else f"_{m.name}")
    (d / f"{name}.json").write_text(json.dumps(summary, indent=1, default=str))
    (d / f"{name}.md").write_text("\n".join(lines))
    write_manifest(d, {"exp": exp, "holdout": holdout, "method": m.name, "dsr_trials": n_trials},
                   sorted(d.glob("results_*.json")), name=f"manifest_{name}.json")
    print("\n".join(lines))
    return summary


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("exp")
    ap.add_argument("--holdout", action="store_true")
    ap.add_argument("--method", default="legacy", choices=sorted(METHODS), help="methodology preset (DEC-0011)")
    args = ap.parse_args()
    main(args.exp, args.holdout, args.method)
