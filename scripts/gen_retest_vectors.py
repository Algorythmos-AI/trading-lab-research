"""Writes dashboard/test/fixtures/retest.vectors.json: for a fixed set of synthetic 2-minute sessions, the bar at whose
close `wt.options.setups.retest` signals (DEC-0052), so the Options desk's board (dashboard/src/lib/trade-state.ts) is
held to the clone's retest bar for bar, not only to its numbers.

Each case is one level, one side and its 2-minute bars from 09:30. The clone is run as its runner runs it
(`wt.live.runner_o`, `wt.options.dryrun`): at every bar's close, on the bars up to it, with the 2-minute ATR of those
bars (`regime.atr`, `bars.atr_period`) and `setups.retest`'s numbers from config/options_clone.yaml. `expect.signals`
holds every bar it signals at for the case's side, with the ATR it read there; `expect.confirm` is the first (null:
none), the one that governs the board's break (its two ENTER slots; a later signal of the same break reads missed).

tests/unit/test_retest_vectors.py re-runs the clone on every case and dashboard/test/retest-vectors.test.ts runs the
board's `sideState` on the same bars; both assert the answers written here. Synthetic inputs only: no market data.

    python scripts/gen_retest_vectors.py            # rewrite the vectors
    python scripts/gen_retest_vectors.py --check    # exit 1 if the committed vectors are stale
"""
from __future__ import annotations

import datetime as dt
import json
import sys
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from wt.options import regime, setups  # noqa: E402

VECTORS = ROOT / "dashboard" / "test" / "fixtures" / "retest.vectors.json"
SESSION = "2026-10-12"          # a Monday on EDT
OPEN = (9, 30)
BAR_MIN = 2

OHLC = list[float]


def cfg() -> dict[str, Any]:
    c = yaml.safe_load((ROOT / "config" / "options_clone.yaml").read_text())
    return {"retest": dict(c["setups"]["retest"]), "atr_period": int(c["bars"]["atr_period"]),
            "bar_minutes": int(c["bars"]["minutes"])}


def r4(v: float) -> float:
    return round(v, 4)


def climb(n: int, first_close: float, step: float, pad: float = 0.05, start_open: float | None = None) -> list[OHLC]:
    """`n` bars whose closes step by `step` from `first_close`; each opens at the close before and reaches `pad` past
    its open and close (a true range of |step| + 2 * pad)."""
    out: list[OHLC] = []
    prev = first_close - step if start_open is None else start_open
    for i in range(n):
        c = first_close + step * i
        o = prev
        out.append([r4(o), r4(max(o, c) + pad), r4(min(o, c) - pad), r4(c)])
        prev = c
    return out


def mirror(bars: list[OHLC], level: float) -> list[OHLC]:
    """The call's bars reflected about the level: the put's (a high becomes a low)."""
    return [[r4(2 * level - o), r4(2 * level - lo), r4(2 * level - h), r4(2 * level - c)] for o, h, lo, c in bars]


# ---- the cases: a level of 100.00 (a call unless named), fifteen calm bars climbing to 99.90 first ------------------
L = 100.0
WARM = climb(15, 98.5, 0.1)                         # closes 98.50 .. 99.90, true ranges 0.20
BRK = [99.9, 100.25, 99.85, 100.2]                   # closes above 100.00, the close before at 99.90
HOLD = [100.4, 100.5, 100.4, 100.45]                 # the low 0.40 over the level: no touch (the ATR is about 0.2)


def touch(low: float, c: float = 100.25) -> OHLC:
    return [c + 0.05, max(c + 0.1, low + 0.1), low, c]


def up(c: float, frm: float) -> OHLC:
    """A bar from `frm` closing at `c`."""
    return [frm, max(frm, c) + 0.05, min(frm, c) - 0.02, c]


