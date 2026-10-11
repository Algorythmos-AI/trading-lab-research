#!/usr/bin/env python
"""Replicate the four probation rules' study from this repository's code (DEC-0028, section 6).

    python scripts/options_replication.py --out research/experiments/EXP-0023-options-rules-replication

The rules were chosen, and their results seen, in a cloud project before the engine lived here. This runs the
registered code (wt.options.levels, wt.options.rules) over the same ten names and the same span, on another
feed's bars, and sets the two side by side. It is a replication of a result already seen, not a new test:
nothing here is evidence for or against a rule (DEC-0028, section 3).

Bars are read from the market-data feed with the lab's own keys and are never written into the repository: the
report carries counts, R and a hash of the bars. Results are in R on the stock, before any option cost.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

import numpy as np  # noqa: E402

from wt.backtest.stats import bootstrap_ci  # noqa: E402
from wt.core.config import load_yaml  # noqa: E402
from wt.data.alpaca import AlpacaREST  # noqa: E402
from wt.options import intraday, rules  # noqa: E402
from wt.options import levels as lv  # noqa: E402

START, END = "2026-03-03", "2026-10-09"
SEED, N_BOOT = 7, 5000  # the resampling behind every range, recorded with the result
MIN_HOURLY = 6          # as the after-close run: fewer hourly bars than this is not a session it scores
HISTORY_DAYS = 430


def _rows(df, name: str) -> list[dict]:
    mine = df[df["symbol"] == name]
    return [{"t": t.isoformat(), "o": o, "h": h, "l": low, "c": c} for t, o, h, low, c in
            zip(mine["t"], mine["o"], mine["h"], mine["l"], mine["c"], strict=True)]


def replicate(names: list[str], daily, halves, start: str, end: str) -> tuple[list[dict], dict]:
    """Every trigger of every rule, and what was left out and why. A name whose daily bars have problems is noted
    under `names_with_bar_problems` and still scored, on the rows the loader keeps."""
    out: list[dict] = []
    skipped = {"names_with_bar_problems": [], "sessions_without_levels": 0, "sessions_with_few_hourly_bars": 0}
    for name in names:
        loaded = lv.load_ibkr(intraday.daily_raw(_rows(daily, name)))
        if loaded.problems:
            skipped["names_with_bar_problems"].append({"name": name, "problems": len(loaded.problems)})
        parts = _rows(halves, name)
        by_day: dict[str, list[dict]] = {}
        for p in parts:
            day = dt.datetime.fromisoformat(p["t"]).astimezone(intraday.NEW_YORK).date().isoformat()
            by_day.setdefault(day, []).append(p)
        session = start if lv.is_session(start) else lv.next_session(start)
        while session <= end:
            close = intraday.slots(session)[-1][1]
            hourly = intraday.hourly_bars(by_day.get(session, []), session, close)
            try:
                levels = lv.levels_for(loaded.bars, session)
            except ValueError:
                skipped["sessions_without_levels"] += 1
            else:
                if len(hourly) < MIN_HOURLY:
                    skipped["sessions_with_few_hourly_bars"] += 1
                else:
                    out += [{"session": session, "name": name, **t} for t in rules.probation_triggers(hourly, levels)]
            session = lv.next_session(session)
    return out, skipped


def summary(rs: list[float], days: list[str]) -> dict:
    if not rs:
        return {"n": 0}
    r = np.asarray(rs, dtype=float)
    lo, hi = bootstrap_ci(r, seed=SEED, n_boot=N_BOOT)
    dlo, dhi = bootstrap_ci(r, seed=SEED, n_boot=N_BOOT, block="day", days=days)
    return {"n": len(rs), "avg_r": round(float(r.mean()), 4), "ci95": [round(lo, 4), round(hi, 4)],
            "ci95_by_session": [round(dlo, 4), round(dhi, 4)], "win_rate": round(float((r > 0).mean()), 4),
            "stops": int((r == -1.0).sum()), "targets": int((r == 2.0).sum())}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--start", default=START)
    ap.add_argument("--end", default=END)
    a = ap.parse_args(argv)
    if (a.out / "result.json").exists():
        print(f"{a.out} already holds a result: experiments are append-only, so a re-run takes a new EXP id", file=sys.stderr)
        return 2
    names = [str(n) for n in load_yaml("options_desk.yaml")["names"]]
    seen = {r["id"]: r["backtest"] for r in json.loads((ROOT / "config" / "options_rules.json").read_text())["rules"]}
    client = AlpacaREST(shared=True)
    first = (dt.date.fromisoformat(a.start) - dt.timedelta(days=HISTORY_DAYS)).isoformat()
    after = (dt.date.fromisoformat(a.end) + dt.timedelta(days=1)).isoformat()
    daily = client.bars(names, "1Day", first, after, feed="sip", adjustment="split")
    halves = client.bars(names, "30Min", a.start, after, feed="sip", adjustment="split")
    digest = hashlib.sha256()
    for df in (daily, halves):
        digest.update(df.sort_values(["symbol", "t"]).to_csv(index=False).encode())
    trades, skipped = replicate(names, daily, halves, a.start, a.end)

    per_rule = {}
    for rule in rules.RULES:
        mine = [t for t in trades if t["rule"] == rule]
        per_rule[rule] = {"replication": summary([t["r"] for t in mine], [t["session"] for t in mine]),
                          "seen_before_registration": {k: seen[rule][k] for k in ("n", "avg_r", "ci_lo", "ci_hi")}}
    sessions = sorted({t["session"] for t in trades})
    result = {
        "id": "EXP-0023", "decision": "DEC-0028", "hypotheses": ["HYP-0025", "HYP-0026", "HYP-0027", "HYP-0028"],
        "what": "replication of a result seen before registration; not evidence for or against any rule",
        "start": a.start, "end": a.end, "names": names, "feed": "consolidated tape, 30-minute bars cut into the broker's hours, split-adjusted",
        "data_hash": digest.hexdigest()[:16], "bootstrap": {"seed": SEED, "resamples": N_BOOT}, "daily_bars": int(len(daily)), "half_hour_bars": int(len(halves)),
        "sessions_with_a_trigger": len(sessions), "skipped": skipped, "unit": "R on the stock, before any option cost",
        "rules": per_rule,
        "pooled": summary([t["r"] for t in trades], [t["session"] for t in trades]),
        "by_exit": {how: sum(1 for t in trades if t["exit"] == how) for how in ("stop", "target", "close")},
    }
    a.out.mkdir(parents=True, exist_ok=True)
    (a.out / "result.json").write_text(json.dumps(result, indent=1) + "\n")
    print(json.dumps({k: result[k] for k in ("data_hash", "daily_bars", "half_hour_bars", "skipped", "by_exit")}))
    for rule, v in per_rule.items():
        print(rule, v["replication"], "| seen:", v["seen_before_registration"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
