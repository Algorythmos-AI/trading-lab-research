"""Combined G1 report across all development experiments with a GLOBAL trial count for DSR.
Usage: python scripts/g1_report_all.py  (reads the experiment list below; skips missing ones)"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import g1_eval  # noqa: E402
from wt.core.config import ROOT  # noqa: E402

EXPS = [  # (strategy experiment, control experiment, family fields)
    ("EXP-0005b-g1-etf-dev-realcost", "EXP-0006b-g1-etf-controls-realcost", 2),
    ("EXP-0007-g1-liquid-dev", "EXP-0009-g1-liquid-controls", 1),
    ("EXP-0008-g1-watchlist-dev", "EXP-0010-g1-watchlist-controls", 1),
]


def main() -> None:
    present = [(e, c, f) for e, c, f in EXPS if (ROOT / "research/experiments" / e / "results.json").exists()]
    total = sum(json.loads((ROOT / "research/experiments" / e / "results.json").read_text())["n_trials"] for e, _, _ in present)
    lines = ["# G1 combined development report", "", f"Global trials counted for DSR: **{total}** "
             f"across {[e for e, _, _ in present]}. Holdout 2025-09-26 → 2026-09-25 untouched.", "",
             "| Family | OOS n | E[R] | CI95 | PF | DSR | random-control p | years + | Gate |", "|---|---|---|---|---|---|---|---|---|"]
    allsum = {}
    for e, c, f in present:
        ctrl = c if (ROOT / "research/experiments" / c / "results.json").exists() else None
        summ = g1_eval.main(e, ctrl, f, n_trials_override=total)
        for fam, v in summ.items():
            s = v["stats"]
            allsum[fam] = v
            ci = s.get("ci95_expectancy") or [0, 0]
            lines.append(f"| {fam} | {s.get('n', 0)} | {s.get('expectancy_R', 0):+.3f} | [{ci[0]:+.3f}, {ci[1]:+.3f}] | "
                         f"{s.get('profit_factor', 0):.2f} | {s.get('dsr_prob', 0) or 0:.3f} | {s.get('random_control_p')} | "
                         f"{s.get('years_profitable')} | {'PASS' if s.get('G1_pass_so_far') else 'FAIL'} |")
    out = ROOT / "research/experiments/G1-combined-report.md"
    out.write_text("\n".join(lines) + "\n")
    (ROOT / "research/experiments/G1-combined.json").write_text(json.dumps(allsum, indent=1, default=str))
    print("\n".join(lines))


if __name__ == "__main__":
    main()
