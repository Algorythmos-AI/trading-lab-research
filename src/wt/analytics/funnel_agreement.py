"""How far the dry run's funnel and the forward test's funnel agree, in counts (DEC-0023, section 2).

The two records answer different questions and are never merged: the dry run ("as seen") describes each stage's
minute on the data it had then, the forward test ("of record") describes the after-close pool the trials read.
What may be reported is how many names they have in common at Tier 1 and at Tier 2, and whether the first pick is
the same. Names go in; only counts come out, so nothing here can publish a symbol.

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


def total(days: Iterable[Mapping[str, Any]]) -> dict[str, Any]:
    """The sessions' counts added up, and the first picks tallied."""
    days = list(days)
    out: dict[str, Any] = {"sessions": len(days), **{k: sum(int(d[k]) for d in days) for k in KEYS}}
    out["first_pick"] = {k: sum(1 for d in days if d["first_pick"] == k)
                         for k in ("same", "different", "one_side", "neither")}
    return out
