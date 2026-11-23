"""Gap Hunter's paper R beside a cost haircut fixed before its first trade (DEC-0074). A report: it gates nothing.

Read from the stock desk's own journal (data/live/smallcap_journal.jsonl), as `wt.risk.execution_stops` reads it;
nothing is written to it. A trade is a `trade_closed` row with origin "entry" and trial HYP-0071, once per
`trade_id`. For each:

  c        max(US$0.01, half the spread) from the `nbbo` [bid, ask] on the trade's first `entry_filled` row; US$0.025
           when that row or its NBBO is missing, crossed (ask under bid) or has a side at or under zero. A locked
           quote (ask equal to bid) is not crossed: its half spread is zero and c is US$0.01.
  H1       c per share bought, c per share sold by a limit or market order, 2c per share sold by the stop order.
           Shares sold by the stop are `qty - partial_qty` when the row carries `stop_fill` (DEC-0073), else none.
  H2       2.0 x H1.
  R        the journaled R; -1 when it is None or the exit was estimated, as the desk counts it
           (`wt.live.runner_s` book()).
  H R      R - H / (qty x (entry - stop)), with the stop the trade entered with.

A trade with no positive risk (entry at or under its stop, or no entry, stop or quantity) cannot be charged in R: it
is left out of every mean and counted by reason in `Summary.skipped`. Means carry a 95% bootstrap interval with
sessions resampled (EXP-0053's primary measure, `wt.backtest.stats.bootstrap_ci`, block "day") once there are two
trades on two sessions. Nothing here returns a symbol; `trade_id` embeds one, so a report must not print it.
"""
from __future__ import annotations

import math
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from wt.backtest.stats import bootstrap_ci

# DEC-0074 "The haircut" (set there): change these only by a new decision record.
TRIAL = "HYP-0071"            # Gap Hunter's trial (wt.live.setups_live.GAP_TRIAL; a test holds the two together)
MIN_UNIT_USD = 0.01           # the floor on c: MIN_SLIP in wt.live.setups_live, slippage per_share_min_usd
UNKNOWN_UNIT_USD = 0.025      # c when the entry NBBO is unknown: half the desk's US$0.05 spread cap
STOP_STRESS = 2.0             # shares sold by the stop pay 2c: M-FILL stop_slip_stress (wt.research.method)
SEVERE_MULTIPLIER = 2.0       # H2 = H1 x this: slippage.stress_multipliers
SEED = 74                     # one seed for the three intervals, so they are drawn from the same resamples
SKIP_REASONS = ("no_risk",)


@dataclass(frozen=True)
class Haircut:
    trade_id: str
    day: str
    r: float               # paper R as the desk counts it (-1 for None or an estimated exit)
    c: float               # US$ a share
    h1_usd: float
    h2_usd: float
    h1_r: float
    h2_r: float
    realised_usd: float    # r x qty x (entry - stop): the paper US$ of the counted R
    nbbo_known: bool


@dataclass(frozen=True)
class Mean:
    n: int
    mean: float | None
    ci95: tuple[float, float] | None     # None below two trades or two sessions


@dataclass(frozen=True)
class Summary:
    n: int
    sessions: int
    paper: Mean
    h1: Mean
    h2: Mean
    h1_usd: float
    h2_usd: float
    realised_usd: float
    nbbo_unknown: int
    skipped: dict[str, int] = field(default_factory=dict)


def _num(x: Any) -> float | None:
    if isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(float(x)):
        return float(x)
    return None


def unit(nbbo: Any) -> float | None:
    """c from an [bid, ask] pair, or None when the pair is missing, malformed, crossed or has a side at or under 0."""
    if not isinstance(nbbo, (list, tuple)) or len(nbbo) != 2:
        return None
    bid, ask = _num(nbbo[0]), _num(nbbo[1])
    if bid is None or ask is None or bid <= 0 or ask <= 0 or ask < bid:
        return None
    return max(MIN_UNIT_USD, (ask - bid) / 2)


def _closes(rows: Iterable[Mapping[str, Any]]) -> list[Mapping[str, Any]]:
    """Gap Hunter's own closed trades, once per trade id, in journal order."""
    seen: set[str] = set()
    out: list[Mapping[str, Any]] = []
    for r in rows:
        if r.get("event") != "trade_closed" or r.get("origin") != "entry" or r.get("trial") != TRIAL:
            continue
        tid = str(r.get("trade_id") or f"{r.get('day')}-{r.get('ts')}")
        if tid in seen:
            continue
        seen.add(tid)
        out.append(r)
    return out


