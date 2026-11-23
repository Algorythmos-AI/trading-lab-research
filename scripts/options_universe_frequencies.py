"""Status frequencies for setting the Radar gate's thresholds (DEC-0070 section 3): counts only, from saved data.

    python scripts/options_universe_frequencies.py [--root var/options-select]
        [--price-min N --dollar-volume-min N --ntm-strikes-min N --volume-min N --spread-max-pct F]

It reads the `universe.json` of every shadow run under `--root` (version 2 and later: each candidate's gate facts,
recorded whether the gate is set or not) and prints:

1. the facts that need no threshold: how many candidates the edition flags avoid or risk, fail Stage 1's validity, have
   no readable chain or no expiry in the window, have no known report, or have a report in the hold;
2. for each threshold, over a grid of values, how many candidate-sessions pass that check alone;
3. with every threshold given on the command line, how many names each session would admit before the cap of
   `max_additions`, checking in the gate's own order (`wt.options.universe._check`).

What it never reads or prints: a symbol, a price after the run, a pick's or any name's outcome. A threshold is chosen
from how many names it keeps, never from how they did (DEC-0046's method for Stage 2). The output is SAFE (counts).
"""
from __future__ import annotations

import argparse
import json
import statistics
import sys
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
VAR = ROOT / "var" / "options-select"
GRID: dict[str, tuple[float, ...]] = {
    "price_min": (5.0, 10.0, 20.0, 50.0),
    "median_dollar_volume_min": (1e7, 5e7, 1e8, 5e8, 1e9),
    "chain_ntm_strikes_min": (4, 6, 10, 20),
    "chain_volume_min": (100.0, 500.0, 1_000.0, 5_000.0),
    "chain_spread_max_pct": (0.05, 0.10, 0.15, 0.25),
}


def load(root: Path) -> list[dict[str, Any]]:
    """Every shadow run's universe record with facts (version 2 or later), oldest first; others are skipped."""
    out = []
    for folder in sorted(p for p in root.iterdir() if p.is_dir() and not p.name.startswith(".")) if root.is_dir() else []:
        try:
            doc = json.loads((folder / "universe.json").read_text())
        except (OSError, ValueError):
            continue
        if isinstance(doc, Mapping) and isinstance(doc.get("version"), int) and doc["version"] >= 2:
            out.append(dict(doc))
    return out


def facts(records: Sequence[Mapping[str, Any]]) -> list[tuple[str, Mapping[str, Any]]]:
    """(session, facts) for every candidate verdict that carries facts."""
    return [(str(r["session"]), v["facts"]) for r in records for v in r.get("verdicts", [])
            if isinstance(v, Mapping) and isinstance(v.get("facts"), Mapping)]


def passes(f: Mapping[str, Any], key: str, value: float) -> bool | None:
    """Whether one fact passes one threshold alone; None when the fact is missing."""
    chain = f.get("chain") or {}
    got = {"price_min": f.get("close"), "median_dollar_volume_min": f.get("median_dollar_volume"),
           "chain_ntm_strikes_min": chain.get("ntm_contracts"), "chain_volume_min": chain.get("ntm_volume"),
           "chain_spread_max_pct": chain.get("ntm_spread_pct")}[key]
    if got is None:
        return None
    return got <= value if key == "chain_spread_max_pct" else got >= value


def admitted(f: Mapping[str, Any], th: Mapping[str, float]) -> bool:
    """The gate's order (`universe._check`) with these thresholds, from the recorded facts."""
    if f.get("avoid") or f.get("risk_tag") or f.get("validity") != "ok":
        return False
    chain = f.get("chain")
    if not chain or chain.get("expiry") is None:
        return False
    for key in ("price_min", "median_dollar_volume_min", "chain_ntm_strikes_min", "chain_volume_min",
                "chain_spread_max_pct"):
        if not passes(f, key, th[key]):
            return False
    if f.get("earnings_known") is False or f.get("earnings_in_hold"):
        return False
    return True


def report(records: Sequence[Mapping[str, Any]], th: Mapping[str, float] | None, cap: int = 8) -> list[str]:
    rows = facts(records)
    sessions = sorted({s for s, _ in rows})
    lines = [f"sessions {len(sessions)} ({sessions[0] if sessions else '-'} to {sessions[-1] if sessions else '-'}); "
             f"candidate-sessions {len(rows)}"]
    if not rows:
        return [*lines, "no candidate facts recorded yet (universe.json version 2 and later)"]
    n = len(rows)

    def count(pred: Any) -> int:
        return sum(1 for _, f in rows if pred(f))
    lines += [
        "facts with no threshold:",
        f"  avoid {count(lambda f: f.get('avoid'))}; risk {count(lambda f: f.get('risk_tag'))}; "
        f"validity not ok {count(lambda f: f.get('validity') != 'ok')}",
        f"  chain unreadable {count(lambda f: not f.get('chain'))}; no expiry in the window "
        f"{count(lambda f: bool(f.get('chain')) and f['chain'].get('expiry') is None)}",
        f"  next report unknown {count(lambda f: f.get('earnings_known') is False)}; report in the hold "
        f"{count(lambda f: bool(f.get('earnings_in_hold')))}",
        "each threshold alone (passing / with the fact):",
    ]
    for key, grid in GRID.items():
        cells = []
        for value in grid:
            got = [passes(f, key, value) for _, f in rows]
            known = [g for g in got if g is not None]
            cells.append(f"{value:g}: {sum(known)}/{len(known)}")
        lines.append(f"  {key}  " + "  ".join(cells))
    lines.append(f"  (of {n} candidate-sessions)")
    if th is not None:
        per = [sum(1 for s, f in rows if s == day and admitted(f, th)) for day in sessions]
        lines += [
            "with " + ", ".join(f"{k} {v:g}" for k, v in th.items()) + ":",
            f"  admitted before the cap per session: min {min(per)}, median {statistics.median(per):g}, max {max(per)}; "
            f"sessions over the cap of {cap}: {sum(1 for x in per if x > cap)}; sessions with none: "
            f"{sum(1 for x in per if x == 0)}",
        ]
    return lines


def main(argv: Sequence[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    ap.add_argument("--root", type=Path, default=VAR)
    ap.add_argument("--price-min", type=float)
    ap.add_argument("--dollar-volume-min", type=float)
    ap.add_argument("--ntm-strikes-min", type=float)
    ap.add_argument("--volume-min", type=float)
    ap.add_argument("--spread-max-pct", type=float)
    ap.add_argument("--cap", type=int, default=8)
    a = ap.parse_args(argv)
    given = {"price_min": a.price_min, "median_dollar_volume_min": a.dollar_volume_min,
             "chain_ntm_strikes_min": a.ntm_strikes_min, "chain_volume_min": a.volume_min,
             "chain_spread_max_pct": a.spread_max_pct}
    if any(v is not None for v in given.values()) and any(v is None for v in given.values()):
        print("options_universe_frequencies: give all five thresholds, or none", file=sys.stderr)
        return 2
    th = {k: float(v) for k, v in given.items()} if all(v is not None for v in given.values()) else None
    print("\n".join(report(load(a.root), th, a.cap)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
