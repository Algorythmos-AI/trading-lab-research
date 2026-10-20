"""EXP-0025: the options clone's one historical dry run (DEC-0031). Pure: bars in, trades out; no I/O, no clock.

Signals come from the clone's own code (`wt.options.regime`, `setups`, `session`) under config/options_clone.yaml.
Prices come from the same-day contract's 1-minute trade bars, with half the assumed spread paid on each side
(DEC-0029's widths for SPY and QQQ: the larger of $0.02 and 2% of the price, full width), and are managed minute by
minute in the clone's exit order (DEC-0031, section 3).
"""
from __future__ import annotations

import datetime as dt
import math
from collections import Counter
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from wt.options import bs, regime, session, setups
from wt.options.regime import NEW_YORK


@dataclass(frozen=True)
class OBar:
    start: dt.datetime
    o: float
    h: float
    l: float  # noqa: E741
    c: float
    vw: float


def occ(root: str, day: dt.date, side: str, strike: float) -> str:
    return f"{root}{day:%y%m%d}{'C' if side == 'call' else 'P'}{int(round(strike * 1000)):08d}"


def nearest_strike(spot: float) -> float:
    """The listed strike nearest the stock, on these names' one-dollar grid; of two equally near, the lower."""
    lo = math.floor(spot)
    return float(lo if spot - lo <= 0.5 else lo + 1)


def half_spread(price: float, mult: float) -> float:
    return max(0.02, 0.02 * price) / 2 * mult


@dataclass
class Open:
    root: str
    symbol: str
    side: str
    setup: str
    fill: float
    fill_at: dt.datetime          # the start of the minute the entry filled in
    invalidation: float
    next_level: float | None
    breakeven: bool = False
    best: float = 0.0
    last: float = 0.0
    missing: int = 0
    pending: str | None = None    # an exit decided now, priced on the next minute


@dataclass
class Day:
    trades: list[dict[str, Any]] = field(default_factory=list)
    left_out: Counter[str] = field(default_factory=Counter)
    pnl: float = 0.0


