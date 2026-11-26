"""The stock desk's execution stops (DEC-0073 section 1): five faults that latch the desk across sessions.

Read from the desk's own journal, so a restart, a later session and the scorecard all see the same answer:

  * X1 short:          a `short_position` row, or an `END_OF_DAY_NOT_FLAT` row with `short`;
  * X2 not flat:       an `END_OF_DAY_NOT_FLAT` row with `protected` false (a position the desk holds after the close
                       with no resting GTC stop; a halted name on its stop overnight is protected);
  * X3 unprotected:    an `unprotected` row: a position the desk owns had no resting stop at `unprotected_polls`
                       polls in a row (a DEC-0071 hold is not counted);
  * X4 off-rule entry: on a Gap Hunter day (one with a `gap_primary` row), an entry filled in another name, or with no
                       primary at all, or a second entry that day. On a day that traded HYP-0072 (DEC-0076: a
                       `gap_names` row), "another name" is one outside that row's tier-2 names;
  * X5 stop slippage:  `stop_slips` stop exits, each filled under its stop price by more than the larger of
                       `stop_slip_r` R and `stop_slip_min_usd` a share (the stop order's own fill, `stop_fill` and
                       `stop_price` on `trade_closed`).

Only rows after the last reset of a DEC-0073 latch count: a reset needs a new decision record (the latch reason
starts with STOP_RULE_PREFIX), and that record is what closed the fault. A latch reason never names a symbol.
Thresholds live in `config/risk.yaml` (`S.execution_stops`), never here.
"""
from __future__ import annotations

import datetime as dt
import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

from wt.core.config import CONFIG_DIR
from wt.risk.virtual_account import STOP_RULE_PREFIX

DECISION_ID = re.compile(r"\bDEC-\d{4}\b")
CODES = ("X1", "X2", "X3", "X4", "X5")


@dataclass(frozen=True)
class Rules:
    decision: str
    unprotected_polls: int
    stop_slip_r: float
    stop_slip_min_usd: float
    stop_slips: int


@dataclass(frozen=True)
class XStop:
    code: str          # X1 .. X5
    detail: str        # counts only: never a symbol or a price


def load(strategy: str = "S", path: Path | None = None) -> Rules | None:
    """The desk's execution stops, or None when its config has none."""
    cfg: Mapping[str, Any] = yaml.safe_load((path or CONFIG_DIR / "risk.yaml").read_text())[strategy]
    raw = cfg.get("execution_stops")
    if not raw:
        return None
    decision = str(raw["decision"])
    if not DECISION_ID.fullmatch(decision):
        raise ValueError(f"execution_stops.decision must be a decision record id, not {decision!r}")
    rules = Rules(decision=decision, unprotected_polls=int(raw["unprotected_polls"]),
                  stop_slip_r=float(raw["stop_slip_r"]), stop_slip_min_usd=float(raw["stop_slip_min_usd"]),
                  stop_slips=int(raw["stop_slips"]))
    if rules.unprotected_polls < 1 or rules.stop_slips < 1 or rules.stop_slip_r <= 0 or rules.stop_slip_min_usd < 0:
        raise ValueError("execution_stops: polls and slips must be at least 1, the slip in R above zero, and the "
                         "floor in US$ not negative")
    return rules


def last_reset(history: Iterable[Mapping[str, Any]], decision: str) -> str:
    """The time (ISO, UTC) of the last reset of a latch this record set, or "" for none."""
    tag = f"({decision})"
    at = [str(h.get("at") or "") for h in history if tag in str(h.get("reason") or "")]
    return max(at, default="")


def _after(rows: Iterable[Mapping[str, Any]], since: str) -> list[Mapping[str, Any]]:
    if not since:
        return list(rows)
    cut = dt.datetime.fromisoformat(since)
    if cut.tzinfo is None:
        cut = cut.replace(tzinfo=dt.UTC)
    out = []
    for r in rows:
        try:
            t = dt.datetime.fromisoformat(str(r.get("ts")))
        except ValueError:
            continue
        if t.tzinfo is None:
            t = t.replace(tzinfo=dt.UTC)
        if t > cut:
            out.append(r)
    return out


def _num(x: Any) -> float | None:
    return float(x) if isinstance(x, (int, float)) and not isinstance(x, bool) else None


