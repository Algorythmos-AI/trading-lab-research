"""The options clone's trade-quality scorecard (DEC-0030): how well each entry was taken, and whether the day's
silence was a quiet day or a gap.

Pure: callers pass the session's journal rows, decision lines, plan files and clock. Figures and facts only: nothing
here grades a trade against a new threshold, decides one, or feeds a verdict (`wt.options.review` does the figures).

A trade's line: whether its signal bar was final (the feed did not change that bar's close after the clone judged it,
`bar_revised`), the quote it was priced from (age, spread as a % of mid), the fill against that quote's ask and mid,
the contract's delta and whether it was modelled here, the option feed, the minutes from the signal bar's close to
the fill, the exit and the return on premium (and in R, against the premium stop). A field the journal did not log
for that trade (an older row) is None and named under `missing`.

The day's line: entries (from the decision lines, or the session's filled plans when a line was lost to a restart),
refusals by reason, the journal's counts of `bar_revised` and `feed_unfit`, decision-log faults, the names' source,
and per name every 2-minute bar of the entry window that has no decision line. The day is `traded`, `quiet` (no entry
and every bar has a line), `gaps` (a bar has none) or `no-session` (the market was shut). A gap is a bar the clone did
not judge: the runner was down or the tape stalled, or, rarely, the feed sent no minute at all in those two minutes (a
thin name on IEX), which the decision log cannot tell apart.
"""
from __future__ import annotations

import datetime as dt
from collections.abc import Iterable, Mapping, Sequence
from typing import Any

from wt.options.regime import NEW_YORK

TRADE_FIELDS = ("bar_final", "quote_age_s", "spread_pct", "fill_vs_ask_pct", "fill_vs_mid_pct", "delta", "feed",
                "signal_to_fill_min", "exit_reason", "rop", "r")


def _f(v: Any) -> float | None:
    if isinstance(v, bool) or v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _at(v: Any) -> dt.datetime | None:
    try:
        t = dt.datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    except ValueError:
        return None
    return t.astimezone(NEW_YORK) if t.tzinfo is not None else None


def _hhmm(t: dt.datetime) -> str:
    return t.astimezone(NEW_YORK).strftime("%H:%M")


def expected_bars(first_entry: dt.datetime, last_entry: dt.datetime, minutes: int) -> list[str]:
    """The ends of the 2-minute bars the clone judges inside its entry window: from `first_entry` to the bar before
    `last_entry`. The bar that ends at `last_entry` is left out: only a poll at that very second would judge it."""
    out, t = [], first_entry
    while t < last_entry:
        out.append(_hhmm(t))
        t += dt.timedelta(minutes=minutes)
    return out


def _feed(journal: Sequence[Mapping[str, Any]]) -> str | None:
    armed = [r for r in journal if r.get("event") == "armed"]
    return str(armed[-1]["feed"]) if armed and armed[-1].get("feed") else None


def _entered_signal(decisions: Sequence[Mapping[str, Any]], root: str, bar: str) -> Mapping[str, Any] | None:
    for d in decisions:
        if d.get("root") == root and d.get("bar") == bar and d.get("action") in ("entered", "entry-refused"):
            sigs = [s for s in d.get("signals") or [] if not s.get("already")]
            return sigs[-1] if sigs else None           # the clone stops at the signal it sent
    return None


