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
    {"id": "DEC-0061", "kind": "decision", "status": "accepted", "date": "2026-11-19"},
    {"id": "EXP-0043", "kind": "experiment", "status": "run", "date": "2026-11-19"},
    {"id": "EXP-0044", "kind": "experiment", "status": "run", "date": "2026-11-19"},
    {"id": "EXP-0045", "kind": "experiment", "status": "run", "date": "2026-11-19"},
    {"id": "EXP-0046", "kind": "experiment", "status": "run", "date": "2026-11-19"},
    {"id": "EXP-0047", "kind": "experiment", "status": "run", "date": "2026-11-19"},
    {"id": "EXP-0048", "kind": "experiment", "status": "run", "date": "2026-11-19"},
    {"id": "DEC-0062", "kind": "decision", "status": "accepted", "date": "2026-11-19"},
]
OWED: list[dict[str, str]] = [{"id": "EXP-0049", "status": "not run"}]
RERUNS = ("EXP-0043-g1-etf-dev-dedup", "EXP-0044-g1-etf-dev-dec0011", "EXP-0045-holdout-B-rescore",
          "EXP-0046-g1-etf-controls-dedup", "EXP-0047-r2-B-iwm-dia-dedup")
EXPS = ROOT / "research/experiments"


def _f(v: Any, digits: int = 4) -> float | None:
    return None if v is None else round(float(v), digits)


def _ci(v: Any) -> list[float | None]:
    return [_f(v[0]), _f(v[1])]


def build() -> dict[str, Any]:
    raw = (EXP / "results.json").read_bytes()
    r = json.loads(raw)
    fr = r["frozen_rule"]
    trials = global_trial_count()
    years = fr["splits"]["year"]
    exits = fr["splits"]["exit_reason"]
    pw = r["power"]
    # G1 on corrected data: EXP-0044's own gate (g1_eval --method dec0011, B|QQQ, control EXP-0046), DEC-0061/0062.
    g1 = json.loads((EXPS / "EXP-0044-g1-etf-dev-dec0011/g1_eval_dec0011.json").read_text())["B|QQQ"]
    gs, gate = g1["stats"], g1["gate"]
    items = [
        {"id": "ci_lower", "pass": gate["ci_lower_gt_0"], "value": _f(gs["ci95_expectancy"][0]), "line": 0.0},
        {"id": "dsr", "pass": gate["dsr_gt_0.95"], "value": _f(gs["dsr_prob"]), "line": G1_DSR},
        {"id": "profit_factor", "pass": gate["pf_ge_1.2"], "value": _f(gs["profit_factor"]), "line": G1_PF},
        {"id": "random_control_p", "pass": gate["random_control_p_lt_0.05"], "value": _f(gs["random_control_p"]), "line": G1_P},
        {"id": "trades", "pass": gate["n_ge_100"], "value": gs["n"], "line": G1_N},
    ]
    ho = json.loads((EXPS / "EXP-0045-holdout-B-rescore/results.json").read_text())["summary"]
    done = sum(1 for e in RERUNS if (EXPS / e / "manifest.json").exists())
    return {
        "schema": SCHEMA,
        "source": {"experiment": "EXP-0042", "decision": "DEC-0061", "decision_status": "proposed",
                   "run_date": "2026-11-18", "results_sha256": hashlib.sha256(raw).hexdigest(),
                   "corrected_sha256": {e[:8]: hashlib.sha256((EXPS / e / f).read_bytes()).hexdigest()
                                        for e, f in (("EXP-0044-g1-etf-dev-dec0011", "g1_eval_dec0011.json"),
                                                     ("EXP-0045-holdout-B-rescore", "results.json"))}},
        "rule": {"version": "v1", "frozen": True, "record": "DEC-0037", "signal": "QQQ", "orders": "QQQM"},
        "evidence": {"label": "corrected" if done == len(RERUNS) else r["evidence_label"], "corrective_reruns_done": done,
                     "corrective_reruns_owed": len(RERUNS),
                     "corrupted_trades_found": len(r["unregistered"]["rc1_footprint_trades"]),
                     "trades_reading_corrupted_days": r["unregistered"]["trades_with_first_session_in_prior_14_sessions"]},
        "verdict": {"word": "SUSPEND", "record": "DEC-0062", "status": "accepted", "row": "V2"},
        "backtest": {"span": ["2019-01-02", "2025-09-25"], "trades": fr["n"], "expectancy_r": _f(fr["expectancy_R"]),
                     "ci95": _ci(fr["ci95_trade"]), "sd_r": _f(fr["sd_R"]), "win_rate": _f(fr["win_rate"]),
                     "profit_factor": _f(fr["profit_factor"]), "max_drawdown_r": _f(fr["max_drawdown_R"]),
                     "longest_losing_run": fr["longest_losing_run"], "total_r": _f(fr["total_R"]),
                     "expectancy_without_top10": _f(fr["expectancy_without_top10"]),
                     "years": [{"year": int(y), "trades": v["n"], "expectancy_r": _f(v["expectancy_R"])}
                               for y, v in sorted(years.items())]},
        "walk_forward": {"trades": gs["n"], "expectancy_r": _f(gs["expectancy_R"]), "ci95": _ci(gs["ci95_expectancy"])},
        "holdout": {"span": ["2025-09-26", "2026-09-25"], "trades": ho["n"], "expectancy_r": _f(ho["expectancy_R"]),
                    "ci95": _ci(ho["ci95_expectancy"]), "consumed": True},
        "g1": {"trials": trials, "items": items, "passed": sum(1 for i in items if i["pass"]), "of": len(items),
               "dsr_at_65": _f(r["dsr"]["walk_forward_trials_65"]["one_over_n"]),   # recorded, pre-correction
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
