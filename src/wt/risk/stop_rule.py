"""The stocks desk's pre-registered stop (DEC-0037): three triggers, written down before they can fire.

A gate that only counts trades cannot close a desk that keeps losing; this rule can. It reads `config/risk.yaml`
(`B.stop_rule`) and strategy B's own journal, and says whether entries must stop:

  * `cum_r`:  the cumulative R over B's closed trades (real exits only) is at or under `cum_r_max_loss`;
  * `review`: at `review_at_trades` closed trades or more, the bootstrap CI95 upper bound of E[R] is below zero;
  * `date`:   `stop_date` has arrived, whatever the count is.

The runner evaluates it at arming time (`wt.live.runner_b`) and, when it fires, latches the virtual account with a
reason that starts with STOP_RULE_PREFIX: `make reset-latch` then refuses to clear it unless the reason names a
decision record (`wt.risk.virtual_account.reset_latch`). The weekly scorecard prints where the rule stands.
Thresholds live in the config, never here; changing one is a new decision record.
"""
from __future__ import annotations

import datetime as dt
import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

from wt.analytics import g2
from wt.analytics.performance import bootstrap_ci
from wt.core.config import CONFIG_DIR
from wt.risk.virtual_account import STOP_RULE_PREFIX

DECISION_ID = re.compile(r"\bDEC-\d{4}\b")


@dataclass(frozen=True)
class StopRule:
    decision: str
    cum_r_max_loss: float
    review_at_trades: int
    stop_date: dt.date


@dataclass(frozen=True)
class Stop:
    kind: str          # cum_r | review | date
    detail: str


def load(strategy: str = "B", path: Path | None = None) -> StopRule | None:
    """The rule for a strategy, or None when its config carries none (then nothing stops it: say so loudly)."""
    cfg: Mapping[str, Any] = yaml.safe_load((path or CONFIG_DIR / "risk.yaml").read_text())[strategy]
    raw = cfg.get("stop_rule")
    if not raw:
        return None
    date = raw["stop_date"]
    if not isinstance(date, dt.date):
        date = dt.date.fromisoformat(str(date))
    decision = str(raw["decision"])
    if not DECISION_ID.fullmatch(decision):
        raise ValueError(f"stop_rule.decision must be a decision record id, not {decision!r}")
    return StopRule(decision=decision, cum_r_max_loss=float(raw["cum_r_max_loss"]),
                    review_at_trades=int(raw["review_at_trades"]), stop_date=date)


def rs_of(rows: Iterable[dict[str, Any]]) -> list[float]:
    """The R of each of B's entry-origin closed trades with a real exit, once per trade id, in journal order."""
    out: list[float] = []
    for t in g2.trades(rows):
        if t.get("exit_price_estimated"):
            continue
        r = t.get("R")
        if isinstance(r, (int, float)) and not isinstance(r, bool):
            out.append(float(r))
    return out


def evaluate(rule: StopRule, rows: Iterable[dict[str, Any]], today: dt.date) -> Stop | None:
    """The first trigger that holds, in the order written in the record, or None."""
    rs = rs_of(rows)
    n, cum = len(rs), sum(rs)
    if n and cum <= rule.cum_r_max_loss + 1e-9:          # "at or under", robust to the last bits of a float sum
        return Stop("cum_r", f"cumulative {cum:+.2f}R over {n} trades, at or under {rule.cum_r_max_loss:+.1f}R")
    if n >= rule.review_at_trades:
        _, hi = bootstrap_ci(rs)
        if hi < 0:
            return Stop("review", f"{n} trades: the CI95 upper bound of E[R] is {hi:+.3f}, below zero")
    if today >= rule.stop_date:
        return Stop("date", f"{rule.stop_date.isoformat()} reached with {n} trades")
    return None


def latch_reason(stop: Stop, rule: StopRule) -> str:
    """The latch reason a fired rule writes: its prefix is what makes the reset ask for a decision record."""
    return f"{STOP_RULE_PREFIX}{stop.kind}: {stop.detail} ({rule.decision})"


def state_line(rule: StopRule, rows: Iterable[dict[str, Any]], today: dt.date) -> str:
    """One scorecard line: where each trigger stands today, and whether one has fired."""
    rs = rs_of(rows)
    n, cum = len(rs), sum(rs)
    hi_text = "not yet measured"
    if n >= rule.review_at_trades:
        _, hi = bootstrap_ci(rs)
        hi_text = f"CI95 upper bound of E[R] {hi:+.3f}"
    fired = evaluate(rule, rows, today)
    return (f"- Stop rule ({rule.decision}): cumulative {cum:+.2f}R of {rule.cum_r_max_loss:+.1f}R · "
            f"{n} of {rule.review_at_trades} trades to the review ({hi_text}) · stop date {rule.stop_date.isoformat()}"
            + (f" · **FIRED: {fired.kind}, {fired.detail}**" if fired else ""))
