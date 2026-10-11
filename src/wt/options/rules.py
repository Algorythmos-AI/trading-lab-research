"""The four entry rules on paper probation, replayed on one session's hourly bars. Pure: no I/O.

Moved here from the cloud project's `olib` module with its behaviour unchanged. Results are in R on the stock,
before any option cost: they say whether a rule's signal had direction, not what an option trade would have made.
"""
from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from wt.options.levels import Bar, LevelSet

RULES = ("brk_PDH_close", "reclaim_PDL_close", "brk_PDL_close", "reject_PDH_close")


def probation_triggers(hourly: Sequence[Bar | tuple[Any, ...]], lv: LevelSet) -> list[dict[str, Any]]:
    """Replay one session's hourly bars against its levels; return each rule's first trigger and its result.

    Same rules as the v3 plan's intraday test: entry on the hourly close across the level; stop a fifth
    of ATR beyond the level (or just beyond the day's extreme for reclaim/reject); target 2R; stop and
    target in the same bar count as a stop; exit at the session's last close otherwise. No entry on the
    last bar. Results are in R on the stock, before option costs.
    """
    bars = [h if isinstance(h, Bar) else Bar(*h) for h in hourly]
    pdh = next(x.price for x in lv["levels"] if x.name == "PDH")
    pdl = next(x.price for x in lv["levels"] if x.name == "PDL")
    pdc = lv["last"]["close"]
    a = lv["atr14"]
    buf = 0.2 * a
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    lo: float | None = None
    hi: float | None = None
    for j, b in enumerate(bars):
        lo = b.l if lo is None else min(lo, b.l)
        hi = b.h if hi is None else max(hi, b.h)
        if j == len(bars) - 1:
            break
        prev = bars[j - 1].c if j else pdc
        cands: list[tuple[str, int, float, float]] = []
        if b.c > pdh and prev <= pdh:
            cands.append(("brk_PDH_close", 1, b.c, pdh - buf))
        if lo < pdl and b.c > pdl and prev <= pdl:
            cands.append(("reclaim_PDL_close", 1, b.c, lo - 0.05 * a))
        if b.c < pdl and prev >= pdl:
            cands.append(("brk_PDL_close", -1, b.c, pdl + buf))
        if hi > pdh and b.c < pdh and prev >= pdh:
            cands.append(("reject_PDH_close", -1, b.c, hi + 0.05 * a))
        for rule, side, entry, stop in cands:
            if rule in seen or (entry - stop) * side <= 0:
                continue
            seen.add(rule)
            risk = abs(entry - stop)
            tgt = entry + side * 2 * risk
            r: float | None = None
            how = "close"
            for k in bars[j + 1:]:
                if side > 0 and k.l <= stop or side < 0 and k.h >= stop:
                    r, how = -1.0, "stop"
                    break
                if side > 0 and k.h >= tgt or side < 0 and k.l <= tgt:
                    r, how = 2.0, "target"
                    break
            if r is None:
                r = side * (bars[-1].c - entry) / risk
            out.append({"rule": rule, "side": "call" if side > 0 else "put", "trigger_bar": b.d, "entry": round(entry, 2),
                        "stop": round(stop, 2), "target": round(tgt, 2), "exit": how, "r": round(r, 3)})
    return out
