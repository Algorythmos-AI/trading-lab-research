"""EXP-0030's reports, each written once (DEC-0041 point 7; wt.options.arms_verdict).

    python scripts/options_clone_arms_verdict.py --journal <options_journal.jsonl> --state <var/options> \
        [--out research/experiments/EXP-0030-options-clone-research-arms] [--today YYYY-MM-DD]

For each of the fourteen trials: when it has reached its count (30 units, per group for a tag arm, and 20 sessions)
or the close date (2027-11-05), writes `<out>/<TRIAL>/report.md` and `result.json`, and never writes over a report
that exists. Before then it prints counts only, never a mean or a split of returns.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from wt.options import arms_verdict as av  # noqa: E402

OUT = ROOT / "research" / "experiments" / "EXP-0030-options-clone-research-arms"


def jsonl(paths: list[Path]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for p in paths:
        try:
            lines = p.read_text().splitlines()
        except OSError:
            continue
        for line in lines:
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            if isinstance(rec, dict):
                out.append(rec)
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--journal", type=Path, required=True)
    ap.add_argument("--state", type=Path, required=True, help="the clone's state folder (decisions/, shadow/)")
    ap.add_argument("--out", type=Path, default=OUT)
    ap.add_argument("--today", default=dt.datetime.now(ZoneInfo("America/New_York")).date().isoformat(),
                    help="the New York date the close date is measured against")
    a = ap.parse_args(argv)
    trades = jsonl([a.journal])
    decisions = jsonl(sorted((a.state / "decisions").glob("*.jsonl")))
    shadow = jsonl(sorted((a.state / "shadow").glob("*.jsonl")))
    for t in av.TRIALS:
        report = a.out / t.name / "report.md"
        if report.exists():
            print(f"{t.name}: report exists, not written again")
            continue
        us, unknown, no_release = av.units(t, trades, decisions, shadow)
        res = av.decide(t, us, a.today)
        if res["status"] == "pending":
            shown = {k: v for k, v in res.items() if k in ("tagged", "rest", "units", "sessions")}
            print(f"{t.name}: pending, counts only: {shown}, flag unknown {unknown}, release unknown {no_release}")
            continue
        report.parent.mkdir(parents=True, exist_ok=True)
        (report.parent / "result.json").write_text(json.dumps({**res, "flag_unknown": unknown,
                                                                   "release_unknown": no_release}, indent=1))
        report.write_text(av.render(res))
        print(f"{t.name}: wrote {report}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