def replay_day(day: dt.date, minutes: Mapping[str, Sequence[regime.Bar]], marks: Mapping[str, Sequence[setups.Mark]],
               option_bars: Callable[[str], Sequence[OBar]], cfg: Mapping[str, Any], risk: Mapping[str, Any],
               macro: Sequence[Mapping[str, Any]], spread_mult: float = 1.0) -> Day:
    """One session. `minutes`: each root's regular-hours 1-minute stock bars (SPY included, for the trend gate)."""
    ck = session.clock(day.isoformat(), cfg["day"])
    fee = float(cfg["costs"]["fee_per_contract_each_way"])
    b, g, ex, dcfg = cfg["bars"], cfg["gates"], cfg["exits"], cfg["day"]
    out = Day()
    pos: Open | None = None
    entries, attempts = 0, Counter[str]()
    streak, last_loss_at = 0, None
    cooldown: dict[str, dt.datetime] = {}
    latched = False
    cache: dict[str, dict[dt.datetime, OBar]] = {}

    def bars_of(sym: str) -> dict[dt.datetime, OBar]:
        if sym not in cache:
            cache[sym] = {x.start: x for x in option_bars(sym)}
        return cache[sym]

    def close(p: Open, price: float, why: str, at: dt.datetime) -> None:
        nonlocal pos, streak, last_loss_at
        pnl = round((price - p.fill) * 100 - 2 * fee, 2)
        out.pnl += pnl
        out.trades.append({"event": "trade_closed", "trade_id": f"{day}-O-{len(out.trades) + 1}", "setup": p.setup,
                           "root": p.root, "side": p.side, "symbol": p.symbol, "state": "closed", "counts": True,
                           "fill": round(p.fill, 4), "exit_fill": round(price, 4), "exit_reason": why,
                           "best_bid": round(p.best, 4), "pnl": pnl,
                           "rop": round(pnl / (p.fill * 100 + fee), 4), "entered": p.fill_at.strftime("%H:%M"),
                           "exited": at.strftime("%H:%M")})
        if pnl < 0:
            streak += 1
            last_loss_at = at
            cooldown[p.root] = at + dt.timedelta(minutes=float(dcfg["name_cooldown_after_loss_min"]))
        else:
            streak = 0
        pos = None

    roots = sorted(r for r in minutes if r in marks)
    end = ck.close
    t = ck.open + dt.timedelta(minutes=1)
    while t <= end:
        prev = t - dt.timedelta(minutes=1)
        # ---- the open trade, on the minute that just finished
        if pos is not None:
            ob = bars_of(pos.symbol).get(prev)
            if ob is None:
                pos.missing += 1
                if pos.missing >= 3 and not pos.pending:
                    pos.pending = "gap-exit"
            else:
                pos.missing = 0
                hs = half_spread(ob.vw, spread_mult)
                if pos.pending:
                    close(pos, ob.vw - hs, pos.pending, prev)
                else:
                    stop = pos.fill if pos.breakeven else pos.fill * (1 - float(ex["premium_stop_pct"]) / 100)
                    open_pnl = (ob.c - hs - pos.fill) * 100 - 2 * fee
                    if prev >= ck.flatten:
                        close(pos, ob.vw - hs, "flatten", prev)
                    elif out.pnl + open_pnl <= -float(risk["day_loss_latch"]):
                        latched = True
                        close(pos, ob.vw - hs, "day-loss", prev)
                    elif ob.o <= stop:
                        close(pos, ob.o - half_spread(ob.o, spread_mult), "breakeven" if pos.breakeven else "premium", prev)
                    elif ob.l <= stop:
                        close(pos, stop - half_spread(stop, spread_mult), "breakeven" if pos.breakeven else "premium", prev)
                    elif prev - pos.fill_at >= dt.timedelta(minutes=float(ex["time_stop_min"])) and ob.c <= pos.fill:
                        close(pos, ob.c - hs, "time", prev)
                    elif ob.h >= pos.fill * (1 + float(ex["target_pct"]) / 100):
                        tgt = pos.fill * (1 + float(ex["target_pct"]) / 100)
                        close(pos, tgt - half_spread(tgt, spread_mult), "target", prev)
                    else:
                        pos.best = max(pos.best, ob.h - hs)
                        pos.last = ob.c
                        if ob.h >= pos.fill * (1 + float(ex["breakeven_after_pct"]) / 100):
                            pos.breakeven = True
        # ---- on a 2-minute boundary: the chart, the next level, and entries
        if (t - ck.open).total_seconds() % (int(b["minutes"]) * 60) == 0:
            two = {r: regime.resample([m for m in minutes[r] if m.end <= t], int(b["minutes"]), t)
                   for r in set(roots) | ({"SPY"} & set(minutes))}
            tapes = {r: x for r, bars in two.items()
                     if (x := regime.read(bars, int(b["atr_period"]), int(b["ema_fast"]), int(b["ema_slow"]),
                                          float(g["shock_bar_atr"]))) is not None}
            if pos is not None and not pos.pending and two.get(pos.root):
                last = two[pos.root][-1]
                s = 1 if pos.side == "call" else -1
                if last.end > pos.fill_at and (last.c - pos.invalidation) * s < 0:
                    pos.pending = "chart"
                elif pos.next_level is not None and (last.c - pos.next_level) * s >= 0:
                    pos.pending = "next-level"
            paused = streak >= int(dcfg["loss_pause_after"]) and last_loss_at is not None and \
                t < last_loss_at + dt.timedelta(minutes=float(dcfg["loss_pause_min"]))
            if (pos is None and not latched and streak < int(dcfg["done_after_losses"]) and not paused
                    and ck.first_entry <= t <= ck.last_entry and entries < int(risk["max_entries_per_day"])):
                for root in roots:
                    if pos is not None:
                        break
                    tape = tapes.get(root)
                    if tape is None or tape.atr is None or tape.atr <= 0 or not two.get(root):
                        continue
                    if attempts[root] >= int(risk["max_attempts_per_name"]) or (root in cooldown and t < cooldown[root]):
                        continue
                    if session.event_block(t, root, macro, (), g, cfg["contract"]["index_names"]):
                        continue
                    near = setups.near_level(tape.close, marks[root], tape.atr, float(cfg["levels"]["tolerance_atr"]))
                    sigs = setups.retest(two[root], near, tape.atr, cfg["setups"]["retest"]) + \
                        setups.rejection(two[root], near, cfg["setups"]["rejection"])
                    for sig in sigs:
                        out.left_out["signal:" + sig.setup] += 1                 # every signal, kept or not
                        k = nearest_strike(tape.close)
                        sym = occ(root, day, sig.side, k)
                        obs = bars_of(sym)
                        first = next((obs[x] for x in sorted(obs) if t <= x < t + dt.timedelta(minutes=3)), None)
                        if first is None:
                            out.left_out["no-option-bar:" + sig.setup] += 1
                            continue
                        price = first.vw + half_spread(first.vw, spread_mult)
                        left_min = max((ck.close - t).total_seconds() / 60, 1.0)
                        iv = bs.implied_vol(first.vw, tape.close, k, left_min, "call" if sig.side == "call" else "put")
                        gates = setups.gate(sig, tape, tapes.get("SPY"), marks[root],
                                            session.remaining_move(tape.close, iv, t, ck), g)
                        if not gates.ok:
                            out.left_out["gate:" + ",".join(gates.failed)] += 1
                            continue
                        if price > float(cfg["contract"]["max_ask"]):
                            out.left_out["over-cap:" + sig.setup] += 1
                            continue
                        nxt = setups.next_level(sig.side, sig.entry, marks[root], sig.level.price)
                        pos = Open(root, sym, sig.side, sig.setup, price, first.start, sig.invalidation,
                                   nxt.price if nxt else None, best=price, last=price)
                        entries += 1
                        attempts[root] += 1
                        break
        t += dt.timedelta(minutes=1)
    if pos is not None:                          # no bar after the flatten: priced at its last minute
        close(pos, pos.last - half_spread(pos.last, spread_mult), "end-of-data", end)
    return out


def minute_bars_from(rows: Sequence[Mapping[str, Any]], day: dt.date) -> list[regime.Bar]:
    return regime.minute_bars(rows, day)


def option_bars_from(rows: Sequence[Mapping[str, Any]]) -> list[OBar]:
    out = []
    for r in rows:
        try:
            at = dt.datetime.fromisoformat(str(r["t"]).replace("Z", "+00:00")).astimezone(NEW_YORK)
            o, h, low, c = (float(r[k]) for k in ("o", "h", "l", "c"))
            vw = float(r.get("vw") or c)
        except (KeyError, TypeError, ValueError):
            continue
        if min(o, h, low, c, vw) > 0:
            out.append(OBar(at, o, h, low, c, vw))
    return sorted(out, key=lambda x: x.start)
