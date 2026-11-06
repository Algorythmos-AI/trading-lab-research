"""Writes dashboard/test/fixtures/entry-checks.vectors.json: the DEC-0041 flags that `wt.options.setups.tag_decision`
gives for a fixed set of synthetic sessions, so the Options desk's live cautions (dashboard/src/lib/entry-checks.ts)
are held to the clone's behaviour, not only to its numbers.

tests/unit/test_entry_checks_parity.py re-runs `tag_decision` on every vector and dashboard/test/entry-checks-vectors
.test.ts runs `entryChecks` on the same inputs; both assert the answers written here. Synthetic inputs only: no market
data.

    python scripts/gen_entry_check_vectors.py            # rewrite the vectors
    python scripts/gen_entry_check_vectors.py --check    # exit 1 if the committed vectors are stale
"""
from __future__ import annotations

import datetime as dt
import json
import math
import sys
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from wt.options import levels, setups  # noqa: E402
from wt.options.regime import NEW_YORK, Bar, Tape  # noqa: E402

VECTORS = ROOT / "dashboard" / "test" / "fixtures" / "entry-checks.vectors.json"
SESSION = "2026-10-12"          # a Monday on EDT
OPEN = (9, 30)
BAR_MIN = 2
FLAGS = ("ntz", "gap_against", "leader_against", "iv_rich", "early")

BASE_MARKS = [{"name": "PDH", "price": 110.0}, {"name": "PDL", "price": 100.0}]
# The five sessions before SESSION: 90 to 150, thirds at 110 and 130.
DAILY = [
    {"d": "2026-10-05", "o": 100.0, "h": 150.0, "l": 99.0, "c": 100.0},
    {"d": "2026-10-06", "o": 100.0, "h": 120.0, "l": 90.0, "c": 100.0},
    {"d": "2026-10-07", "o": 100.0, "h": 110.0, "l": 100.0, "c": 100.0},
    {"d": "2026-10-08", "o": 100.0, "h": 110.0, "l": 100.0, "c": 100.0},
    {"d": "2026-10-09", "o": 100.0, "h": 110.0, "l": 100.0, "c": 100.0},
]
# A five-session range whose middle third holds nothing in these cases (333 to 667).
WIDE = [{**b, "h": 1000.0, "l": 0.0} for b in DAILY]
THIRD = (110.0 - 100.0) / 3


def cfg() -> dict[str, Any]:
    c = yaml.safe_load((ROOT / "config" / "options_clone.yaml").read_text())
    return {**c["research_arms"]["tags"], "index_names": c["contract"]["index_names"]}


def path_bars(n: int, waypoints: list[float], touch_low: tuple[int, float] | None,
              touch_high: tuple[int, float] | None) -> list[list[float]]:
    """`n` bars whose closes run piecewise straight through the waypoints (the first is the open); each bar's high
    and low sit 0.05 outside its open and close, except where a touch sets one exactly."""
    segs = len(waypoints) - 1
    closes: list[float] = []
    for i in range(1, n + 1):
        x = i / n * segs
        k = min(int(x), segs - 1)
        f = x - k
        closes.append(round(waypoints[k] + (waypoints[k + 1] - waypoints[k]) * f, 4) if i < n else waypoints[-1])
    out: list[list[float]] = []
    prev = waypoints[0]
    for i, c in enumerate(closes):
        o = prev
        h, low = round(max(o, c) + 0.05, 4), round(min(o, c) - 0.05, 4)
        if touch_low and touch_low[0] == i:
            low = touch_low[1]
        if touch_high and touch_high[0] == i:
            h = touch_high[1]
        out.append([o, h, low, c])
        prev = c
    return out


def bars_count(bar_end: str) -> int:
    h, m = (int(x) for x in bar_end.split(":"))
    return ((h * 60 + m) - (OPEN[0] * 60 + OPEN[1])) // BAR_MIN


def case(name: str, *, side: str = "call", root: str = "AAPL", marks: list[dict[str, Any]] | None = None,
         daily: list[dict[str, Any]] | None = None, path: list[float] | None = None, bar_end: str = "10:30",
         leader: dict[str, Any] | None = None, iv: float | None = 0.2, half_day: bool = False,
         touch_low: tuple[int, float] | None = None, touch_high: tuple[int, float] | None = None) -> dict[str, Any]:
    n = bars_count(bar_end)
    return {
        "name": name, "side": side, "root": root, "marks": marks if marks is not None else BASE_MARKS,
        "daily": daily if daily is not None else DAILY,
        "bars": path_bars(n, path if path is not None else [105.0, 105.0], touch_low, touch_high),
        "leader": leader, "iv": iv, "half_day": half_day, "bar_end": bar_end,
    }


