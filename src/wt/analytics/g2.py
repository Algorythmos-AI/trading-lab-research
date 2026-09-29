"""G2 paper evidence: one definition for the collector, the weekly scorecard and the dashboard.

G2 (config/dashboard.yaml): >= 50 trades, >= 30 sessions, >= 90% replay match, 20 incident-free sessions.

A session is one ET trading date of the paper-B journal (data/live/journal.jsonl). It counts ("clean") only if:
  * the runner armed and reached session_end (it completed);
  * KILL was off at arm and never switched on during the session (`kill_state` rows);
  * nothing refused (refuse_to_arm; since the phase-2 runner a refusal means an exits-only session);
  * no incident: END_OF_DAY_NOT_FLAT, short_position, close_unknown, a reconcile action flagging a SHORT,
    UNKNOWN or UNPROTECTED position, or 3+ loop errors.
Trades are strategy B's own closed plans, counted once per trade_id; adopted orphans never count.
Agreement stays day-level until the replay harness lands: a clean session agrees when paper B and forward B
both traded, or both did not. The dashboard labels it provisional.
"""
from __future__ import annotations

import datetime as dt
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any

from wt.core.clock import ET

G2_MIN_TRADES, G2_MIN_SESSIONS, G2_MIN_INCIDENT_FREE, G2_MIN_MATCH = 50, 30, 20, 0.90
INCIDENT_EVENTS = ("END_OF_DAY_NOT_FLAT", "short_position", "close_unknown")
RECONCILE_FLAGS = ("SHORT", "UNKNOWN", "UNPROTECTED")
LOOP_ERRORS_INCIDENT = 3


def et_date(row: dict[str, Any]) -> str | None:
    try:
        return dt.datetime.fromisoformat(str(row["ts"])).astimezone(ET).date().isoformat()
    except (KeyError, TypeError, ValueError):
        return None


@dataclass
class Session:
    date: str
    armed: bool = False
    completed: bool = False
    kill: bool = False
    refused: bool = False
    loop_errors: int = 0
    incidents: list[str] = field(default_factory=list)
    trades: list[str] = field(default_factory=list)

    @property
    def clean(self) -> bool:
        return (self.armed and self.completed and not self.kill and not self.refused and not self.incidents
                and self.loop_errors < LOOP_ERRORS_INCIDENT)


def sessions(rows: Iterable[dict[str, Any]]) -> dict[str, Session]:
    out: dict[str, Session] = {}
    for r in rows:
        ev = str(r.get("event", ""))
        day = str(r["day"]) if ev == "armed" and r.get("day") else et_date(r)
        if day is None:
            continue
        s = out.setdefault(day, Session(day))
        if ev == "armed":
            s.armed = True
            s.kill = s.kill or bool(r.get("kill"))
        elif ev == "kill_state" and r.get("on"):
            s.kill = True
        elif ev == "session_end":
            s.completed = True
        elif ev == "refuse_to_arm":
            s.refused = True
        elif ev == "loop_error":
            s.loop_errors += 1
        elif ev in INCIDENT_EVENTS:
            s.incidents.append(ev)
        elif ev.startswith("reconcile"):
            flagged = [a for a in r.get("actions") or [] if any(k in str(a) for k in RECONCILE_FLAGS)]
            if flagged:
                s.incidents.append("reconcile_flag")
        elif ev == "trade_closed" and r.get("trade_id") and r.get("origin", "entry") == "entry":
            if r["trade_id"] not in s.trades:
                s.trades.append(str(r["trade_id"]))
    return out


def trades(rows: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """B's closed trades, once per trade_id (a pre-phase-2 restart could journal a close twice)."""
    seen: set[str] = set()
    out = []
    for r in rows:
        if r.get("event") != "trade_closed" or r.get("origin", "entry") != "entry":
            continue
        tid = str(r.get("trade_id") or f"{r.get('day')}-{r.get('ts')}")
        if tid in seen:
            continue
        seen.add(tid)
        out.append(r)
    return out


def summary(rows: list[dict[str, Any]], forward_sessions: set[str] | None = None,
            forward_b_days: set[str] | None = None) -> dict[str, Any]:
    """G2 progress. With the forward ledger's session dates and the dates forward B traded, also the day-level
    agreement over clean paper sessions the forward test also ran."""
    ss = sorted(sessions(rows).values(), key=lambda s: s.date)
    clean = [s for s in ss if s.clean]
    streak = 0
    for s in reversed([s for s in ss if s.armed]):
        if not s.clean:
            break
        streak += 1
    out: dict[str, Any] = {
        "trades": len(trades(rows)), "trades_needed": G2_MIN_TRADES,
        "sessions": len(clean), "sessions_needed": G2_MIN_SESSIONS,
        "armed_sessions": sum(1 for s in ss if s.armed),
        "incident_free_streak": streak, "incident_free_needed": G2_MIN_INCIDENT_FREE,
        "agreement_level": "day", "agreement_days": None, "agreement_agree": None,
    }
    if forward_sessions is not None and forward_b_days is not None:
        both = [s for s in clean if s.date in forward_sessions]
        out["agreement_days"] = len(both)
        out["agreement_agree"] = sum(1 for s in both if bool(s.trades) == (s.date in forward_b_days))
    return out
