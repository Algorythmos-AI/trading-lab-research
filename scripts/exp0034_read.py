"""EXP-0034's read, run once (DEC-0051 section 8; wt.research.exp0034_read; docs/runbooks/exp0034-read.md).

    python scripts/exp0034_read.py --read --store <copy of the private store> --bars <saved SIP bars> \
        --start YYYY-MM-DD --params-hash <hex> --code-hash <hex> [--code-hash <defect-fix hex> ...] \
        --engine <label> [--engine <label> ...] --outcome-sha256 <hex> [--selection-switch YYYY-MM-DD] \
        [--today YYYY-MM-DD]

It refuses (exits non-zero and computes nothing) unless `--read` is given, the results file does not exist yet, no
early end is found, and the read is due (100 scored breaks in group a, or the close date). It then writes
research/experiments/EXP-0034-desk-signal-gates/results.json once, create-only, and prints the verdict.

Exit codes: 0 written; 2 refused (no --read, results already there, another run holding the lock, a counted
session's saved bars missing, failing their SHA-256 or naming another feed, or bad arguments); 3 an early end was
found, including a start date that is not the README's recorded one or not the first counted session (no verdict; its
dates and causes are printed for the README); 4 the read is not due yet (nothing printed but that). The date is the
real New York date: `--today` is refused outside the synthetic mode.

`--dry-run-synthetic` is for the tests only: it reads a store holding a file named SYNTHETIC and writes to `--out`.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import sys
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from wt.research import exp0034_read as er  # noqa: E402

OUT = ROOT / "research" / "experiments" / "EXP-0034-desk-signal-gates" / "results.json"
README = ROOT / "research" / "experiments" / "EXP-0034-desk-signal-gates" / "README.md"
START_LINE = re.compile(r"^- Window start date[^:]*:\s*(\d{4}-\d{2}-\d{2})\b", re.M)
CALENDAR = ROOT / "dashboard" / "src" / "lib" / "market-calendar.json"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--read", action="store_true", help="the one read; without it nothing runs")
    ap.add_argument("--dry-run-synthetic", action="store_true", help="tests only: a SYNTHETIC store, --out required")
    ap.add_argument("--store", type=Path)
    ap.add_argument("--bars", type=Path)
    ap.add_argument("--start")
    ap.add_argument("--params-hash")
    ap.add_argument("--code-hash", action="append", default=[])
    ap.add_argument("--engine", action="append", default=[])
    ap.add_argument("--outcome-sha256")
    ap.add_argument("--selection-switch")
    ap.add_argument("--today")
    ap.add_argument("--calendar", type=Path, default=CALENDAR)
    ap.add_argument("--out", type=Path)
    ap.add_argument("--readme", type=Path, default=README)
    a = ap.parse_args(argv)

    if not a.read:
        print("refused: the read runs only with --read, once, when it is due (docs/runbooks/exp0034-read.md)")
        return 2
    out: Path = OUT
    if a.dry_run_synthetic:
        if a.out is None or a.store is None or not (a.store / "SYNTHETIC").is_file():
            print("refused: --dry-run-synthetic needs --out and a store holding a SYNTHETIC marker")
            return 2
        out = a.out
    elif a.out is not None or a.today is not None or a.readme != README:
        print("refused: --out, --today and --readme are for --dry-run-synthetic only")
        return 2
    if out.exists():
        print(f"refused: {out} exists; the read is run once")
        return 2
    missing = [n for n in ("store", "bars", "start", "params_hash", "outcome_sha256") if getattr(a, n) is None]
    if missing or not a.code_hash or not a.engine:
        print("refused: missing " + ", ".join(missing + (["code_hash"] if not a.code_hash else [])
                                             + (["engine"] if not a.engine else [])))
        return 2
    today = a.today or dt.datetime.now(ZoneInfo("America/New_York")).date().isoformat()
    m = START_LINE.search(a.readme.read_text()) if a.readme.is_file() else None
    window = er.Window(a.start, er.close_date_of(a.start), today, a.selection_switch, m.group(1) if m else None)
    frozen = er.Frozen(a.params_hash, frozenset(a.code_hash), frozenset(a.engine), a.outcome_sha256)
    lock = out.with_name(out.name + ".lock")
    out.parent.mkdir(parents=True, exist_ok=True)
    try:
        fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        print(f"refused: {lock} exists; another read is running (remove it only if none is)")
        return 2
    try:
        os.close(fd)
        return _read(a, out, window, frozen)
    finally:
        lock.unlink(missing_ok=True)


def _read(a: argparse.Namespace, out: Path, window: er.Window, frozen: er.Frozen) -> int:
    if out.exists():
        print(f"refused: {out} exists; the read is run once")
        return 2
    try:
        p, report = er.run_read(a.store, a.bars, er.Calendar.load(a.calendar), window, frozen)
    except er.BarsRefused as e:
        print(f"refused: the saved bars of {e.day}: {e.why}; nothing computed")
        return 2
    if p.early:
        print("early end: no verdict is worked out")
        for e in p.early:
            print(f"  {e['day']}: {e['cause']}")
        return 3
    if report is None:
        print("not due: the read waits for 100 scored breaks in group a or the close date")
        return 4
    with open(out, "x") as fh:
        json.dump(report, fh, indent=2, sort_keys=True)
        fh.write("\n")
    print(f"written {out}: verdict {report['verdict']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