CASES: list[dict[str, Any]] = [
    # the middle third (HYP-0034), both sides, its two ends exactly and just outside them
    case("prior range middle, call"),
    case("prior range middle, put", side="put"),
    case("prior third's low end exactly", daily=WIDE, path=[100.0 + THIRD, 100.0 + THIRD]),
    case("just under the prior third's low end", daily=WIDE,
         path=[math.nextafter(100.0 + THIRD, 0.0), math.nextafter(100.0 + THIRD, 0.0)]),
    case("prior third's high end exactly", daily=WIDE, path=[110.0 - THIRD, 110.0 - THIRD]),
    case("just over the prior third's high end", daily=WIDE,
         path=[math.nextafter(110.0 - THIRD, 200.0), math.nextafter(110.0 - THIRD, 200.0)]),
    case("five-day middle, gap up unfilled, call", path=[112.0, 112.0]),
    case("gap up filled exactly at PDH", path=[112.0, 112.0], touch_low=(3, 110.0)),
    case("gap up unfilled, put", side="put", path=[112.0, 112.0]),
    case("gap down unfilled, put", side="put", path=[98.0, 98.0]),
    case("gap down filled exactly at PDL", side="put", path=[98.0, 98.0], touch_high=(4, 100.0)),
    case("gap down unfilled, call", path=[98.0, 98.0]),
    case("opened exactly at PDH", path=[110.0, 110.5]),
    case("a mark broken by a close", marks=[*BASE_MARKS, {"name": "MA20", "price": 107.0}], path=[108.0, 106.5, 105.0]),
    case("a mark crossed by a wick only", marks=[*BASE_MARKS, {"name": "MA20", "price": 107.0}], path=[106.0, 105.0],
         touch_high=(2, 107.2)),
    case("no five-day range, prior third holds", daily=DAILY[1:], path=[105.0, 105.0]),
    case("no five-day range, prior third does not hold", daily=DAILY[1:], path=[108.0, 108.0]),
    # the leader (HYP-0038), QQQ against SMH's VWAP; equal is not against
    case("QQQ call, SMH under its VWAP", root="QQQ", leader={"close": 299.9, "vwap": 300.0}),
    case("QQQ call, SMH at its VWAP", root="QQQ", leader={"close": 300.0, "vwap": 300.0}),
    case("QQQ put, SMH at its VWAP", root="QQQ", side="put", leader={"close": 300.0, "vwap": 300.0}),
    case("QQQ put, SMH over its VWAP", root="QQQ", side="put", leader={"close": 300.1, "vwap": 300.0}),
    case("QQQ, no SMH tape", root="QQQ", leader=None),
    case("QQQ, SMH without a VWAP", root="QQQ", leader={"close": 300.0, "vwap": None}),
    # IV (HYP-0040): above the cap is rich, at it is not
    case("SPY IV at the index cap", root="SPY", iv=0.35),
    case("SPY IV over the index cap", root="SPY", iv=0.3501),
    case("single name IV at its cap", iv=0.70),
    case("single name IV over its cap", iv=0.7001),
    case("no IV", iv=None),
    # the time (HYP-0042): early [10:00, 11:00), late [11:00, 14:30], half days in neither
    case("bar ends 09:58", bar_end="09:58"),
    case("bar ends 10:00", bar_end="10:00"),
    case("bar ends 10:58", bar_end="10:58"),
    case("bar ends 11:00", bar_end="11:00"),
    case("bar ends 14:30", bar_end="14:30"),
    case("bar ends 14:32", bar_end="14:32"),
    case("half day, bar ends 10:30", half_day=True),
]


def run(c: dict[str, Any], tags: dict[str, Any]) -> dict[str, Any]:
    """`tag_decision` on one vector: the flags the clone would log at the close of its last bar."""
    day = dt.date.fromisoformat(SESSION)
    t0 = dt.datetime.combine(day, dt.time(*OPEN), NEW_YORK)
    bars = [Bar(t0 + dt.timedelta(minutes=BAR_MIN * i), t0 + dt.timedelta(minutes=BAR_MIN * (i + 1)), o, h, low, cl,
                1.0, cl) for i, (o, h, low, cl) in enumerate(c["bars"])]
    marks = [setups.Mark(m["name"], float(m["price"])) for m in c["marks"]]
    by = {m.name: m for m in marks}
    sig = setups.Signal("retest", c["side"], by.get("PDH", marks[0]), bars[-1].c, bars[-1].c, c["bar_end"])
    five = levels.swing_range([levels.Bar(**d) for d in c["daily"]], SESSION)
    lead = c["leader"]
    tape = None if lead is None else Tape(lead["close"], lead["vwap"], None, None, None, lead["close"], lead["close"],
                                          0.0, "range")
    out = setups.tag_decision(sig, bars, marks, root=c["root"], word=None, five=five, leader=tape,
                              leader_names=list(tags["leaders"]), iv=c["iv"], iv_modelled=False,
                              half_day=c["half_day"], cfg=tags)
    return {k: out.get(k) for k in FLAGS}


def build() -> dict[str, Any]:
    tags = cfg()
    cases = []
    for c in CASES:
        assert bars_count(c["bar_end"]) == len(c["bars"]) > 0, c["name"]
        cases.append({**c, "expect": run(c, tags)})
    return {"schema": "wt/entry-check-vectors", "version": 1, "session": SESSION, "bar_minutes": BAR_MIN,
            "cases": cases}


def main(argv: list[str]) -> int:
    data = build()
    if "--check" in argv:
        have = json.loads(VECTORS.read_text()) if VECTORS.exists() else None
        if have != data:
            print(f"{VECTORS.relative_to(ROOT)} is stale: run scripts/gen_entry_check_vectors.py", file=sys.stderr)
            return 1
        return 0
    VECTORS.write_text(json.dumps(data, indent=1) + "\n")
    print(f"wrote {len(data['cases'])} vectors to {VECTORS.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
