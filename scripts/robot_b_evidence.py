"""Build dashboard/src/lib/robot-b-evidence.json, the Robot B page's research evidence (DEC-0061 section 4).

SAFE data only (AGENTS.md "Data classes"): ids, statuses, dates, counts, R-multiples, intervals and statistics, copied
field by field from EXP-0042's results.json and the trial registry. No configuration name, setup name or prose from a
record is written; the output is built from an explicit whitelist, never by copying a dict.

Usage:
  python scripts/robot_b_evidence.py            write the file
  python scripts/robot_b_evidence.py --check    fail if the committed file differs from a fresh build
"""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from wt.research.trials import global_trial_count  # noqa: E402

EXP = ROOT / "research/experiments/EXP-0042-b-audit-diagnostics"
OUT = ROOT / "dashboard/src/lib/robot-b-evidence.json"
SCHEMA = 1

# G1 (DEC-0007, scripts/g1_eval.py): the gate items and their lines.
G1_DSR, G1_PF, G1_P, G1_N = 0.95, 1.2, 0.05, 100

# The research trail: id, kind, status. Statuses are the records' own words; the planned ids are DEC-0061 section 3.
TRAIL: list[dict[str, str | None]] = [
    {"id": "DEC-0007", "kind": "decision", "status": "accepted", "date": "2026-09-28"},
    {"id": "EXP-0005b", "kind": "experiment", "status": "run", "date": None},
    {"id": "EXP-0011", "kind": "experiment", "status": "run (holdout, consumed)", "date": None},
    {"id": "DEC-0011", "kind": "decision", "status": "accepted", "date": "2026-10-25"},
    {"id": "DEC-0037", "kind": "decision", "status": "accepted", "date": "2026-10-24"},
    {"id": "EXP-0042", "kind": "experiment", "status": "run", "date": "2026-11-18"},
    {"id": "DEC-0061", "kind": "decision", "status": "proposed", "date": "2026-11-18"},
]
OWED: list[dict[str, str]] = [
    {"id": "EXP-0043", "status": "not run"}, {"id": "EXP-0044", "status": "not run"},
    {"id": "EXP-0045", "status": "not run"}, {"id": "EXP-0046", "status": "not run"},
    {"id": "EXP-0047", "status": "not run"}, {"id": "EXP-0048", "status": "not run"},
    {"id": "EXP-0049", "status": "not run"},
]


def _f(v: Any, digits: int = 4) -> float | None:
    return None if v is None else round(float(v), digits)


def _ci(v: Any) -> list[float | None]:
    return [_f(v[0]), _f(v[1])]


