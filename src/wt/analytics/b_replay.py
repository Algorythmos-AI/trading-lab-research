"""Strategy B's rule replayed on a session's recorded bars, beside what the paper runner journaled that day.

Three readings of one session, kept apart:
    forward   the nightly forward test's: the whole day's consolidated bars and the forward test's own sigma
    replay    the same bars walked one closed bar at a time, as the runner reads them (`include_last`), with the
              sigma and prior close the runner journaled when it armed
    journal   what the runner itself journaled as its first would-be signal, on the bars it had live

`replay` against `journal` asks whether the live bars and the recorded bars led the rule to the same bar.
`forward` against `replay` asks whether the two sigmas did. Statuses and bar indexes only: no result is computed.
This is a record. It does not feed G2: the gate's agreement measure changes only by a decision record.
"""
from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any

from wt.signals import setups

STATUSES = ("same", "different", "neither", "only_first", "only_second", "unknown")


def _num(v: Any) -> float | None:
    return float(v) if isinstance(v, int | float) and not isinstance(v, bool) else None


def reading(sig: Any) -> dict[str, Any] | None:
    """A signal as (bar index, trigger, stop), or None."""
    return None if sig is None else {"bar": int(sig.bar_index), "trigger": float(sig.trigger), "stop": float(sig.stop)}


def walk(bars: Any, sigma: float, prev_close: float) -> dict[str, Any] | None:
    """The first signal a reader of closed bars meets, asking at every half-hour mark as the runner does."""
    for n in range(30, min(len(bars), 390) + 1, 30):
        sig = setups.b_intraday_momentum(bars.iloc[:n].reset_index(drop=True), sigma, prev_close, include_last=True)
        if sig is not None:
            return reading(sig)       # always the newest bar: an earlier mark would have been met at its own n
    return None


def journal_reading(rows: Iterable[Mapping[str, Any]], day: str) -> dict[str, Any] | None:
    """What the runner journaled for `day`: the inputs it armed with and its first would-be signal. None when it
    never armed that day; `signal` is None when it saw none or its summary is missing (`summarised` says which)."""
    armed: Mapping[str, Any] | None = None
    summary: Mapping[str, Any] | None = None
    in_day = False
    for r in rows:
        ev = r.get("event")
        if ev == "armed":
            in_day = str(r.get("day")) == day
            if in_day:
                armed, summary = r, None
        elif in_day and ev == "decision_summary":
            summary = r
        elif in_day and ev == "session_end":
            in_day = False
    if armed is None:
        return None
    first = summary.get("first") if summary else None
    sig = None
    if isinstance(first, Mapping) and isinstance(first.get("signal_bar"), int):
        sig = {"bar": int(first["signal_bar"]), "trigger": first.get("trigger"), "stop": first.get("stop"),
               "acted": bool(first.get("runner_acts"))}
    return {"sigma": _num(armed.get("sigma")), "prev_close": _num(armed.get("prev_close")),
            "summarised": summary is not None, "inputs": bool(summary.get("inputs")) if summary else None, "signal": sig}


def status(first: Mapping[str, Any] | None, second: Mapping[str, Any] | None, known: bool = True) -> str:
    """How two readings compare, by signal bar alone."""
    if not known:
        return "unknown"
    if first is None and second is None:
        return "neither"
    if first is None:
        return "only_second"
    if second is None:
        return "only_first"
    return "same" if first["bar"] == second["bar"] else "different"


def record(day: str, bars: Any, forward_sig: Any, journal: Mapping[str, Any] | None) -> dict[str, Any]:
    """One session's three readings and how they compare."""
    fwd = reading(forward_sig)
    can = journal is not None and journal.get("sigma") is not None and journal.get("prev_close") is not None \
        and len(bars) >= 30
    rep = walk(bars, float(journal["sigma"]), float(journal["prev_close"])) if can and journal is not None else None
    told = journal is not None and bool(journal.get("summarised")) and journal.get("inputs") is not False
    return {"session": day, "forward": fwd, "replay": rep, "journal": journal.get("signal") if journal else None,
            "armed": journal is not None,
            "forward_vs_replay": status(fwd, rep, can),
            "replay_vs_journal": status(rep, journal.get("signal") if journal else None, can and told)}


def tally(records: Iterable[Mapping[str, Any]], key: str) -> dict[str, int]:
    """Sessions per status for one comparison."""
    out = dict.fromkeys(STATUSES, 0)
    for r in records:
        s = r.get(key)
        if s in out:
            out[str(s)] += 1
    return out
