"""Build data/edgar/events.parquet: the kept SEC filing forms for every mapped CIK (wt.data.edgar_events).

Data only: it counts nothing against the candidate pools and computes no R or P&L. It resumes after a kill (per-CIK
chunk checkpoints in data/edgar/events_parts/) and stops cleanly if SEC keeps throttling, so a rerun picks up where it
left off. About 9k CIKs at 5 requests/s takes roughly an hour; run it on the Mac, never on the host.

Usage: PYTHONPATH=src .venv/bin/python scripts/build_edgar_events.py [--limit N] [--assemble-only] [--summary]
       [--data DIR]   (DIR holds edgar/ticker_cik.parquet; defaults to the checkout's data/)
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import pandas as pd

from wt.data import edgar_events as ee


def summary(ev: pd.DataFrame, unique: bool = False) -> pd.DataFrame:
    """Rows (cik, accession) per form per acceptance year (ET); unique=True counts each accession once."""
    if unique:
        ev = ev.drop_duplicates("accession")
    year = ev.accepted_at_et.dt.year.rename("year")
    return pd.crosstab(ev.form, year, margins=True, margins_name="all")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--limit", type=int, help="fetch at most N new CIKs, then stop (trial run; no assemble)")
    ap.add_argument("--chunk", type=int, default=50, help="CIKs per checkpoint")
    ap.add_argument("--assemble-only", action="store_true", help="rebuild events.parquet from the checkpoints")
    ap.add_argument("--summary", action="store_true", help="print filings per form per year after the build")
    ap.add_argument("--data", type=Path, help="data directory (default: the checkout's data/)")
    a = ap.parse_args(argv)
    data = a.data or ee.DATA_DIR
    tm = pd.read_parquet(data / "edgar" / "ticker_cik.parquet")
    parts, out = data / "edgar" / "events_parts", data / "edgar" / "events.parquet"
    if a.assemble_only:
        ev = ee.assemble(tm, parts, out)
    else:
        try:
            ev = ee.build(ticker_map=tm, parts=parts, out=out, chunk=a.chunk, limit=a.limit)
        except ee.Throttled as e:
            print(f"stopped: {e}; rerun to resume", file=sys.stderr)
            return 2
    if ev is None:
        return 0
    print(f"events: {len(ev)} rows, {ev.accession.nunique()} filings, {ev.cik.nunique()} CIKs -> {out}")
    if a.summary:
        with pd.option_context("display.width", 200, "display.max_columns", 20):
            print("rows (cik, accession) per form per year:")
            print(summary(ev))
            print("unique accessions per form per year:")
            print(summary(ev, unique=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
