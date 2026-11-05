"""The options clone's shadow arms (DEC-0041, HYP-0044 to HYP-0047): virtual trades, never orders. Pure: no I/O, no
clock, no network, and no import of an order path (the broker adapters, the OMS, the risk guard), which a test checks.

The runner hands this module what it already read after each poll (its 2-minute bars, its tapes, the quotes of the
contracts the shadow holds) and writes the records it returns to its own file, `var/options/shadow/<date>.jsonl`. The
control never reads anything here: a virtual trade cannot change an order, a latch, a pause or a position count.

Three arms:

- `runner` (HYP-0044, HYP-0045): a virtual second contract on each real fill of the control's retest or rejection,
  same contract, same fill. Before breakeven: the bid at or below 75% of the fill, or a 2-minute close beyond the
  signal's invalidation. Once the bid has reached 125% of the fill the stop moves to the fill, and a finished 2-minute
  close on the wrong side of `Tape.ema_fast` closes it. Always: the stock reaching the next level, and the flatten time
  (15:10, 12:10 on a half day). No 50% target and no 5-minute time stop. A safety exit of the control (blind, stale
  stock feed, day loss, an operational exit, the flatten) closes it with the control at the control's price.
- `trap` (HYP-0046) and `reclaim_fast` (HYP-0047): the setups of `wt.options.setups` of the same names. A signal that
  passes the control's gates waits for a quoted ask within the entry limit until the end of the next 2-minute bar,
  and is then filled at that ask, or counted unfilled. Exits are the control's (premium stop, breakeven, target, time
  stop, next level, invalidation close, flatten). One virtual position per arm at a time, at most
  `max_entries_per_day` fills per arm.

Every exit is priced at the bid of the quote the runner read at the poll it fired on. Return on premium is after the
clone's fee each way, as `OptionPlan.return_on_premium`.
"""
from __future__ import annotations

import datetime as dt
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import asdict, dataclass, fields
from typing import Any

from wt.options.regime import Bar, Tape

ARMS = ("runner", "trap", "reclaim_fast")
# The control's exits that close the runner with it, at the control's price (HYP-0044: blind exit, stale quote, kill
# switch, a latch, the flatten). The control's own strategy exits (premium, breakeven, time, target, next level, chart,
# a resting stop or target at the broker) do not: the runner keeps its own.
SAFETY_EXITS = frozenset({"flatten", "day-loss", "blind", "stock-feed-stalled", "operational", "kill", "latch"})


@dataclass
class Virtual:
    """One virtual trade. `state`: pending (waiting for a fill) | open | closed | unfilled."""
    arm: str
    vid: str
    root: str
    symbol: str
    side: str                      # call | put
    setup: str
    level: str
    level_price: float
    invalidation: float
    next_level: float | None
    signal_bar: str                # HH:MM
    state: str = "pending"
    paired: str = ""               # runner: the control's trade id
    limit: float | None = None     # trap / reclaim_fast: the entry limit
    deadline: str = ""             # trap / reclaim_fast: ISO time after which a pending entry is unfilled
    fill: float | None = None
    filled_at: str = ""
    breakeven: bool = False
    breakeven_at: str = ""
    best_bid: float | None = None
    last_bid: float | None = None  # the last bid read: an exit with no bid now is priced here and says so
    exit_fill: float | None = None
    exit_at: str = ""
    exit_reason: str = ""

    def rop(self, fee: float) -> float | None:
        """Return on premium after `fee` a contract each way, or None until closed."""
        if self.fill is None or self.exit_fill is None or not self.fill:
            return None
        return round(((self.exit_fill - self.fill) * 100 - 2 * fee) / (self.fill * 100 + fee), 4)


def _last_after(bars: Sequence[Bar], since: dt.datetime) -> Bar | None:
    return next((b for b in reversed(bars) if b.end > since), None)


