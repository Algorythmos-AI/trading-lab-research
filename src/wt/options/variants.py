"""EXP-0037's three variants of the options clone (DEC-0054, HYP-0062 to HYP-0064). Pure: no I/O, no clock.

Read only by `wt.options.dryrun` when a replay names a variant. The live clone never imports this module, and the
control's code (`wt.options.setups`) is not changed by it: each variant starts from the control's own verdict and
changes the one rule its hypothesis names.

- `room_open_sky` (HYP-0062): with no mark beyond the entry, room and reach read a measured level.
- `rejection_spy_trend` (HYP-0064): for rejections, the trend gate reads SPY only.
- `retest_free_confirm` (HYP-0063): a retest confirmation lost to a passing block is carried to a later bar.
"""
from __future__ import annotations

import datetime as dt
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from wt.options import setups
from wt.options.regime import Bar, Tape
from wt.options.setups import Gates, Mark, Signal

VARIANTS = ("room_open_sky", "retest_free_confirm", "rejection_spy_trend")


def _s(side: str) -> int:
    return 1 if side == "call" else -1


# ------------------------------------------------------------------ HYP-0062 CLONE-ROOM-OPEN-SKY
def measured_level(sig: Signal, marks: Sequence[Mark], gcfg: Mapping[str, Any]) -> float | None:
    """The measured level, when the variant applies: no mark beyond the entry (setups.next_level is None) and a
    risk above 0. It is the entry + s x min_room_multiple x risk. None when the control's next level exists."""
    if setups.next_level(sig.side, sig.entry, marks, sig.level.price) is not None:
        return None
    risk = abs(sig.entry - sig.invalidation)
    if risk <= 0:
        return None
    return sig.entry + _s(sig.side) * float(gcfg["min_room_multiple"]) * risk


def open_sky(g: Gates, sig: Signal, marks: Sequence[Mark], remaining_move: float | None,
             gcfg: Mapping[str, Any]) -> tuple[Gates, float | None]:
    """The control's gates with room and reach read against the measured level, and that level (for the next-level
    exit). Unchanged, with None, when a mark lies beyond the entry."""
    lvl = measured_level(sig, marks, gcfg)
    if lvl is None:
        return g, None
    mult = float(gcfg["min_room_multiple"])
    dist = abs(lvl - sig.entry)
    g.add("room", True, {"multiple": round(mult, 3), "next": "measured"})
    reach_ok = True
    if gcfg.get("room_inside_expected_move", True):
        reach_ok = remaining_move is not None and dist <= remaining_move
    g.add("reach", reach_ok, None if remaining_move is None else round(remaining_move, 4))
    return g, lvl


# ------------------------------------------------------------------ HYP-0064 CLONE-REJECTION-SPY-TREND
def spy_trend(g: Gates, sig: Signal, tape: Tape, spy: Tape | None) -> Gates:
    """For a rejection, the trend gate passes when SPY is not on the far side of its VWAP from the trade (the
    control's spy_ok); the name's own side of its VWAP is not read. A retest's gates are returned unchanged."""
    if sig.setup != "rejection":
        return g
    s = _s(sig.side)
    spy_ok = spy is None or spy.vwap is None or (spy.close - spy.vwap) * s >= 0
    g.add("trend", spy_ok, {"name_vs_vwap": None if tape.vwap is None else round(tape.close - tape.vwap, 4),
                            "spy_vs_vwap": None if spy is None or spy.vwap is None
                            else round(spy.close - spy.vwap, 4), "read": "spy_only"})
    return g


# ------------------------------------------------------------------ HYP-0063 CLONE-RETEST-FREE-CONFIRM
def retest_parts(bars: Sequence[Bar], m: Mark, side: str, a: float,
                 cfg: Mapping[str, Any]) -> tuple[int, int] | None:
    """(break bar, touch bar) of the retest `setups.retest` completes on the last bar at mark `m` and `side`, or
    None when it does not. The same tests as `setups.retest`, in the same order; a unit test holds the two equal."""
    if a <= 0 or len(bars) < 3:
        return None
    n_max, near = int(cfg["max_bars_to_retest"]), float(cfg["retest_within_atr"])
    last = len(bars) - 1
    lvl, s = m.price, _s(side)

    def beyond(x: float) -> bool:
        return (x - lvl) * s > 0
    ia = next((i for i in range(last - 1, 0, -1) if beyond(bars[i].c) and not beyond(bars[i - 1].c)), None)
    if ia is None or last - ia > n_max + 1:
        return None
    if not all(beyond(b.c) for b in bars[ia:last + 1]):
        return None
    touch = next((j for j in range(ia + 1, last)
                  if ((bars[j].l - lvl) if s > 0 else (lvl - bars[j].h)) <= near * a), None)
    if touch is None or touch - ia > n_max:
        return None
    ref = bars[touch].c
    first_away = next((k for k in range(touch + 1, last + 1) if (bars[k].c - ref) * s > 0), None)
    if first_away != last:
        return None
    return ia, touch


@dataclass(frozen=True)
class Carry:
    """A retest whose first confirmation came while the clone could not enter for a passing reason."""
    root: str
    side: str
    mark: Mark
    ref: float                  # the touch bar's close
    break_end: dt.datetime      # the end of the bar that broke the level
    first_end: dt.datetime      # the end of the first confirmation (the bar the control would have signalled on)


def carry_of(root: str, sig: Signal, bars: Sequence[Bar], a: float, cfg: Mapping[str, Any]) -> Carry | None:
    """The carry for one of the control's retest signals on these bars (its last bar is the confirmation)."""
    if sig.setup != "retest":
        return None
    parts = retest_parts(bars, sig.level, sig.side, a, cfg)
    if parts is None:
        return None
    ia, touch = parts
    return Carry(root, sig.side, sig.level, bars[touch].c, bars[ia].end, bars[-1].end)


def carry_state(c: Carry, bars: Sequence[Bar], cfg: Mapping[str, Any]) -> str:
    """What the newest bar does to a carry: `dead` (a close at or back through the level since the break, or more
    than max_bars_to_retest bars after the first confirmation, or the bars lost), `confirm` (it closes beyond the
    touch bar's close) or `wait`."""
    idx = {b.end: i for i, b in enumerate(bars)}
    ia, k = idx.get(c.break_end), idx.get(c.first_end)
    if ia is None or k is None:
        return "dead"
    last = len(bars) - 1
    if last <= k:
        return "wait"
    if last - k > int(cfg["max_bars_to_retest"]):
        return "dead"
    s = _s(c.side)
    if not all((b.c - c.mark.price) * s > 0 for b in bars[ia:last + 1]):
        return "dead"
    return "confirm" if (bars[last].c - c.ref) * s > 0 else "wait"


def carried_signal(c: Carry, bars: Sequence[Bar], a: float, cfg: Mapping[str, Any]) -> Signal:
    """The retest completed on the newest bar: its close is the entry; the invalidation is the control's
    (`invalidation_atr` ATRs back through the level, at the ATR of the bar it completes on)."""
    s = _s(c.side)
    last = bars[-1]
    return Signal("retest", c.side, c.mark, last.c, c.mark.price - s * float(cfg["invalidation_atr"]) * a,
                  last.end.strftime("%H:%M"))
