"""EXP-0057 phase 1: the EDGAR proxy's agreement with classifier v3 on fiscal.ai headlines (wt.research.exp0057).

Refuses to run until DEC-0081 reads ACCEPTED (no count before acceptance). For each session in the range with both a
pool (`data/candidates/DATE.parquet`) and its sidecar (`data/candidates_edgar/DATE.parquet`), it pairs the two and
writes `phase1_report.json` and `phase1_report.md` to the experiment folder. Counts only: no price, entry, exit or
result is read or written.

`--secondary` runs the config's secondary comparison instead: the same measures on the Benzinga pools of 2018-12 and
2025-09 (2025-09-25 is the last development session, so the holdout is not read). It writes `secondary_report.json`
and `.md`, is reported only and never part of the pass. Each of the two reports is written once; a second run is
refused.

Usage: PYTHONPATH=src .venv/bin/python scripts/exp0057_overlap.py 2026-04-30 2026-11-25 [--data DIR] [--out DIR]
       PYTHONPATH=src .venv/bin/python scripts/exp0057_overlap.py --secondary [--data DIR] [--out DIR]
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from pathlib import Path
from typing import Any

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from wt.core.config import DATA_DIR  # noqa: E402
from wt.research import exp0057  # noqa: E402

DECISION = ROOT / "research" / "decisions" / "DEC-0081-news-sources-after-benzinga.md"
OUT = ROOT / "research" / "experiments" / "EXP-0057-edgar-catalyst-proxy"
FIRST, LAST = dt.date(2026, 4, 30), dt.date(2026, 11, 25)       # frozen in EXP-0057's config
SECONDARY = ((dt.date(2018, 12, 1), dt.date(2018, 12, 31)), (dt.date(2025, 9, 1), dt.date(2025, 9, 25)))


def _pct(s: dict[str, Any]) -> str:
    if not s["n"]:
        return "no name-days"
    lo, hi = s["wilson95"]
    return f"{s['share']:.1%} ({s['hits']} of {s['n']}; Wilson 95% {lo:.1%} to {hi:.1%})"


def markdown(rep: dict[str, Any], spans: str, sessions: int, secondary: bool = False) -> str:
    title = ("# EXP-0057 phase 1, secondary: EDGAR proxy against classifier v3 on the 2018-12 and 2025-09 Benzinga pools"
             if secondary else "# EXP-0057 phase 1: EDGAR proxy against classifier v3 on fiscal.ai headlines")
    verdict = (f"- Reported only, not part of the pass (the rule's reading would be {rep['verdict']})"
               if secondary else f"- **Verdict: {rep['verdict']}**")
    tag = "" if secondary else " (the test)"
    return "\n".join([
        title,
        "",
        f"- Sessions {spans} with a pool and its sidecar: {sessions}. Counts only.",
        f"{verdict} (recall at least {rep['thresholds']['recall_min']:.0%} on at least "
        f"{rep['thresholds']['min_name_days']} name-days, each). This is "
        f"{'agreement with classifier v3 on Benzinga headlines, not accuracy' if secondary else rep['reference']}.",
        f"- Name-days {rep['name_days']}; unknown (dropped) {rep['unknown_name_days']}; compared "
        f"{rep['compared_name_days']}.",
        "",
        "| Measure | Value |",
        "|---|---|",
        f"| Buyout recall{tag} | {_pct(rep['buyout_recall'])} |",
        f"| Earnings recall{tag} | {_pct(rep['earnings_recall'])} |",
        f"| Buyout precision | {_pct(rep['buyout_precision'])} |",
        f"| Earnings precision | {_pct(rep['earnings_precision'])} |",
        f"| Presence agreement | {_pct(rep['presence_agreement'])} |",
        f"| Median lag, first qualifying headline to earnings filing (minutes) | "
        f"{rep['median_lag_minutes'] if rep['median_lag_minutes'] is not None else '-'} (n {rep['lag_n']}) |",
        "",
    ])


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("start", type=dt.date.fromisoformat, nargs="?")
    ap.add_argument("end", type=dt.date.fromisoformat, nargs="?")
    ap.add_argument("--secondary", action="store_true")
    ap.add_argument("--data", type=Path, default=DATA_DIR)
    ap.add_argument("--out", type=Path, default=OUT)
    ap.add_argument("--decision", type=Path, default=DECISION)
    a = ap.parse_args(argv)
    if not exp0057.accepted(a.decision.read_text()):
        print("EXP-0057: DEC-0081 is not ACCEPTED; nothing is counted")
        return 2
    if a.secondary:
        if a.start or a.end:
            print("EXP-0057: the secondary spans are frozen; give no dates")
            return 2
        spans, stem = SECONDARY, "secondary_report"
    else:
        if a.start is None or a.end is None or a.start < FIRST or a.end > LAST:
            print(f"EXP-0057: phase 1 is frozen to {FIRST}..{LAST}")
            return 2
        spans, stem = ((a.start, a.end),), "phase1_report"
    done = [f for f in (f"{stem}.json", f"{stem}.md") if (a.out / f).exists()]
    if done:
        print(f"EXP-0057: this report was written once ({', '.join(done)} exist); a re-run needs a new EXP id")
        return 2
    days, n = [], 0
    for p in sorted((a.data / "candidates").glob("*.parquet")):
        if not any(s.isoformat() <= p.stem <= e.isoformat() for s, e in spans):
            continue
        side = a.data / "candidates_edgar" / p.name
        if not side.exists():
            print(f"EXP-0057: {p.stem} has a pool but no sidecar: run scripts/annotate_edgar.py first")
            return 1
        days.append(exp0057.pair(pd.read_parquet(p), pd.read_parquet(side)))
        n += 1
    rep = exp0057.measure(days)
    rep["sessions"] = n
    rep["span"] = [[s.isoformat(), e.isoformat()] for s, e in spans] if a.secondary else [
        spans[0][0].isoformat(), spans[0][1].isoformat()]
    if a.secondary:
        rep["part_of_pass"] = False
    a.out.mkdir(parents=True, exist_ok=True)
    (a.out / f"{stem}.json").write_text(json.dumps(rep, indent=1, sort_keys=True) + "\n")
    (a.out / f"{stem}.md").write_text(markdown(rep, " and ".join(f"{s} to {e}" for s, e in spans), n, a.secondary))
    print(f"EXP-0057 {'secondary' if a.secondary else 'phase 1'}: {n} sessions, verdict {rep['verdict']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