def slips(rows: Iterable[Mapping[str, Any]], rules: Rules) -> int:
    """Stop exits filled under their stop price by more than the larger of `stop_slip_r` R and `stop_slip_min_usd`
    a share, once per trade."""
    n, seen = 0, set()
    for r in rows:
        if r.get("event") != "trade_closed" or r.get("origin", "entry") != "entry":
            continue
        tid = str(r.get("trade_id"))
        fill, price, entry, stop0 = (_num(r.get(k)) for k in ("stop_fill", "stop_price", "entry", "stop"))
        if tid in seen or fill is None or price is None or entry is None or stop0 is None or entry <= stop0:
            continue
        seen.add(tid)
        n += price - fill > max(rules.stop_slip_r * (entry - stop0), rules.stop_slip_min_usd) + 1e-9
    return n


def _off_rule(rows: list[Mapping[str, Any]]) -> str | None:
    primary: dict[str, str | None] = {}
    names: dict[str, set[str]] = {}                       # HYP-0072's days: the tier-2 names it may trade
    for r in rows:
        if r.get("event") == "gap_primary":
            day = str(r.get("day") or "")[:10]
            primary.setdefault(day, r.get("symbol") or None)
        elif r.get("event") == "gap_names":
            day = str(r.get("day") or "")[:10]
            names.setdefault(day, {str(x[1]) for x in (r.get("names") or []) if isinstance(x, list | tuple) and len(x) == 2})
    filled: dict[str, set[str]] = {}
    for r in rows:
        if r.get("event") != "entry_filled":
            continue
        tid = str(r.get("trade_id") or "")
        day = tid[:10]
        if day not in primary or tid.endswith("-orphan"):
            continue                                      # not a Gap Hunter day, or not one of its entries
        if day in names:
            if r.get("symbol") not in names[day]:
                return f"an entry filled on {day} in a name outside the day's tier-2 names"
        elif primary[day] is None:
            return f"an entry filled on {day}, a day with no primary"
        elif r.get("symbol") != primary[day]:
            return f"an entry filled on {day} in a name other than the day's primary"
        filled.setdefault(day, set()).add(tid)
        if len(filled[day]) > 1:
            return f"{len(filled[day])} entries filled on {day}; the rule takes one a day"
    return None


def evaluate(rules: Rules, rows: Iterable[Mapping[str, Any]], since: str = "") -> XStop | None:
    """The first execution stop that holds, in the record's order, over the rows after `since`; or None."""
    rs = _after(rows, since)
    for r in rs:
        e = r.get("event")
        if e == "short_position" or (e == "END_OF_DAY_NOT_FLAT" and r.get("short")):
            return XStop("X1", "the account was short")
    for r in rs:
        if r.get("event") == "END_OF_DAY_NOT_FLAT" and r.get("protected") is False:
            return XStop("X2", "a position was left after the close with no resting GTC stop")
    for r in rs:
        polls = _num(r.get("polls"))
        if r.get("event") == "unprotected" and polls is not None and polls >= rules.unprotected_polls:
            return XStop("X3", f"a position had no resting stop at {int(polls)} polls in a row")
    why = _off_rule(rs)
    if why:
        return XStop("X4", why)
    n = slips(rs, rules)
    if n >= rules.stop_slips:
        return XStop("X5", f"{n} stop exits filled more than {rules.stop_slip_r:.2f}R (at least "
                           f"US${rules.stop_slip_min_usd:.2f}) under their stop")
    return None


def latch_reason(x: XStop, rules: Rules) -> str:
    """A latch reason that only a new decision record clears (virtual_account.reset_latch)."""
    return f"{STOP_RULE_PREFIX}{x.code}: {x.detail} ({rules.decision})"


def state_line(rules: Rules, rows: Iterable[Mapping[str, Any]], since: str = "") -> str:
    """One scorecard line: where X3 and X5 stand since the last reset, and whether a stop has fired."""
    rs = _after(rows, since)
    most = max((int(_num(r.get("polls")) or 0) for r in rs if r.get("event") == "unprotected"), default=0)
    fired = evaluate(rules, rs)
    return (f"- Execution stops ({rules.decision}): unprotected polls in a row, most {most} of "
            f"{rules.unprotected_polls} · stop exits over {rules.stop_slip_r:.2f}R (at least "
            f"US${rules.stop_slip_min_usd:.2f}) slip {slips(rs, rules)} of "
            f"{rules.stop_slips}" + (f" · since the reset of {since[:10]}" if since else "")
            + (f" · **FIRED: {fired.code}, {fired.detail}**" if fired else ""))