def trade_line(plan: Mapping[str, Any], journal: Sequence[Mapping[str, Any]],
               decisions: Sequence[Mapping[str, Any]], premium_stop_pct: float) -> dict[str, Any]:
    """One entry's quality line. `plan` is the plan file (wt.oms.options.OptionPlan as JSON)."""
    tid, root, bar = str(plan.get("trade_id")), str(plan.get("root")), str(plan.get("signal_bar"))
    mine = [r for r in journal if r.get("trade_id") == tid]
    sent = next((r for r in mine if r.get("event") == "entry_sent"), {})
    filled = next((r for r in mine if r.get("event") == "filled"), {})
    closed = next((r for r in mine if r.get("event") == "trade_closed"), {})
    sig = _entered_signal(decisions, root, bar) or {}
    contract = sig.get("contract") if isinstance(sig.get("contract"), Mapping) else {}
    fill = _f(plan.get("fill")) if plan.get("fill") is not None else _f(filled.get("fill"))
    ask = _f(sent.get("quoted_ask")) if "quoted_ask" in sent else _f(plan.get("quoted_ask"))
    bid = _f(sent.get("quoted_bid"))
    mid = (ask + bid) / 2 if ask is not None and bid is not None and ask >= bid > 0 else None
    revised = any(r.get("event") == "bar_revised" and r.get("root") == root and r.get("bar") == bar for r in journal)
    filled_at = _at(plan.get("filled_at"))
    to_fill = None
    try:
        bar_t = dt.datetime.strptime(bar, "%H:%M").time()
    except ValueError:
        bar_t = None
    if filled_at is not None and bar_t is not None:
        bar_end = dt.datetime.combine(filled_at.date(), bar_t, NEW_YORK)
        to_fill = round((filled_at - bar_end).total_seconds() / 60, 2)
    rop = _f(closed.get("rop"))
    out: dict[str, Any] = {
        "trade_id": tid, "root": root, "setup": plan.get("setup"), "side": plan.get("side"), "signal_bar": bar,
        "state": plan.get("state"),
        "bar_final": not revised,
        "quote_age_s": _f(sent.get("quote_age_s")) if "quote_age_s" in sent else _f(plan.get("quote_age_s")),
        "spread_pct": round((ask - bid) / mid * 100, 2) if mid else None,
        "fill_vs_ask_pct": round((fill - ask) / ask * 100, 2) if fill is not None and ask else None,
        "fill_vs_mid_pct": round((fill - mid) / mid * 100, 2) if fill is not None and mid else None,
        "delta": _f(contract.get("delta")), "modelled": contract.get("modelled"),
        "feed": _feed(journal),
        "signal_to_fill_min": to_fill,
        "exit_reason": closed.get("exit_reason") or plan.get("exit_reason") or None,
        "rop": rop,
        "r": round(rop / (premium_stop_pct / 100), 3) if rop is not None and premium_stop_pct > 0 else None,
    }
    unfilled = fill is None
    out["missing"] = [k for k in TRADE_FIELDS if out[k] is None
                      and not (unfilled and k in ("fill_vs_ask_pct", "fill_vs_mid_pct", "signal_to_fill_min"))
                      and not (not closed and k in ("exit_reason", "rop", "r"))]
    return out


def _count(journal: Iterable[Mapping[str, Any]], event: str) -> int:
    return sum(1 for r in journal if r.get("event") == event)


def day_health(journal: Sequence[Mapping[str, Any]], decisions: Sequence[Mapping[str, Any]],
               bars: Sequence[str], filled: int = 0, market_open: bool = True) -> dict[str, Any]:
    """The day's line. `journal` is the session's journal rows, `bars` the expected bar ends (`expected_bars`),
    `filled` the session's plans with a fill."""
    names_rows = [r for r in journal if r.get("event") == "names"]
    names = sorted({str(n) for r in names_rows[-1:] for n in r.get("names") or []}
                   | {str(d.get("root")) for d in decisions if d.get("root")})
    seen: dict[str, set[str]] = {}
    refused: dict[str, int] = {}
    entries = log_faults = 0
    for d in decisions:
        seen.setdefault(str(d.get("root")), set()).add(str(d.get("bar")))
        entries += d.get("action") == "entered"
        if not isinstance(d.get("signals") or [], list):
            continue
        for s in d.get("signals") or []:
            if s.get("already"):
                continue
            log_faults += "log_fault" in s
            why = s.get("reason")
            if why:
                refused[str(why)] = refused.get(str(why), 0) + 1
    entries = max(entries, filled)
    gaps = {n: [b for b in bars if b not in seen.get(n, set())] for n in names} if market_open else {}
    gaps = {n: g for n, g in gaps.items() if g}
    return {
        "verdict": "traded" if entries else "no-session" if not market_open else
        ("gaps" if gaps or not names else "quiet"),
        "entries": entries, "refused_for": dict(sorted(refused.items())),
        "bar_revised": _count(journal, "bar_revised"), "feed_unfit": _count(journal, "feed_unfit"), "log_fault": log_faults,
        "names_source": str(names_rows[-1].get("source")) if names_rows else None,
        "names": names, "bars_expected": len(bars),
        "bars_missing": {n: len(g) for n, g in gaps.items()},
        "first_missing": {n: g[:5] for n, g in gaps.items()},
    }


def scorecard(day: str, journal: Sequence[Mapping[str, Any]], decisions: Sequence[Mapping[str, Any]],
              plans: Sequence[Mapping[str, Any]], bars: Sequence[str], premium_stop_pct: float,
              market_open: bool = True) -> dict[str, Any]:
    """The session's scorecard: the day's line and a line per entry the clone sent that session."""
    plans = [p for p in plans if isinstance(p, Mapping)]
    mine = [p for p in plans if p.get("date") == day and p.get("state") not in ("rejected",)
            and (p.get("fill") is not None or p.get("state") in ("cancelled", "unresolved"))]
    filled = sum(1 for p in mine if p.get("fill") is not None)
    return {"day": day_health(journal, decisions, bars, filled, market_open),
            "trades": [trade_line(p, journal, decisions, premium_stop_pct)
                       for p in sorted(mine, key=lambda p: (len(str(p.get("trade_id"))), str(p.get("trade_id"))))]}