def exact(dip: float, atr: float = 0.25, level: float = 100.0) -> list[OHLC]:
    """Every true range is `atr` (a binary fraction, so every sum is exact): fourteen bars closing at the level, a break
    closing `atr` above it, a touch bar whose low is `dip` above it (its range is still `atr`), and a bar closing above
    the touch bar's close. The 2-minute ATR at that last close is `atr` itself."""
    warm = [[level - atr, level, level - atr, level] for _ in range(15)]
    tc = level + max(atr, dip)                       # the touch bar opens and closes inside its own range
    return warm + [[level, level + atr, level, level + atr], [tc, level + dip + atr, level + dip, tc],
                   [level + atr, level + 2 * atr, level + atr, level + 1.5 * atr]]


CASES: list[dict[str, Any]] = [
    {"name": "confirmed on the bar after the touch", "side": "call", "level": L,
     "bars": WARM + [BRK, touch(100.05), up(100.35, 100.25), up(100.4, 100.35)]},
    {"name": "touched, never confirmed: the closes stay at or under the touch bar's", "side": "call", "level": L,
     "bars": WARM + [BRK, touch(100.05), [100.25, 100.3, 100.12, 100.25], [100.25, 100.28, 100.1, 100.2],
                     [100.2, 100.26, 100.08, 100.22], [100.22, 100.25, 100.1, 100.15], [100.15, 100.2, 100.05, 100.1],
                     [100.1, 100.2, 100.05, 100.18]]},
    {"name": "confirmed three bars after the touch: the first close above the touch bar's", "side": "call", "level": L,
     "bars": WARM + [BRK, touch(100.05), [100.25, 100.3, 100.15, 100.2], [100.2, 100.25, 100.12, 100.25],
                     up(100.3, 100.25), up(100.4, 100.3)]},
    {"name": "touch on the 6th bar after the break, confirmed on the 7th (the window's last)", "side": "call",
     "level": L, "bars": WARM + [BRK] + [HOLD] * 5 + [touch(100.08, 100.3), up(100.42, 100.3), up(100.45, 100.42)]},
    {"name": "touch on the 7th bar after the break: outside the window", "side": "call", "level": L,
     "bars": WARM + [BRK] + [HOLD] * 6 + [touch(100.08, 100.3), up(100.42, 100.3), up(100.45, 100.42)]},
    {"name": "a close back through the level before the confirming close", "side": "call", "level": L,
     "bars": WARM + [BRK, touch(100.05), [100.25, 100.27, 99.9, 99.95], up(100.3, 99.95), up(100.4, 100.3)]},
    {"name": "no 2-minute ATR yet: break, touch and confirming close in the first 15 bars", "side": "call",
     "level": L, "bars": climb(9, 99.1, 0.1) + [BRK, touch(100.05), up(100.35, 100.25), up(100.4, 100.35)]
     + [up(100.45, 100.4)] * 6},
    {"name": "a put: the mirror of the first case", "side": "put", "level": L,
     "bars": mirror(WARM + [BRK, touch(100.05), up(100.35, 100.25), up(100.4, 100.35)], L)},
    {"name": "a put: touch on the 6th bar after the break, confirmed on the 7th", "side": "put", "level": L,
     "bars": mirror(WARM + [BRK] + [HOLD] * 5 + [touch(100.08, 100.3), up(100.42, 100.3), up(100.45, 100.42)], L)},
    {"name": "a dip of exactly one 2-minute ATR is a touch", "side": "call", "level": L, "bars": exact(0.25)},
    {"name": "a dip a hair over one 2-minute ATR is not", "side": "call", "level": L,
     "bars": exact(0.25 + 2 ** -16)},
    {"name": "the first break fails; the second one's retest confirms", "side": "call", "level": L,
     "bars": WARM + [BRK, [100.2, 100.22, 99.8, 99.85], [99.85, 99.95, 99.8, 99.9], BRK, touch(100.05),
                     up(100.35, 100.25), up(100.4, 100.35)]},
    # The touch counts with the ATR at the confirming close, not the one at the touch: the confirming bar's wide range
    # lifts the ATR over the touch bar's dip (0.30), which was more than the ATR when it printed.
    {"name": "the ATR at the confirming close decides the touch: it rose to cover it", "side": "call", "level": L,
     "bars": WARM + [BRK, touch(100.3, 100.4), [100.4, 101.8, 100.35, 100.5], up(100.55, 100.5)]},
    # The mirror: a wide bar 14 bars before the confirming close leaves the ATR's window there, and the ATR falls under
    # the touch bar's dip, which was inside the band when it printed: no signal.
    # Two signals on one break: the clone confirms at bar 17, then bar 20's wide range lifts the ATR so that bar 21,
    # read with it, is the first close above an earlier bar that is now a touch. The board takes the first only.
    {"name": "two clone signals on one break: the first governs", "side": "call", "level": L,
     "bars": WARM + [BRK, [100.5, 100.65, 100.5, 100.6], [100.6, 100.62, 100.1, 100.3], [100.3, 100.45, 100.28, 100.4],
                     [100.4, 100.5, 100.3, 100.35], [100.35, 100.59, 96.0, 100.3], [100.3, 100.75, 100.25, 100.7]]},
    {"name": "the ATR at the confirming close decides the touch: it fell below it", "side": "call", "level": L,
     "bars": climb(3, 98.9, 0.1) + [[99.1, 100.4, 98.6, 99.2]] + climb(11, 99.25, 0.05, 0.02)
     + [BRK, touch(100.22, 100.3), up(100.35, 100.3), up(100.4, 100.35)]},
]


