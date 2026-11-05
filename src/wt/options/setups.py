"""The options clone's two setups and its gates (DEC-0030, HYP-0029 and HYP-0030). Pure: no I/O, no clock.

The rule is the code: a setup means what `find` does here, under the numbers of config/options_clone.yaml.

Both setups look only at finished 2-minute bars and only at the bar that just closed: a signal is the moment that
bar completes the pattern, never earlier. Prices are the stock's; the option is chosen elsewhere (`wt.options.chain`).
"""
from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from wt.options.regime import Bar, Tape


@dataclass(frozen=True)
class Mark:
    """A marked level. `strong`: a week or month high or low, or a member of a big zone (where a rejection may be
    taken)."""
    name: str
    price: float
    strong: bool = False


@dataclass(frozen=True)
class Signal:
    setup: str             # retest | rejection
    side: str              # call | put
    level: Mark
    entry: float           # the close of the bar that completed the pattern
    invalidation: float    # a 2-minute close beyond this price ends the trade
    bar_end: str           # the completing bar's end, New York time HH:MM


def _hhmm(b: Bar) -> str:
    return b.end.strftime("%H:%M")


def retest(bars: Sequence[Bar], marks: Sequence[Mark], a: float, cfg: Mapping[str, Any]) -> list[Signal]:
    """Break and retest, completed by the last bar.

    For a call at level L: bar A closes above L with the close before it at or below L; within `max_bars_to_retest`
    bars after A, a bar's low comes within `retest_within_atr` ATRs of L, and no bar from A on closes at or below L;
    the last bar is the first after that touch to close above the touch bar's close. A put is the mirror.
    Invalidation: `invalidation_atr` ATRs back through L."""
    if a <= 0 or len(bars) < 3:
        return []
    n_max, near, inv = int(cfg["max_bars_to_retest"]), float(cfg["retest_within_atr"]), float(cfg["invalidation_atr"])
    last = len(bars) - 1
    out: list[Signal] = []
    for m in marks:
        lvl = m.price
        for side, s in (("call", 1), ("put", -1)):
            def beyond(x: float) -> bool:
                return (x - lvl) * s > 0         # noqa: B023 (the loop variables are read at once)
            # the most recent break before the last bar
            ia = next((i for i in range(last - 1, 0, -1)
                       if beyond(bars[i].c) and not beyond(bars[i - 1].c)), None)
            if ia is None or last - ia > n_max + 1:
                continue
            if not all(beyond(b.c) for b in bars[ia:last + 1]):
                continue
            touch = next((j for j in range(ia + 1, last)
                          if ((bars[j].l - lvl) if s > 0 else (lvl - bars[j].h)) <= near * a), None)
            if touch is None or touch - ia > n_max:
                continue
            ref = bars[touch].c
            first_away = next((k for k in range(touch + 1, last + 1) if (bars[k].c - ref) * s > 0), None)
            if first_away != last:
                continue
            out.append(Signal("retest", side, m, bars[last].c, lvl - s * inv * a, _hhmm(bars[last])))
    return out


def rejection(bars: Sequence[Bar], marks: Sequence[Mark], cfg: Mapping[str, Any]) -> list[Signal]:
    """Rejection at a strong level, completed by the last bar.

    For a put at level L (resistance): the bar before A closed at or below L; bar A trades above L and either closes
    at or below L or has at least `wick_share_min` of its range above L; the last bar (B) closes below L. A call is
    the mirror at support. Invalidation: a close beyond A's extreme."""
    if len(bars) < 3:
        return []
    share = float(cfg["wick_share_min"])
    pre, a_bar, b_bar = bars[-3], bars[-2], bars[-1]
    rng = a_bar.h - a_bar.l
    out: list[Signal] = []
    for m in marks:
        if cfg.get("strong_level_only", True) and not m.strong:
            continue
        lvl = m.price
        if pre.c <= lvl < a_bar.h and b_bar.c < lvl:
            if a_bar.c <= lvl or (rng > 0 and (a_bar.h - lvl) / rng >= share):
                out.append(Signal("rejection", "put", m, b_bar.c, a_bar.h, _hhmm(b_bar)))
        if pre.c >= lvl > a_bar.l and b_bar.c > lvl:
            if a_bar.c >= lvl or (rng > 0 and (lvl - a_bar.l) / rng >= share):
                out.append(Signal("rejection", "call", m, b_bar.c, a_bar.l, _hhmm(b_bar)))
    return out


