"""Offline parity for the tail loader on the real daily store (plan v7 A-P2, tier 1). No network.

Checks, symbol batch by symbol batch (so the full history is never all in memory):
  1. load_daily_tail(rows) equals load_daily() cut to each symbol's last `rows` rows: same values, dtypes and order,
     and TailMeta.first_kept names exactly the symbols that lost rows.
  2. DailyIndex over the tail answers on(d) and before(s, d, lookback) exactly like one over the full history for
     the newest `--sessions` sessions, or raises TailWindowExceeded; it never returns a shortened history.

Usage: python scripts/daily_tail_parity.py [--rows N] [--sessions 60] [--lookback 300] [--batch 400]
Exit status 1 on any difference."""
from __future__ import annotations

import argparse
import datetime as dt
import resource
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from wt.data.universe import TailWindowExceeded, load_daily_symbols, load_daily_tail, tail_rows_for  # noqa: E402
from wt.scanner.pool import DailyIndex  # noqa: E402

VALUES = ["o", "h", "l", "c", "v", "n", "vw"]


def same(a: pd.DataFrame, b: pd.DataFrame) -> bool:
    if len(a) != len(b) or list(a.columns) != list(b.columns):
        return False
    return all(np.array_equal(a[c].to_numpy(), b[c].to_numpy(), equal_nan=a[c].dtype.kind == "f") for c in a.columns
               if c != "symbol") and list(a.symbol) == list(b.symbol)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--rows", type=int)
    ap.add_argument("--sessions", type=int, default=60)
    ap.add_argument("--lookback", type=int, default=300)
    ap.add_argument("--batch", type=int, default=400)
    args = ap.parse_args()
    t0 = time.time()
    rows = args.rows or tail_rows_for(dt.date.today(), args.lookback)
    tail, meta = load_daily_tail(rows)
    print(f"tail: {len(tail):,} rows, {tail.symbol.nunique():,} symbols, rows/symbol {rows}, data_end {meta.data_end}, "
          f"complete_from {meta.complete_from}, {len(meta.first_kept):,} cut ({time.time() - t0:.1f}s)", flush=True)
    days = sorted(set(tail.date))[-args.sessions:]
    tix = DailyIndex(tail, meta)
    symbols = sorted(tail.symbol.unique())
    bad, checked, raised = [], 0, 0
    for i in range(0, len(symbols), args.batch):
        batch = symbols[i:i + args.batch]
        full = load_daily_symbols(batch)
        want = full.groupby("symbol", sort=False).tail(rows).reset_index(drop=True)
        got = tail[tail.symbol.isin(set(batch))].reset_index(drop=True)
        if not (same(got, want) and got.dtypes.equals(want.dtypes)):
            bad.append(f"frame differs in batch {batch[0]}..{batch[-1]}")
        counts = full.groupby("symbol").size()
        if set(counts[counts > rows].index) != {s for s in batch if s in meta.first_kept}:
            bad.append(f"first_kept differs in batch {batch[0]}..{batch[-1]}")
        fix = DailyIndex(full)
        for d in days:
            a = tix.on(d)
            a = a[a.index.isin(set(batch))]
            b = fix.on(d)
            if not (a.index.equals(b.index) and all(np.array_equal(a[c].to_numpy(), b[c].to_numpy()) for c in VALUES)):
                bad.append(f"on({d}) differs in batch {batch[0]}..{batch[-1]}")
            for s in batch:
                try:
                    x = tix.before(s, d, args.lookback)
                except TailWindowExceeded:
                    raised += 1
                    continue
                if not same(x.reset_index(drop=True), fix.before(s, d, args.lookback).reset_index(drop=True)):
                    bad.append(f"before({s}, {d}) differs")
                checked += 1
        print(f"  {min(i + args.batch, len(symbols)):,}/{len(symbols):,} symbols, {checked:,} lookups exact, "
              f"{raised:,} raised, {len(bad)} differences ({time.time() - t0:.0f}s)", flush=True)
        del full, fix
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / (1e6 if sys.platform == "darwin" else 1e3)
    print(f"{'PASS' if not bad else 'FAIL'}: {checked:,} lookups exact, {raised:,} raised, {len(bad)} differences; "
          f"max RSS {peak:.0f} MB")
    for b in bad[:20]:
        print("  ", b)
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
