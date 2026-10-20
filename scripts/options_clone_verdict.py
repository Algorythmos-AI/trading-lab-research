"""EXP-0024's report, written once (DEC-0030, section 6).

    python scripts/options_clone_verdict.py --journal <options_journal.jsonl> [--out research/experiments/EXP-0024-...]

Writes report.md and result.json only when at least one setup has reached 30 trades and 20 sessions, and refuses to
write over a report that exists: a later look is a new experiment. Counts and statistics only.
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


def render(res: dict) -> str:
    lines = ["# EXP-0024: the options clone, forward on paper: report", "",
             "- Decision: DEC-0030. Unit: return on premium from fills, after $0.03 a contract each way.",
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
    a = ap.parse_args(argv)
    report = a.out / "report.md"
    if report.exists():
        print(f"refused: {report} exists; a later look is a new experiment", file=sys.stderr)
        return 1
    rows = [json.loads(x) for x in a.journal.read_text().splitlines() if x.strip()]
    res = review.review([r for r in rows if r.get("event") == "trade_closed"])
    if all(f["verdict"] == "none" for k, f in res.items() if k in review.SETUPS):
        print("no verdict yet: " + "; ".join(f"{k}: {'; '.join(f['why'])}" for k, f in res.items() if k in review.SETUPS))
        return 0
    a.out.mkdir(parents=True, exist_ok=True)
    (a.out / "result.json").write_text(json.dumps(res, indent=1))
    report.write_text(render(res))
    print(f"wrote {report}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
