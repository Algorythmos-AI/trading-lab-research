"""Why names left the SPEC-0001 funnel over a span of sessions, in counts (wt.analytics.funnel_reasons).

Reads the saved pools data/candidates/<date>.parquet for START..END (both included), runs the frozen funnel's own
description on each (wt.scanner.explain) and adds the sessions up. It reads only the pool columns known at the 09:25
decision (funnel_reasons.USED_COLUMNS): the headline text and every later column are never loaded. It makes no
network call and writes one JSON file.

Counts only: no R, no price, no symbol, no catalyst category and no headline is printed or written. A session in
which every kept name has no headline is a data gap (the news endpoint returns nothing before 2026-04-28), so the
table gives the totals over every session and again without those sessions.

Usage: python scripts/funnel_reasons.py START END [--out FILE]      (dates as YYYY-MM-DD)
Default output: var/funnel_reasons/funnel_reasons_<START>_<END>.json
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from wt.analytics import funnel_reasons as fr  # noqa: E402
from wt.core.config import STATE_DIR  # noqa: E402
from wt.scanner import pool as pool_mod  # noqa: E402
from wt.specs.loader import load_spec  # noqa: E402

SPEC_ID = "SPEC-0001"
OUT_DIR = STATE_DIR / "funnel_reasons"


def read_pool(path: Path) -> Any:
    """One pool file, only the columns the tally may read (a zero-row pool holds `date` and `symbol` alone)."""
    import pandas as pd
    import pyarrow.parquet as pq

    have = set(pq.read_schema(path).names)
    return pd.read_parquet(path, columns=[c for c in fr.USED_COLUMNS if c in have])


def pool_files(pool_dir: Path, start: dt.date, end: dt.date) -> list[tuple[str, Path]]:
    out = []
    for f in sorted(pool_dir.glob("*.parquet")):
        try:
            d = dt.date.fromisoformat(f.stem)
        except ValueError:
            continue
        if start <= d <= end:
            out.append((d.isoformat(), f))
    return out


def run(start: dt.date, end: dt.date, pool_dir: Path | None = None) -> dict[str, Any]:
    spec = load_spec(SPEC_ID)
    days: dict[str, dict[str, Any]] = {}
    unreadable: list[str] = []
    files = pool_files(pool_dir or pool_mod.POOL_DIR, start, end)
    for day, path in files:
        try:
            days[day] = fr.session(read_pool(path), spec)
        except Exception:  # noqa: BLE001 — one bad file is counted and named by its date, and costs nothing else
            unreadable.append(day)
    return {"tool": "funnel_reasons", "spec": SPEC_ID, "start": start.isoformat(), "end": end.isoformat(),
            "pool_files": len(files), "unreadable": unreadable, "total": fr.total(days), "sessions": days}


def table(doc: dict[str, Any]) -> str:
    t = doc["total"]
    a, b = t["all"], t["excluding_data_gap"]
    L = [f"Funnel rejection tally, {doc['spec']}, {doc['start']} to {doc['end']} (counts only)",
         f"pool files {doc['pool_files']} · read {t['sessions']} ({t['first'] or '-'} to {t['last'] or '-'}) · "
         f"unreadable {len(doc['unreadable'])} · no kept name {t['sessions_empty']}",
         f"sessions with a Tier 2 name: {t['sessions_with_tier2']}",
         f"DATA GAP, not a finding: {t['sessions_data_gap']} session(s) where every kept name has no headline "
         f"({t['data_gap_before_news_start']} before {t['news_start']}, when the news endpoint returns nothing; "
         f"{t['data_gap_on_or_after_news_start']} on or after it)", ""]
    w = 34

    def block(title: str, key: str, note: str = "") -> None:
        L.append(f"{title:<{w}}{'all':>10}{'no gap':>10}{note}")
        for k in a[key]:
            L.append(f"  {k:<{w - 2}}{a[key][k]:>10}{b[key].get(k, 0):>10}")
        L.append("")

    L.append(f"{'sessions':<{w}}{a['sessions']:>10}{b['sessions']:>10}")
    block("names reaching each step", "counts")
    block("hard filters failed (any)", "failed_by_reason", "   a name can fail several")
    block("hard filters failed (only one)", "sole_reason", "   the near misses")
    block("Tier 1 names failing a chart must", "chart_fail", "   a name can fail several")
    L.append(f"{'kept names with no headline':<{w}}{a['kept_no_headline']:>10}{b['kept_no_headline']:>10}")
    return "\n".join(L)


def main(argv: list[str] | None = None, pool_dir: Path | None = None) -> dict[str, Any]:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("start", type=dt.date.fromisoformat)
    ap.add_argument("end", type=dt.date.fromisoformat)
    ap.add_argument("--out", type=Path, default=None)
    args = ap.parse_args(argv)
    doc = run(args.start, args.end, pool_dir)
    out = args.out or OUT_DIR / f"funnel_reasons_{args.start}_{args.end}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc, indent=1) + "\n")
    print(table(doc))
    print(f"\nwrote {out}")
    return doc


if __name__ == "__main__":
    main()