def bars_of(case: dict[str, Any]) -> list[regime.Bar]:
    day = dt.date.fromisoformat(SESSION)
    t0 = dt.datetime.combine(day, dt.time(*OPEN), regime.NEW_YORK)
    return [regime.Bar(t0 + dt.timedelta(minutes=BAR_MIN * i), t0 + dt.timedelta(minutes=BAR_MIN * (i + 1)), o, h, lo, c,
                       1.0, c) for i, (o, h, lo, c) in enumerate(case["bars"])]


def run(case: dict[str, Any], c: dict[str, Any]) -> list[tuple[int, float]]:
    """The clone at every bar's close: the bars where it signals the case's side, with the ATR it read there."""
    bars = bars_of(case)
    mark = setups.Mark("L", float(case["level"]))
    out: list[tuple[int, float]] = []
    for i in range(len(bars)):
        seen = bars[: i + 1]
        a = regime.atr(seen, c["atr_period"])
        if a is None or a <= 0:
            continue
        if any(s.side == case["side"] for s in setups.retest(seen, [mark], a, c["retest"])):
            out.append((i, a))
    return out


def build() -> dict[str, Any]:
    c = cfg()
    cases = []
    for case in CASES:
        got = run(case, c)
        expect = {"signals": [{"bar": i, "atr": a} for i, a in got],
                  "confirm": got[0][0] if got else None, "atr_at_confirm": got[0][1] if got else None}
        cases.append({**case, "expect": expect})
    return {"schema": "wt/retest-vectors", "version": 2, "session": SESSION, "bar_minutes": c["bar_minutes"],
            "atr_period": c["atr_period"], "retest": c["retest"], "cases": cases}


def main(argv: list[str]) -> int:
    data = build()
    if "--check" in argv:
        have = json.loads(VECTORS.read_text()) if VECTORS.exists() else None
        if have != data:
            print(f"{VECTORS.relative_to(ROOT)} is stale: run python scripts/gen_retest_vectors.py", file=sys.stderr)
            return 1
        return 0
    VECTORS.write_text(json.dumps(data, indent=1) + "\n")
    for case in data["cases"]:
        print(f"{[x['bar'] for x in case['expect']['signals']]!s:>9}  {case['name']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