def runner_exit(v: Virtual, now: dt.datetime, bid: float | None, bars: Sequence[Bar], tape: Tape | None,
                flatten: dt.datetime, cfg: Mapping[str, Any]) -> str | None:
    """The runner's first exit that fires now (HYP-0044), or None. Needs a bid to price any exit but the flatten."""
    if now >= flatten:
        return "flatten"
    if bid is None or v.fill is None:
        return None
    s = 1 if v.side == "call" else -1
    filled_at = dt.datetime.fromisoformat(v.filled_at)
    last = _last_after(bars, filled_at)
    if not v.breakeven:
        if last is not None and (last.c - v.invalidation) * s < 0:
            return "chart"
        if bid <= v.fill * (1 - float(cfg["premium_stop_pct"]) / 100) + 1e-9:
            return "premium"
    else:
        if bid <= v.fill + 1e-9:
            return "breakeven"
        since = dt.datetime.fromisoformat(v.breakeven_at)
        if bars and bars[-1].end > since and tape is not None and tape.ema_fast is not None \
                and (bars[-1].c - tape.ema_fast) * s < 0:      # a close finished after breakeven, past the 9 EMA
            return "trail"
    if v.next_level is not None and tape is not None and (tape.close - v.next_level) * s >= 0:
        return "next-level"
    return None


def control_exit(v: Virtual, now: dt.datetime, bid: float | None, bars: Sequence[Bar], tape: Tape | None,
                 flatten: dt.datetime, ex: Mapping[str, Any]) -> str | None:
    """The control's exits, in `Runner.exit_reason`'s order, for a virtual trap or reclaim trade (HYP-0046/47)."""
    if now >= flatten:
        return "flatten"
    if bid is None or v.fill is None:
        return None
    s = 1 if v.side == "call" else -1
    filled_at = dt.datetime.fromisoformat(v.filled_at)
    last = _last_after(bars, filled_at)
    if last is not None and (last.c - v.invalidation) * s < 0:
        return "chart"
    stop = v.fill if v.breakeven else v.fill * (1 - float(ex["premium_stop_pct"]) / 100)
    if bid <= stop + 1e-9:
        return "breakeven" if v.breakeven else "premium"
    if now - filled_at >= dt.timedelta(minutes=float(ex["time_stop_min"])) and bid <= v.fill + 1e-9:
        return "time"
    if ex.get("take_profit_at_next_level") and v.next_level is not None and tape is not None \
            and (tape.close - v.next_level) * s >= 0:
        return "next-level"
    if bid >= v.fill * (1 + float(ex["target_pct"]) / 100) - 1e-9:
        return "target"
    return None