def trap(bars: Sequence[Bar], marks: Sequence[Mark], cfg: Mapping[str, Any]) -> list[Signal]:
    """A failed break (pop and fade) at a strong level, completed by the last bar (HYP-0046, DEC-0041). Read only by
    `wt.options.shadow`: the control never trades it.

    For a put at level L: bar A closes above L with the close before it at or below L (OC-RETEST's break); within
    the `fail_within_bars` bars after A, the last bar is the first to close below L. The entry is that close; the
    invalidation is the highest high from A to the last bar. A call is the mirror at support. Strong levels only."""
    n_fail = int(cfg["fail_within_bars"])
    last = len(bars) - 1
    if last < 2:
        return []
    out: list[Signal] = []
    for m in marks:
        if not m.strong:
            continue
        lvl = m.price
        for side, s in (("put", 1), ("call", -1)):        # s: the side of L the failed break went to
            def across(x: float) -> bool:
                return (x - lvl) * s > 0         # noqa: B023 (the loop variables are read at once)
            if not (bars[last].c - lvl) * s < 0:
                continue
            ia = next((i for i in range(last - 1, max(last - n_fail, 1) - 1, -1)
                       if across(bars[i].c) and not across(bars[i - 1].c)), None)
            if ia is None:
                continue
            if any((b.c - lvl) * s < 0 for b in bars[ia + 1:last]):     # the last bar is the first back inside
                continue
            span = bars[ia:last + 1]
            inv = max(b.h for b in span) if s > 0 else min(b.l for b in span)
            out.append(Signal("trap", side, m, bars[last].c, inv, _hhmm(bars[last])))
    return out


def reclaim_fast(bars: Sequence[Bar], marks: Sequence[Mark], a: float, cfg: Mapping[str, Any]) -> list[Signal]:
    """A sweep and reclaim at a strong level, completed by one bar with no confirming bar (HYP-0047, DEC-0041). Read
    only by `wt.options.shadow`: the control never trades it.

    For a call at level L: the bar before A closed at or above L; bar A's low is below L by at least `sweep_min_atr`
    ATRs and A closes at or above L. The entry is A's close; the invalidation is A's low. A put is the mirror at
    resistance. Strong levels only."""
    if a <= 0 or len(bars) < 2:
        return []
    k = float(cfg["sweep_min_atr"])
    pre, sw = bars[-2], bars[-1]
    out: list[Signal] = []
    for m in marks:
        if not m.strong:
            continue
        lvl = m.price
        if pre.c >= lvl and lvl - sw.l >= k * a and sw.c >= lvl:
            out.append(Signal("reclaim_fast", "call", m, sw.c, sw.l, _hhmm(sw)))
        if pre.c <= lvl and sw.h - lvl >= k * a and sw.c <= lvl:
            out.append(Signal("reclaim_fast", "put", m, sw.c, sw.h, _hhmm(sw)))
    return out


def near_level(close: float, marks: Sequence[Mark], a: float, tolerance_atr: float) -> list[Mark]:
    """The marks within `tolerance_atr` ATRs of the close: the only ones a setup may form at."""
    return [m for m in marks if a > 0 and abs(close - m.price) <= tolerance_atr * a]


