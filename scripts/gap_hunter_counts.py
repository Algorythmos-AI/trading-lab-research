"""Gap Hunter (HYP-0071, DEC-0068): counts only, one line a session. No R, no price, no symbol.

For each session in the range that has a 09:25 pool in data/candidates:
  primary   1 when the selection (wt.scanner.gap_hunter, read as the desk reads it: wt.live.runner_s.gap_selection)
            leaves a primary; otherwise 0 and the reason it left none
  e1..e4    for the primary, each registered gap entry on its own: `order` 1 when the rule had a valid order at any
            time, `reached` 1 when a bar reached it, `fill` 1 when the engine's fill arithmetic fills that bar
  day       the desk's own reading: the one order that may rest is the lowest valid trigger, and the first bar to
            reach it is the day's one attempt (`code` says which rule's order it was)

Two things these counts do not carry. The spread must needs quotes, and this reads minute bars only: every fill here
assumes a spread of at most two cents (slippage of one cent), so `fill` is an upper bound. And nothing after the entry
is read: no exit, no result.

It reads minute bars through wt.backtest.runner.minute_bars (the market-data API, cached in data/minute), so it runs
where the keys are. It places nothing.

Usage:
  PYTHONPATH=src .venv/bin/python scripts/gap_hunter_counts.py 2026-09-28 2026-11-19
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from wt.core.clock import et  # noqa: E402
from wt.live import runner_s  # noqa: E402
from wt.live import setups_live as sl  # noqa: E402

MIN_BARS = 30                       # as scripts/r3_run.py run_day: a name with fewer bars is not read


def day_counts(bars: pd.DataFrame, ctx: dict[str, Any], flatten: int) -> dict[str, Any]:
    """The counts of one primary's day. `bars`: its regular-session minute bars. `flatten`: the index of the bar at
    which the batch run flattens (no entry on it or after it)."""
    out: dict[str, Any] = {}
    for code in sl.GAP_CODES:
        seen: set[str] = set()
        att = sl.gap_walk(bars, ctx, codes=(code,), last_bar=flatten, seen=seen)
        out[code] = {"order": int(code in seen), "reached": int(att is not None),
                     "fill": int(att is not None and att.fill is not None)}
    att = sl.gap_walk(bars, ctx, last_bar=flatten)
    out["day"] = {"reached": int(att is not None), "fill": int(att is not None and att.fill is not None),
                  "code": att.order.code if att is not None else None}
    return out


def session_counts(day: dt.date, close_hhmm: str, bars_of: Any) -> dict[str, Any]:
    """One session's line. `bars_of(symbol)` returns the primary's minute bars (or None): the only market-data read."""
    primary, ctx, info = runner_s.gap_selection(day, et(day, "09:30"))
    row: dict[str, Any] = {"date": str(day), "primary": int(primary is not None)}
    if primary is None or ctx is None:
        row["why"] = info.get("why")
        return row
    bars = bars_of(primary)
    if bars is None or len(bars) < MIN_BARS:
        row["why"] = "no_rth_bars"
        return row
    cut = pd.Timestamp(et(day, close_hhmm)) - pd.Timedelta(minutes=10)
    flatten = min(len(bars) - 1, int(np.searchsorted(pd.to_datetime(bars.t, utc=True), cut)))
    row.update(day_counts(bars, ctx, flatten))
    return row


def totals(rows: list[dict[str, Any]]) -> dict[str, Any]:
    out: dict[str, Any] = {"sessions": len(rows), "primary": sum(r["primary"] for r in rows),
                           "no_primary": {}, "day_code": {}}
    for r in rows:
        if "why" in r:
            out["no_primary"][str(r["why"])] = out["no_primary"].get(str(r["why"]), 0) + 1
        for key in (*sl.GAP_CODES, "day"):
            if key in r:
                for k in ("order", "reached", "fill"):
                    if k in r[key]:
                        out.setdefault(key, {}).setdefault(k, 0)
                        out[key][k] += r[key][k]
        code = r.get("day", {}).get("code")
        if code:
            out["day_code"][code] = out["day_code"].get(code, 0) + 1
    return out


def main(start: str, end: str) -> None:
    from wt.backtest.runner import minute_bars
    from wt.data.alpaca import AlpacaREST
    a = AlpacaREST(per_minute=150, shared=True)
    from wt.scanner import pool
    # past sessions: the after-close pools (the same build as the live 09:25 pool the desk reads)
    runner_s.POOL_DIR, runner_s.PM_BARS_DIR = pool.POOL_DIR, pool.PM_BARS_DIR
    s, e = dt.date.fromisoformat(start), dt.date.fromisoformat(end)
    days = sorted(d for d in (dt.date.fromisoformat(f.stem) for f in runner_s.POOL_DIR.glob("*.parquet")) if s <= d <= e)
    closes = {r.date: str(r.close)[:5] for r in a.calendar(start, end).itertuples()}
    rows = []
    for d in days:
        close = closes.get(d, "16:00")
        row = session_counts(d, close, lambda sym, d=d, close=close: minute_bars(a, d, [sym], close_hhmm=close).get(sym))
        rows.append(row)
        print(json.dumps(row), flush=True)
    print(json.dumps({"totals": totals(rows), "spread_must": "not checked (minute bars carry no quotes)"}, indent=1))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("start")
    ap.add_argument("end")
    args = ap.parse_args()
    main(args.start, args.end)
