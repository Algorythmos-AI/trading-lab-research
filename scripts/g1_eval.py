"""G1 evaluation: walk-forward selection among pre-registered variants + random control + gate checks.

Input: a development-span experiment produced by g1_run.py (all configs, 2019-01-02 -> 2025-09-25).
For each strategy FAMILY (setup), each fold picks the variant (management x window) with the best
fit-window expectancy (min 20 trades), then records that variant's trades in the next 3-month test
window. Out-of-sample trades are pooled -> stats, DSR (trials = ALL configs evaluated), random-control
p-value, cost stress, year consistency. Writes research/experiments/<exp>/g1_report.md
"""
from __future__ import annotations

import datetime as dt
import json
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from wt.backtest.stats import deflated_sharpe_prob, random_control_pvalue, summarize  # noqa: E402
from wt.core.config import ROOT  # noqa: E402

DEV_START, DEV_END = dt.date(2019, 1, 2), dt.date(2025, 9, 25)


def folds():
    out, test_start = [], dt.date(2020, 1, 1)
    while test_start <= DEV_END:
        fit_start = (pd.Timestamp(test_start) - pd.DateOffset(months=12)).date()
        test_end = min((pd.Timestamp(test_start) + pd.DateOffset(months=3)).date() - dt.timedelta(days=1), DEV_END)
        out.append((fit_start, test_start, test_end))
        test_start = (pd.Timestamp(test_start) + pd.DateOffset(months=3)).date()
    return out


def main(exp_id: str, control_exp: str | None = None, family_fields: int = 1, n_trials_override: int | None = None) -> dict:
    exp = ROOT / "research/experiments" / exp_id
    res = json.loads((exp / "results.json").read_text())
    n_trials = n_trials_override or res["n_trials"]
    by_family = defaultdict(dict)
    for name, r in res["results"].items():
        fam = "|".join(name.split("|")[:family_fields])
        df = pd.DataFrame(r["trades"])
        if len(df):
            df["d"] = pd.to_datetime(df.date).dt.date
            df = df[(df.d >= DEV_START) & (df.d <= DEV_END)]          # holdout never read here
        by_family[fam][name] = df
    ctrl = None
    if control_exp:
        cres = json.loads((ROOT / "research/experiments" / control_exp / "results.json").read_text())
        ctrl = cres["results"]
    lines = [f"# G1 walk-forward report — {exp_id}", "",
             f"Dev span {DEV_START} → {DEV_END} (holdout 2025-09-26 → 2026-09-25 untouched). "
             f"Trials counted for DSR: **{n_trials}** (all configs evaluated).", ""]
    summary = {}
    for fam, variants in by_family.items():
        oos, picks = [], []
        for fs, ts, te in folds():
            best, best_e = None, -9
            for name, df in variants.items():
                if not len(df):
                    continue
                fit = df[(df.d >= fs) & (df.d < ts)]
                if len(fit) >= 20 and fit.R.mean() > best_e:
                    best, best_e = name, fit.R.mean()
            if best:
                t = variants[best]
                oos.append(t[(t.d >= ts) & (t.d <= te)])
                picks.append((str(ts), best, round(best_e, 3)))
        o = pd.concat(oos) if oos else pd.DataFrame(columns=["R"])
        s = summarize(o.R.to_numpy()) if len(o) else {"n": 0}
        if s.get("n", 0) > 2:
            s["dsr_prob"] = deflated_sharpe_prob(s["per_trade_sharpe"], s["n"], n_trials, s["skew"], s["kurtosis"])
            yrs = o.groupby(pd.to_datetime(o.date).dt.year).R.sum()
            s["years_profitable"] = f"{int((yrs > 0).sum())}/{len(yrs)}"
            months = o.groupby(pd.to_datetime(o.date).dt.to_period("M")).R.sum()
            s["max_month_share_of_profit"] = float(months.max() / months[months > 0].sum()) if (months > 0).any() else None
        if ctrl is not None and s.get("n", 0) > 2:
            cm = [m for k, c in ctrl.items() if k.startswith(fam) for m in c.get("control_means", [])]
            if cm:
                s["random_control_p"] = random_control_pvalue(s["expectancy_R"], np.array(cm))
        gate = {
            "ci_lower_gt_0": s.get("ci95_expectancy", [0])[0] > 0,
            "dsr_gt_0.95": s.get("dsr_prob", 0) > 0.95,
            "pf_ge_1.2": s.get("profit_factor", 0) >= 1.2,
            "random_control_p_lt_0.05": s.get("random_control_p", 1) < 0.05,
            "n_ge_100": s.get("n", 0) >= 100,
        }
        s["G1_pass_so_far"] = all(gate.values())
        summary[fam] = {"stats": s, "gate": gate, "fold_picks": picks}
        lines += [f"## {fam}", "", f"- OOS trades: {s.get('n', 0)}; expectancy {s.get('expectancy_R', 0):+.3f}R; "
                  f"win {s.get('win_rate', 0):.0%}; PF {s.get('profit_factor', 0):.2f}; CI95 {s.get('ci95_expectancy')}",
                  f"- DSR prob {s.get('dsr_prob')}; years profitable {s.get('years_profitable')}; "
                  f"random-control p {s.get('random_control_p')}",
                  f"- Gate: {gate} → **{'PASS' if s['G1_pass_so_far'] else 'FAIL'}**", ""]
    (exp / "g1_eval.json").write_text(json.dumps(summary, indent=1, default=str))
    (exp / "g1_report.md").write_text("\n".join(lines))
    print("\n".join(lines))
    return summary


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] != "-" else None,
         int(sys.argv[3]) if len(sys.argv) > 3 else 1)