def next_level(side: str, entry: float, marks: Sequence[Mark], exclude: float) -> Mark | None:
    """The nearest mark beyond the entry in the trade's direction (the target the room is measured to)."""
    s = 1 if side == "call" else -1
    ahead = [m for m in marks if (m.price - entry) * s > 0 and abs(m.price - exclude) > 1e-9]
    return min(ahead, key=lambda m: abs(m.price - entry)) if ahead else None


@dataclass
class Gates:
    """Every gate of one would-be trade, each with its own verdict and the number behind it. A trade needs all of
    them; the journal keeps every one, so each gate's effect can be studied on its own."""
    checks: dict[str, tuple[bool, Any]] = field(default_factory=dict)

    def add(self, name: str, ok: bool, value: Any) -> None:
        self.checks[name] = (bool(ok), value)

    @property
    def ok(self) -> bool:
        return all(v[0] for v in self.checks.values())

    @property
    def failed(self) -> list[str]:
        return [k for k, v in self.checks.items() if not v[0]]

    def as_json(self) -> dict[str, dict[str, Any]]:
        return {k: {"ok": v[0], "value": v[1]} for k, v in self.checks.items()}


def gate(sig: Signal, tape: Tape, spy: Tape | None, marks: Sequence[Mark], remaining_move: float | None,
         cfg: Mapping[str, Any]) -> Gates:
    """The strategy's gates for a signal (trend, extension, room, reach, shock). Events, the contract and the
    limits are added by the caller, which knows the clock and the account."""
    g = Gates()
    s = 1 if sig.side == "call" else -1
    a = tape.atr or 0.0
    # trend: the name on the trade's side of its VWAP, and SPY not against it
    own = tape.vwap is not None and (tape.close - tape.vwap) * s > 0
    spy_ok = spy is None or spy.vwap is None or (spy.close - spy.vwap) * s >= 0
    g.add("trend", own and spy_ok, {"name_vs_vwap": None if tape.vwap is None else round(tape.close - tape.vwap, 4),
                                    "spy_vs_vwap": None if spy is None or spy.vwap is None
                                    else round(spy.close - spy.vwap, 4)})
    # extension: the entry within a few ATRs of the fast EMA
    ext = abs(sig.entry - tape.ema_fast) / a if a > 0 and tape.ema_fast is not None else None
    g.add("extension", ext is not None and ext <= float(cfg["max_extension_atr"]),
          None if ext is None else round(ext, 3))
    # room: the next level at least `min_room_multiple` risks away
    risk = abs(sig.entry - sig.invalidation)
    nxt = next_level(sig.side, sig.entry, marks, sig.level.price)
    room = abs(nxt.price - sig.entry) / risk if nxt is not None and risk > 0 else None
    g.add("room", room is not None and room >= float(cfg["min_room_multiple"]),
          None if room is None else {"multiple": round(room, 3), "next": nxt.name if nxt else None})
    # reach: the next level inside what the day can still be expected to move
    reach_ok = True
    if cfg.get("room_inside_expected_move", True):
        reach_ok = nxt is not None and remaining_move is not None and abs(nxt.price - sig.entry) <= remaining_move
    g.add("reach", reach_ok, None if remaining_move is None else round(remaining_move, 4))
    # shock: nothing on a bar that broke out of the day's rhythm
    g.add("shock", tape.word != "shock", tape.word)
    return g


# ---------------------------------------------------------------- research tags (DEC-0041, HYP-0034 to HYP-0043)
def _mid_third(x: float, hi: float, lo: float) -> bool:
    third = (hi - lo) / 3
    return hi > lo and lo + third <= x <= hi - third


def broken_marks(bars: Sequence[Bar], marks: Sequence[Mark]) -> list[str]:
    """The marks a finished bar has closed across from the session's opening price (the first bar's open)."""
    if not bars:
        return []
    op = bars[0].o
    out: list[str] = []
    for m in marks:
        if (op > m.price and any(b.c < m.price for b in bars)) or (op < m.price and any(b.c > m.price for b in bars)):
            out.append(m.name)
    return out


