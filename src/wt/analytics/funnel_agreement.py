"""How far the dry run's funnel and the forward test's funnel agree, in counts (DEC-0023, section 2).

The two records answer different questions and are never merged: the dry run ("as seen") describes each stage's
minute on the data it had then, the forward test ("of record") describes the after-close pool the trials read.
What may be reported is how many names they have in common at Tier 1 and at Tier 2, whether the first pick is
the same, and how many signals both saw. Names go in; only counts come out, so nothing here can publish a symbol.

A signal here is a (name, trial) pair on which a registered rule fired at least once that session, for the four
Set F trials whose windows close by 11:00, inside the bars the dry run reads. It says nothing about what happened
after the rule fired: the spread must, the fill, admission and the outcome are not part of it.

Each side is the list of rows wt.scanner.explain produces: a symbol and the last funnel step it reached.
"""
from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any

TIER1 = frozenset({"tier1", "chart_ok", "tier2", "primary"})      # steps at or past Tier 1
TIER2 = frozenset({"tier2", "primary"})
KEYS = ("tier1_seen", "tier1_record", "tier1_both", "tier2_seen", "tier2_record", "tier2_both")


def tiers(rows: Iterable[Mapping[str, Any]]) -> tuple[set[str], set[str], str | None]:
    """(Tier 1 names, Tier 2 names, the first pick or None) from explain rows."""
    t1: set[str] = set()
    t2: set[str] = set()
    first: str | None = None
    for r in rows:
        sym, step = str(r.get("symbol")), r.get("reached")
        if step in TIER1:
            t1.add(sym)
        if step in TIER2:
            t2.add(sym)
        if step == "primary":
            first = sym
    return t1, t2, first


def compare(seen: Iterable[Mapping[str, Any]], record: Iterable[Mapping[str, Any]]) -> dict[str, Any]:
    """One session's agreement. `first_pick`: "same", "different", "neither" (no pick on either side) or
    "one_side" (a pick on one side only)."""
    s1, s2, sp = tiers(seen)
    r1, r2, rp = tiers(record)
    pick = "neither" if sp is None and rp is None else "one_side" if sp is None or rp is None else \
        "same" if sp == rp else "different"
    return {"tier1_seen": len(s1), "tier1_record": len(r1), "tier1_both": len(s1 & r1),
            "tier2_seen": len(s2), "tier2_record": len(r2), "tier2_both": len(s2 & r2), "first_pick": pick}


SIGNAL_TRIALS = ("GG-1", "GG-2", "GG-3", "GG-4")
SIGNAL_KEYS = ("signals_seen", "signals_record", "signals_both")


def seen_pairs(signals: Iterable[Mapping[str, Any]]) -> set[tuple[str, str]]:
    """(name, trial) pairs from the dry run's signals stage. A row that carries an error is not a signal."""
    return {(str(r.get("symbol")), str(r.get("trial"))) for r in signals
            if r.get("trial") in SIGNAL_TRIALS and "error" not in r}


def record_pairs(by_trial: Mapping[str, Iterable[str]]) -> set[tuple[str, str]]:
    """(name, trial) pairs from the forward test's signal names, {trial: [names]}."""
    return {(str(s), t) for t in SIGNAL_TRIALS for s in by_trial.get(t) or ()}


def compare_signals(seen: set[tuple[str, str]], record: set[tuple[str, str]]) -> dict[str, int]:
    return {"signals_seen": len(seen), "signals_record": len(record), "signals_both": len(seen & record)}


def total_signals(days: Iterable[Mapping[str, int]]) -> dict[str, int]:
    days = list(days)
    return {"sessions": len(days), **{k: sum(int(d[k]) for d in days) for k in SIGNAL_KEYS}}


def total(days: Iterable[Mapping[str, Any]]) -> dict[str, Any]:
    """The sessions' counts added up, and the first picks tallied."""
    days = list(days)
    out: dict[str, Any] = {"sessions": len(days), **{k: sum(int(d[k]) for d in days) for k in KEYS}}
    out["first_pick"] = {k: sum(1 for d in days if d["first_pick"] == k)
                         for k in ("same", "different", "one_side", "neither")}
    return out