def build() -> dict[str, Any]:
    raw = (EXP / "results.json").read_bytes()
    r = json.loads(raw)
    fr, wf, ho = r["frozen_rule"], r["walk_forward"], r["reconcile"]["holdout"]
    trials = global_trial_count()
    years = fr["splits"]["year"]
    exits = fr["splits"]["exit_reason"]
    pw = r["power"]
    # G1 is gated on the walk-forward out-of-sample series (scripts/g1_eval.py); the random-control p is the recorded
    # G1 figure for that series (EXP-0005b g1_eval.json). DSR at the registry's count, gate method.
    g1_rec = json.loads((ROOT / "research/experiments/EXP-0005b-g1-etf-dev-realcost/g1_eval.json").read_text())["B|QQQ"]["stats"]
    dsr_now = r["dsr"]["walk_forward_trials_registry"]["one_over_n"]
    items = [
        {"id": "ci_lower", "pass": wf["ci95_trade"][0] > 0, "value": _f(wf["ci95_trade"][0]), "line": 0.0},
        {"id": "dsr", "pass": dsr_now > G1_DSR, "value": _f(dsr_now), "line": G1_DSR},
        {"id": "profit_factor", "pass": wf["profit_factor"] >= G1_PF, "value": _f(wf["profit_factor"]), "line": G1_PF},
        {"id": "random_control_p", "pass": g1_rec["random_control_p"] < G1_P, "value": _f(g1_rec["random_control_p"]),
         "line": G1_P},
        {"id": "trades", "pass": wf["n"] >= G1_N, "value": wf["n"], "line": G1_N},
    ]
    return {
        "schema": SCHEMA,
        "source": {"experiment": "EXP-0042", "decision": "DEC-0061", "decision_status": "proposed",
                   "run_date": "2026-11-18", "results_sha256": hashlib.sha256(raw).hexdigest()},
        "rule": {"version": "v1", "frozen": True, "record": "DEC-0037", "signal": "QQQ", "orders": "QQQM"},
        "evidence": {"label": r["evidence_label"], "corrective_reruns_done": 0, "corrective_reruns_owed": 5,
                     "corrupted_trades_found": len(r["unregistered"]["rc1_footprint_trades"]),
                     "trades_reading_corrupted_days": r["unregistered"]["trades_with_first_session_in_prior_14_sessions"]},
        "verdict": {"provisional": "SUSPEND", "record": "DEC-0061", "status": "proposed"},
        "backtest": {"span": ["2019-01-02", "2025-09-25"], "trades": fr["n"], "expectancy_r": _f(fr["expectancy_R"]),
                     "ci95": _ci(fr["ci95_trade"]), "sd_r": _f(fr["sd_R"]), "win_rate": _f(fr["win_rate"]),
                     "profit_factor": _f(fr["profit_factor"]), "max_drawdown_r": _f(fr["max_drawdown_R"]),
                     "longest_losing_run": fr["longest_losing_run"], "total_r": _f(fr["total_R"]),
                     "expectancy_without_top10": _f(fr["expectancy_without_top10"]),
                     "years": [{"year": int(y), "trades": v["n"], "expectancy_r": _f(v["expectancy_R"])}
                               for y, v in sorted(years.items())]},
        "walk_forward": {"trades": wf["n"], "expectancy_r": _f(wf["expectancy_R"]), "ci95": _ci(wf["ci95_trade"])},
        "holdout": {"span": ["2025-09-26", "2026-09-25"], "trades": ho["n"], "expectancy_r": _f(ho["expectancy_R"]),
                    "ci95": _ci(ho["ci95_expectancy"]), "consumed": True},
        "g1": {"trials": trials, "items": items, "passed": sum(1 for i in items if i["pass"]), "of": len(items),
               "dsr_at_65": _f(r["dsr"]["walk_forward_trials_65"]["one_over_n"]),
               "series": "walk_forward"},
        "exits": [{"kind": k, "trades": v["n"], "expectancy_r": _f(v["expectancy_R"])} for k, v in sorted(exits.items())
                  if k in ("eod_flatten", "stop", "target")],
        "runner_parity": {"untradable_trades": r["runner_parity"]["not_tradable_at_or_after_1530"]["n"],
                          "untradable_expectancy_r": _f(r["runner_parity"]["not_tradable_at_or_after_1530"]["expectancy_R"]),
                          "tradable_expectancy_r": _f(r["runner_parity"]["tradable"]["expectancy_R"])},
        "power": {"alpha": pw["alpha_one_sided"], "target_power": pw["target_power"],
                  "trades_per_session": _f(r["paper_aggregate"]["trades_per_armed_session"]),
                  "full_edge": {"edge_r": _f(pw["frozen_rule_dev"]["edge_R"]), "trades": round(pw["frozen_rule_dev"]["trades_needed"]),
                                "years": _f(pw["frozen_rule_dev"]["years_needed"], 1),
                                "power_at_g2b": _f(pw["frozen_rule_dev"]["power_at_g2b_trades"], 2)},
                  "half_edge": {"edge_r": _f(pw["half_frozen_rule_dev"]["edge_R"]), "trades": round(pw["half_frozen_rule_dev"]["trades_needed"]),
                                "years": _f(pw["half_frozen_rule_dev"]["years_needed"], 1),
                                "power_at_g2b": _f(pw["half_frozen_rule_dev"]["power_at_g2b_trades"], 2)},
                  "g2b_trades": pw["g2b_trades"], "min_track_record_trades": round(r["min_track_record_trades"]),
                  "rate_95": [_f(x, 2) for x in r["unregistered"]["paper_trades_per_session_95"]],
                  "dsr_needs_trades": r["unregistered"]["dsr_095_needs"]["trades_at_sharpe"]},
        "trail": TRAIL,
        "owed": OWED,
    }


def dump(obj: Any) -> str:
    return json.dumps(obj, indent=1, sort_keys=True) + "\n"


def main(argv: list[str]) -> int:
    out = dump(build())
    if "--check" in argv:
        if not OUT.exists() or OUT.read_text() != out:
            print(f"{OUT.relative_to(ROOT)} is missing or differs from a fresh build", file=sys.stderr)
            return 1
        print(f"{OUT.relative_to(ROOT)} matches a fresh build")
        return 0
    OUT.write_text(out)
    print(f"wrote {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