def tag_decision(sig: Signal, bars: Sequence[Bar], marks: Sequence[Mark], *, root: str, word: str | None,
                 five: tuple[float, float] | None, leader: Tape | None, leader_names: Sequence[str],
                 iv: float | None, iv_modelled: bool | None, half_day: bool,
                 cfg: Mapping[str, Any]) -> dict[str, Any]:
    """The DEC-0041 flags of one of the control's signals, read at the close of the bar that completed it. Pure, and
    logging only: the control's gates never read them.

    `bars` are the name's finished 2-minute bars of the session up to that bar; `marks` the clone's marks (levels.names
    and the pre-market high and low); `five` the five-session range (SWH, SWL); `leader` the leader's tape (SMH, for
    QQQ) at the same bar close; `iv` the implied volatility of the contract the entry would be priced from.

    - `ntz` (HYP-0034/35): the entry in the middle third (ends included) of the prior session's range or of the five
      sessions' range, and no mark broken this session. `word` is logged beside it.
    - `gap_against` (HYP-0036/37): a call while a gap up (open above PDH) is unfilled (no low at or below PDH yet), or
      a put while a gap down (open below PDL) is unfilled (no high at or above PDL yet).
    - `leader_against` (HYP-0038/39): in a name of `leader_names`, a call with the leader's close below its VWAP or a
      put with it above (equal is not against); None without a leader tape. Absent for other names.
    - `iv_rich` (HYP-0040/41): the iv above `iv_cap_index` (index names) or `iv_cap_single`; None without an iv.
    - `early` (HYP-0042/43): the signal bar ends in [early_from, early_before): True; in [early_before, late_to]:
      False; otherwise and on a half day: None."""
    by = {m.name: m.price for m in marks}
    pdh, pdl = by.get("PDH"), by.get("PDL")
    x = sig.entry
    prior_mid = None if pdh is None or pdl is None else _mid_third(x, pdh, pdl)
    five_mid = None if five is None else _mid_third(x, five[0], five[1])
    broken = broken_marks(bars, marks)
    in_zone = bool(prior_mid) or bool(five_mid)
    out: dict[str, Any] = {"ntz": in_zone and not broken, "ntz_prior_mid": prior_mid, "ntz_five_mid": five_mid,
                           "broken": broken, "word": word}
    # gap
    op = bars[0].o if bars else None
    gap = None if op is None or pdh is None or pdl is None else "up" if op > pdh else "down" if op < pdl else None
    filled: bool | None = None
    if gap == "up" and pdh is not None:
        filled = any(b.l <= pdh for b in bars)
    elif gap == "down" and pdl is not None:
        filled = any(b.h >= pdl for b in bars)
    out |= {"gap": gap, "gap_filled": filled,
            "gap_against": (gap == "up" and sig.side == "call" and filled is False)
            or (gap == "down" and sig.side == "put" and filled is False)}
    # leader
    if root in leader_names:
        if leader is None or leader.vwap is None:
            out |= {"leader_against": None, "leader_vs_vwap": None}
        else:
            d = leader.close - leader.vwap
            out |= {"leader_against": d < 0 if sig.side == "call" else d > 0, "leader_vs_vwap": round(d, 4)}
    # iv
    cap = float(cfg["iv_cap_index"] if root in cfg["index_names"] else cfg["iv_cap_single"])
    out |= {"iv_rich": None if iv is None else iv > cap, "iv": None if iv is None else round(iv, 4), "iv_cap": cap,
            "iv_modelled": iv_modelled}
    # early
    t = sig.bar_end
    early: bool | None = None
    if not half_day:
        if str(cfg["early_from"]) <= t < str(cfg["early_before"]):
            early = True
        elif str(cfg["early_before"]) <= t <= str(cfg["late_to"]):
            early = False
    out["early"] = early
    return out
