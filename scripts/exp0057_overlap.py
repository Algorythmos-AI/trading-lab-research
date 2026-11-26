"""EXP-0057 phase 1: the EDGAR proxy's agreement with classifier v3 on fiscal.ai headlines (wt.research.exp0057).

Refuses to run until DEC-0081 reads ACCEPTED (no count before acceptance). For each session in the range with both a
pool (`data/candidates/DATE.parquet`) and its sidecar (`data/candidates_edgar/DATE.parquet`), it pairs the two and
writes `phase1_report.json` and `phase1_report.md` to the experiment folder. Counts only: no price, entry, exit or
result is read or written.

Usage: PYTHONPATH=src .venv/bin/python scripts/exp0057_overlap.py 2026-04-30 2026-11-25 [--data DIR] [--out DIR]
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


def _pct(s: dict[str, Any]) -> str:
    if not s["n"]:
        return "no name-days"
    lo, hi = s["wilson95"]
    return f"{s['share']:.1%} ({s['hits']} of {s['n']}; Wilson 95% {lo:.1%} to {hi:.1%})"


def markdown(rep: dict[str, Any], start: dt.date, end: dt.date, sessions: int) -> str:
    return "\n".join([
        "# EXP-0057 phase 1: EDGAR proxy against classifier v3 on fiscal.ai headlines",
        "",
        f"- Sessions {start} to {end} with a pool and its sidecar: {sessions}. Counts only.",
        f"- **Verdict: {rep['verdict']}** (recall at least {rep['thresholds']['recall_min']:.0%} on at least "
        f"{rep['thresholds']['min_name_days']} name-days, each). This is {rep['reference']}.",
        f"- Name-days {rep['name_days']}; unknown (dropped) {rep['unknown_name_days']}; compared "
        f"{rep['compared_name_days']}.",
        "",
        "| Measure | Value |",
        "|---|---|",
        f"| Buyout recall (the test) | {_pct(rep['buyout_recall'])} |",
        f"| Earnings recall (the test) | {_pct(rep['earnings_recall'])} |",
        f"| Buyout precision | {_pct(rep['buyout_precision'])} |",
        f"| Earnings precision | {_pct(rep['earnings_precision'])} |",
        f"| Presence agreement | {_pct(rep['presence_agreement'])} |",
        f"| Median lag, first qualifying headline to earnings filing (minutes) | "
        f"{rep['median_lag_minutes'] if rep['median_lag_minutes'] is not None else '-'} (n {rep['lag_n']}) |",
        "",
    ])


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("start", type=dt.date.fromisoformat)
    ap.add_argument("end", type=dt.date.fromisoformat)
    ap.add_argument("--data", type=Path, default=DATA_DIR)
    ap.add_argument("--out", type=Path, default=OUT)
    ap.add_argument("--decision", type=Path, default=DECISION)
    a = ap.parse_args(argv)
    if not exp0057.accepted(a.decision.read_text()):
        print("EXP-0057: DEC-0081 is not ACCEPTED; nothing is counted")
        return 2
    if a.start < FIRST or a.end > LAST:
        print(f"EXP-0057: phase 1 is frozen to {FIRST}..{LAST}")
        return 2
    days, n = [], 0
    for p in sorted((a.data / "candidates").glob("*.parquet")):
        if not a.start.isoformat() <= p.stem <= a.end.isoformat():
            continue
        side = a.data / "candidates_edgar" / p.name
        if not side.exists():
            print(f"EXP-0057: {p.stem} has a pool but no sidecar: run scripts/annotate_edgar.py first")
            return 1
        days.append(exp0057.pair(pd.read_parquet(p), pd.read_parquet(side)))
        n += 1
    rep = exp0057.measure(days)
    rep["sessions"] = n
    rep["span"] = [a.start.isoformat(), a.end.isoformat()]
    a.out.mkdir(parents=True, exist_ok=True)
    (a.out / "phase1_report.json").write_text(json.dumps(rep, indent=1, sort_keys=True) + "\n")
    (a.out / "phase1_report.md").write_text(markdown(rep, a.start, a.end, n))
    print(f"EXP-0057 phase 1: {n} sessions, verdict {rep['verdict']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