def haircuts(rows: Iterable[Mapping[str, Any]]) -> tuple[list[Haircut], dict[str, int]]:
    """(one Haircut per Gap Hunter closed trade, how many were skipped and why)."""
    rows = list(rows)
    nbbo: dict[str, Any] = {}
    for r in rows:
        if r.get("event") == "entry_filled" and r.get("trade_id") is not None:
            nbbo.setdefault(str(r["trade_id"]), r.get("nbbo"))          # the first fill row of the trade
    out: list[Haircut] = []
    skipped = dict.fromkeys(SKIP_REASONS, 0)
    for r in _closes(rows):
        tid = str(r.get("trade_id") or "")
        entry, stop, qty = _num(r.get("entry")), _num(r.get("stop")), _num(r.get("qty"))
        if entry is None or stop is None or qty is None or qty <= 0 or entry - stop <= 0:
            skipped["no_risk"] += 1
            continue
        paper = _num(r.get("R"))
        x = -1.0 if paper is None or r.get("exit_price_estimated") else paper
        known = unit(nbbo.get(tid))
        c = known if known is not None else UNKNOWN_UNIT_USD
        by_stop = 0.0
        if r.get("stop_fill") is not None:
            by_stop = min(qty, max(0.0, qty - (_num(r.get("partial_qty")) or 0.0)))
        h1 = c * qty + c * (qty - by_stop) + STOP_STRESS * c * by_stop
        h2 = SEVERE_MULTIPLIER * h1
        risk_usd = qty * (entry - stop)
        out.append(Haircut(trade_id=tid, day=str(r.get("day") or "")[:10], r=x, c=c, h1_usd=h1, h2_usd=h2,
                           h1_r=x - h1 / risk_usd, h2_r=x - h2 / risk_usd, realised_usd=x * risk_usd,
                           nbbo_known=known is not None))
    return out, skipped


def mean_ci(xs: Sequence[float], days: Sequence[str]) -> Mean:
    """The mean, with a 95% bootstrap interval resampling sessions once there are two trades on two sessions."""
    if not xs:
        return Mean(0, None, None)
    a = np.asarray(xs, dtype=float)
    ci = None
    if len(a) >= 2 and len(set(days)) >= 2:
        lo, hi = bootstrap_ci(a, seed=SEED, block="day", days=list(days))
        ci = (float(lo), float(hi))
    return Mean(len(a), float(a.mean()), ci)


def summary(rows: Iterable[Mapping[str, Any]]) -> Summary:
    hs, skipped = haircuts(rows)
    days = [h.day for h in hs]
    return Summary(n=len(hs), sessions=len(set(days)),
                   paper=mean_ci([h.r for h in hs], days), h1=mean_ci([h.h1_r for h in hs], days),
                   h2=mean_ci([h.h2_r for h in hs], days),
                   h1_usd=sum(h.h1_usd for h in hs), h2_usd=sum(h.h2_usd for h in hs),
                   realised_usd=sum(h.realised_usd for h in hs),
                   nbbo_unknown=sum(1 for h in hs if not h.nbbo_known), skipped=skipped)


def _mean_text(m: Mean) -> str:
    if m.mean is None:
        return "—"
    return f"{m.mean:+.2f}R" + (f" [{m.ci95[0]:+.2f}, {m.ci95[1]:+.2f}]" if m.ci95 else "")


def lines(s: Summary) -> list[str]:
    """The scorecard's lines: counts, R and US$ totals only, never a symbol, a trade id or a setup name."""
    head = f"- Gap Hunter ({TRIAL}) paper R and its cost haircut (DEC-0074, reported, gating nothing): "
    skipped = sum(s.skipped.values())
    tail = f" · left out, no positive risk to charge in R: {skipped}" if skipped else ""
    if not s.n:
        return [f"{head}no closed trade yet{tail}"]
    return [f"{head}trades closed **{s.n}** on {s.sessions} session(s) · mean paper R {_mean_text(s.paper)} · "
            f"H1 R {_mean_text(s.h1)} · H2 R {_mean_text(s.h2)} (95% bootstrap, sessions resampled, from 2 sessions)",
            f"- Haircut total: H1 US${s.h1_usd:.2f} · H2 US${s.h2_usd:.2f}, against realised paper "
            f"US${s.realised_usd:+.2f} · entry NBBO unknown (c = US${UNKNOWN_UNIT_USD:.3f}): {s.nbbo_unknown}{tail}"]
