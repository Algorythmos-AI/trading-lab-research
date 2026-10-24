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

import contextlib
import json
from collections.abc import Collection, Iterable, Mapping
from pathlib import Path
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


AGREE = ("same", "neither")           # the rule on the recorded bars and the runner reached the same bar, or none


def load_records(folder: Path) -> list[dict[str, Any]]:
    """Every session record under var/forward/replay, in date order; unreadable files are left out."""
    out: list[dict[str, Any]] = []
    if not folder.is_dir():
        return out
    for f in sorted(folder.glob("*.json")):
        with contextlib.suppress(OSError, ValueError):
            d = json.loads(f.read_text())
            if isinstance(d, dict) and d.get("session"):
                out.append(d)
    return out


def agreement(records: Iterable[Mapping[str, Any]], sessions: Collection[str] | None = None) -> dict[str, Any]:
    """G2's agreement at the bar (DEC-0037, part 1): over the clean sessions with a readable record, how many the
    frozen rule on the recorded bars and the runner agreed on (`replay_vs_journal` same or neither). Beside it,
    the harness diagnostic (`forward_vs_replay`): the sigma and feed difference, never pooled. Sessions whose
    reading is unknown are counted, not judged."""
    recs = [r for r in records if sessions is None or str(r.get("session")) in sessions]
    judged = [r for r in recs if r.get("replay_vs_journal") in STATUSES and r.get("replay_vs_journal") != "unknown"]
    harness = [r for r in recs if r.get("forward_vs_replay") in STATUSES and r.get("forward_vs_replay") != "unknown"]
    # a clean session with no record at all (a missed forward run) is unknown too, not silently absent
    expected = len(set(sessions)) if sessions is not None else len(recs)
    return {"agreement_level": "bar",
            "agreement_days": len(judged),
            "agreement_agree": sum(1 for r in judged if r.get("replay_vs_journal") in AGREE),
            "agreement_unknown": max(expected, len(recs)) - len(judged),
            "harness_days": len(harness),
            "harness_agree": sum(1 for r in harness if r.get("forward_vs_replay") in AGREE)}
