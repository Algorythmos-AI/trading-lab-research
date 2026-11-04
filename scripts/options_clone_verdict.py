"""EXP-0024's report, written once (DEC-0030, section 6).

    python scripts/options_clone_verdict.py --journal <options_journal.jsonl> [--out research/experiments/EXP-0024-...]
    python scripts/options_clone_verdict.py --journal <...> --trials nearest --out research/experiments/EXP-0026-...
    python scripts/options_clone_verdict.py --journal <...> --rules cap15 --trials retest,rejection,nearest \
        --out research/experiments/EXP-0028-...
    python scripts/options_clone_verdict.py --journal <...> --rules spread5 --trials retest,rejection,nearest \
        --out research/experiments/EXP-0029-...

Writes report.md and result.json only when at least one of the trials has reached 30 trades and 20 sessions, and
refuses to write over a report that exists: a later look is a new experiment. Counts and statistics only. The default
trials are the two same-day setups (EXP-0024); `nearest` is HYP-0031's (EXP-0026, DEC-0034). `--rules` picks the
window (DEC-0039): `old` (the default) counts sessions up to 2026-10-29, `cap15` 2026-10-30 to 2026-11-04 (EXP-0028),
`spread5` from 2026-11-05 (EXP-0029, DEC-0040).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from wt.options import review  # noqa: E402

OUT = ROOT / "research" / "experiments" / "EXP-0024-options-clone-forward"


TITLES = {"EXP-0024": "the options clone, forward on paper", "EXP-0026": "the options clone on the nearest expiry",
          "EXP-0028": "the options clone under the $15.00 cap",
          "EXP-0029": "the options clone under the $5.00 spread cap"}
DECISIONS = {"EXP-0024": "DEC-0030", "EXP-0026": "DEC-0034", "EXP-0028": "DEC-0039", "EXP-0029": "DEC-0040"}


def render(res: dict, exp: str = "EXP-0024") -> str:
    lines = [f"# {exp}: {TITLES.get(exp, 'the options clone')}: report", "",
             f"- Decision: {DECISIONS.get(exp, 'DEC-0030')}. Unit: return on premium from fills, after $0.03 a contract "
             "each way.",
             "- Ranges: percentile bootstrap of the mean, 5000 resamples, seed 7, by session (the verdict) and by trade.",
             "", "| Setup | Trades | Sessions | Mean on premium | Range by session | Range by trade | Halves | "
             "Profit factor | Max drawdown | Verdict |", "|---|---|---|---|---|---|---|---|---|---|"]
    for s, f in res.items():
        lines.append(f"| {s} | {f['trades']} | {f['sessions']} | {f.get('mean_rop')} | {f.get('ci_session')} | "
                     f"{f.get('ci_trade')} | {f.get('first_half_mean')} / {f.get('second_half_mean')} | "
                     f"{f.get('profit_factor')} | {f.get('max_drawdown_usd')} | **{f['verdict']}** ({'; '.join(f['why'])}) |")
    lines += ["", "A pass changes nothing by itself: position size never increases without a new decision record and "
              "the owner's approval.", ""]
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--journal", type=Path, required=True)
    ap.add_argument("--out", type=Path, default=OUT)
    ap.add_argument("--rules", choices=tuple(review.WINDOWS), default="old", help="which window of rules (DEC-0039, DEC-0040)")
    ap.add_argument("--trials", default=",".join(review.SETUPS), help=f"comma-separated, of {review.TRIALS}")
    a = ap.parse_args(argv)
    trials = tuple(t for t in a.trials.split(",") if t)
    if not trials or any(t not in review.TRIALS for t in trials):
        print(f"refused: --trials must be some of {review.TRIALS}", file=sys.stderr)
        return 2
    report = a.out / "report.md"
    if report.exists():
        print(f"refused: {report} exists; a later look is a new experiment", file=sys.stderr)
        return 1
    rows = [json.loads(x) for x in a.journal.read_text().splitlines() if x.strip()]
    res = review.review(review.in_window([r for r in rows if r.get("event") == "trade_closed"], a.rules), trials)
    if all(f["verdict"] == "none" for k, f in res.items() if k in trials):
        print("no verdict yet: " + "; ".join(f"{k}: {'; '.join(f['why'])}" for k, f in res.items() if k in trials))
        return 0
    a.out.mkdir(parents=True, exist_ok=True)
    (a.out / "result.json").write_text(json.dumps(res, indent=1))
    report.write_text(render(res, a.out.name[:8]))
    print(f"wrote {report}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