class Shadow:
    """The session's virtual book. Every method returns the records to append to the shadow file; none writes."""

    def __init__(self, session: str, arms_cfg: Mapping[str, Any], exits: Mapping[str, Any], fee: float,
                 flatten: dt.datetime) -> None:
        sh = arms_cfg["shadow"]
        self.session = session
        self.enabled = {a for a in sh.get("arms", ARMS) if a in ARMS}
        self.runner_cfg = sh["runner"]
        self.max_entries = int(sh["max_entries_per_day"])
        self.exits = exits
        self.fee = fee
        self.flatten = flatten
        self.trades: list[Virtual] = []

    # ---- records -----------------------------------------------------------------------------
    def _rec(self, event: str, v: Virtual, now: dt.datetime, **kw: Any) -> dict[str, Any]:
        return {"ts": now.isoformat(), "event": event, **asdict(v), "rop": v.rop(self.fee), **kw}

    def restore(self, records: Iterable[Mapping[str, Any]]) -> None:
        """A restart's book: the last record of each virtual trade, as it was written."""
        names = {f.name for f in fields(Virtual)}
        last: dict[str, Mapping[str, Any]] = {}
        for r in records:
            if isinstance(r, Mapping) and isinstance(r.get("vid"), str) and r.get("arm") in ARMS:
                last[str(r["vid"])] = r
        self.trades = [Virtual(**{k: v for k, v in r.items() if k in names}) for r in last.values()]

    def busy(self, arm: str) -> bool:
        return any(v.arm == arm and v.state in ("pending", "open") for v in self.trades)

    def fills(self, arm: str) -> int:
        return sum(v.arm == arm and v.fill is not None for v in self.trades)

    def symbols(self) -> list[str]:
        """The contracts whose quotes the next poll needs."""
        return sorted({v.symbol for v in self.trades if v.state in ("pending", "open")})

    # ---- the runner arm ----------------------------------------------------------------------
    def open_runner(self, trade_id: str, root: str, symbol: str, side: str, setup: str, level: str,
                    level_price: float, invalidation: float, next_level: float | None, signal_bar: str,
                    fill: float, filled_at: str, now: dt.datetime) -> list[dict[str, Any]]:
        """The virtual second contract on a real fill of the control's retest or rejection."""
        if "runner" not in self.enabled or setup not in ("retest", "rejection"):
            return []
        if any(v.arm == "runner" and v.paired == trade_id for v in self.trades):
            return []                                        # a restart sees the same fill again
        v = Virtual("runner", f"{trade_id}-R", root, symbol, side, setup, level, level_price, invalidation,
                    next_level, signal_bar, "open", paired=trade_id, fill=fill, filled_at=filled_at, best_bid=fill,
                    last_bid=fill)
        self.trades.append(v)
        return [self._rec("filled", v, now)]

    def control_closed(self, trade_id: str, reason: str, price: float | None,
                       now: dt.datetime) -> list[dict[str, Any]]:
        """The control's trade closed: a safety exit closes its runner with it, at the same price."""
        out: list[dict[str, Any]] = []
        if reason not in SAFETY_EXITS or price is None:
            return out
        for v in self.trades:
            if v.arm == "runner" and v.paired == trade_id and v.state == "open":
                out.append(self._close(v, f"with-control:{reason}", price, now))
        return out

    # ---- the trap and reclaim arms -----------------------------------------------------------
    def signal(self, arm: str, v: Virtual, gates_ok: bool, why: Mapping[str, Any],
               now: dt.datetime) -> list[dict[str, Any]]:
        """A trap or reclaim signal and the control's verdict on it. Pending when it passes and the arm is free."""
        if arm not in self.enabled:
            return []
        refused = None if gates_ok else "gates"
        if refused is None and self.busy(arm):
            refused = "arm-busy"
        if refused is None and self.fills(arm) >= self.max_entries:
            refused = "max-entries"
        if refused is None and v.limit is None:
            refused = "no-contract"
        if refused is not None:
            return [{"ts": now.isoformat(), "event": "signal", "arm": arm, "root": v.root, "side": v.side,
                     "level": v.level, "signal_bar": v.signal_bar, "entry": None, "refused": refused, "why": dict(why)}]
        self.trades.append(v)
        return [self._rec("pending", v, now, why=dict(why))]

    # ---- each poll ---------------------------------------------------------------------------
    def step(self, now: dt.datetime, quotes: Mapping[str, tuple[float | None, float | None]],
             bars: Mapping[str, Sequence[Bar]], tapes: Mapping[str, Tape]) -> list[dict[str, Any]]:
        """Fill what is pending, then close what an exit closes. `quotes`: symbol -> (bid, ask)."""
        out: list[dict[str, Any]] = []
        for v in self.trades:
            bid, ask = quotes.get(v.symbol, (None, None))
            if v.state == "pending":
                if v.deadline and now > dt.datetime.fromisoformat(v.deadline):
                    v.state = "unfilled"
                    out.append(self._rec("unfilled", v, now))
                elif ask is not None and v.limit is not None and ask <= v.limit + 1e-9:
                    v.state, v.fill, v.filled_at = "open", ask, now.isoformat()
                    v.best_bid = v.last_bid = bid
                    out.append(self._rec("filled", v, now))
                continue
            if v.state != "open" or v.fill is None:
                continue
            if bid is not None:
                v.last_bid = bid
                v.best_bid = max(v.best_bid or bid, bid)
                be = float((self.runner_cfg if v.arm == "runner" else self.exits)["breakeven_after_pct"])
                if not v.breakeven and v.best_bid >= v.fill * (1 + be / 100) - 1e-9:
                    v.breakeven, v.breakeven_at = True, now.isoformat()
                    out.append(self._rec("breakeven", v, now))
            rb, tape = bars.get(v.root, ()), tapes.get(v.root)
            why = runner_exit(v, now, bid, rb, tape, self.flatten, self.runner_cfg) if v.arm == "runner" else \
                control_exit(v, now, bid, rb, tape, self.flatten, self.exits)
            if why is not None:
                out.append(self._close(v, why if bid is not None else f"{why}:last-bid",
                                       bid if bid is not None else v.last_bid, now))
        return out

    def _close(self, v: Virtual, why: str, price: float | None, now: dt.datetime) -> dict[str, Any]:
        v.state, v.exit_fill, v.exit_at, v.exit_reason = "closed", price, now.isoformat(), why
        return self._rec("closed", v, now)
