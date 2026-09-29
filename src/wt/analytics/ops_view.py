"""Operations views for the dashboard (plan v4.2, Wave 1a): job SLA matrix, blotter, daily digest, audit trail.

Everything here is derived from records the system already keeps (runs.jsonl, the paper journal, deploy records,
the virtual account, the alert history and the audit log), so a view can never disagree with its source.
"""
from __future__ import annotations

import datetime as dt
import json
from collections.abc import Iterable, Mapping, Sequence
from pathlib import Path
from typing import Any

from wt.core.clock import ET

SLA_JOBS = ("routine", "paper-b", "forward", "weekly", "dashboard")
SESSION_JOBS = ("routine", "paper-b", "forward")


def _et_date(ts: Any) -> str | None:
    try:
        t = dt.datetime.fromisoformat(str(ts))
    except ValueError:
        return None
    if t.tzinfo is None:
        t = t.replace(tzinfo=dt.UTC)
    return t.astimezone(ET).date().isoformat()


def _expected(job: str, day: dt.date, sessions: Mapping[dt.date, Any]) -> bool:
    if job in SESSION_JOBS:
        return day in sessions
    if job == "weekly":
        return day.weekday() == 4
    return True                                             # the dashboard publishes around the clock


def sla(runs: Sequence[dict[str, Any]], today: dt.date, sessions: Mapping[dt.date, Any], days: int = 14) \
        -> dict[str, Any]:
    """One cell per job and ET day: ok · refused · failed · partial (dashboard: some failed) · missed (expected, no
    run) · none (not expected) · n/a (before the job's first recorded run, or today while it may still run)."""
    by: dict[tuple[str, str], list[str]] = {}
    first: dict[str, str] = {}
    for r in runs:
        job, d = str(r.get("job", "")), _et_date(r.get("started"))
        if job not in SLA_JOBS or d is None:
            continue
        by.setdefault((job, d), []).append(str(r.get("status", "")))
        first[job] = min(first.get(job, d), d)
    dates = [today - dt.timedelta(days=i) for i in range(days - 1, -1, -1)]
    cells, summary = [], []
    for job in SLA_JOBS:
        tally = {"expected": 0, "ok": 0, "refused": 0, "failed": 0, "missed": 0}
        for day in dates:
            k = day.isoformat()
            sts = by.get((job, k), [])
            exp = _expected(job, day, sessions)
            if sts:
                bad = [s for s in sts if s not in ("ok", "refused")]
                if job == "dashboard":
                    status = "failed" if len(bad) == len(sts) else ("partial" if bad else "ok")
                else:
                    last = sts[-1]
                    status = last if last in ("ok", "refused") else "failed"
            elif job not in first or k < first[job] or day == today:
                status = "n/a"
            else:
                status = "missed" if exp else "none"
            if exp and status != "n/a":
                tally["expected"] += 1
                tally[{"partial": "ok", "none": "missed"}.get(status, status)] += 1
            cells.append({"job": job, "date": k, "status": status, "runs": len(sts)})
        rate = round(tally["ok"] / tally["expected"] * 100, 1) if tally["expected"] else None
        summary.append({"job": job, **tally, "ok_pct": rate})
    return {"days": [d.isoformat() for d in dates], "cells": cells, "summary": summary}


def blotter(journal_rows: Iterable[dict[str, Any]], keep: int = 100) -> list[dict[str, Any]]:
    """Closed trades, newest last. Prices and R only; the virtual account's money stays out."""
    out = []
    for r in journal_rows:
        if r.get("event") != "trade_closed":
            continue
        rr = r.get("R")
        out.append({"date": str(r.get("day") or str(r.get("ts", ""))[:10]), "symbol": r.get("symbol"),
                    "qty": r.get("qty"), "entry": r.get("entry"), "exit": r.get("exit"), "stop": r.get("stop"),
                    "r": round(float(rr), 4) if isinstance(rr, int | float) else None, "reason": r.get("reason"),
                    "origin": r.get("origin") or "entry", "estimated": bool(r.get("exit_price_estimated")),
                    "booked": r.get("booked")})
    return out[-keep:]


DIGEST_KEYS = ("equity_pct", "cum_r", "trades", "firing", "kill", "head", "preflight_failed", "g2_trades")


def digest_metrics(snap: Mapping[str, Any]) -> dict[str, Any]:
    ops = snap.get("ops") or {}
    paper = ops.get("paper") or {}
    va = paper.get("virtual") or {}
    eq, start = va.get("equity"), va.get("start")
    return {
        "equity_pct": round((eq / start - 1) * 100, 2) if isinstance(eq, int | float) and start else None,
        "cum_r": paper.get("total_r"), "trades": paper.get("trades"),
        "firing": len((snap.get("alerts") or {}).get("firing") or []),
        "kill": (snap.get("kill") or {}).get("on"),
        "head": ((ops.get("deployed") or {}).get("head") or "")[:12] or None,
        "preflight_failed": sum(1 for c in snap.get("preflight") or [] if not c.get("ok")),
        "g2_trades": (paper.get("g2") or {}).get("trades"),
    }


LABELS = {"equity_pct": "Virtual equity vs start (%)", "cum_r": "Cumulative R", "trades": "Closed trades",
          "firing": "Alerts firing", "kill": "KILL switch", "head": "Deployed commit",
          "preflight_failed": "Preflight checks failing", "g2_trades": "G2 trades counted"}


def digest(now_metrics: Mapping[str, Any], daily_dir: Path, today: dt.date) -> dict[str, Any]:
    """Compare with the latest earlier ET day's first snapshot, and store today's first one (write-once)."""
    daily_dir.mkdir(parents=True, exist_ok=True)
    mine = daily_dir / f"{today.isoformat()}.json"
    if not mine.exists():
        mine.write_text(json.dumps(dict(now_metrics), sort_keys=True))
    earlier = sorted(p for p in daily_dir.glob("*.json") if p.stem < today.isoformat())
    for old in earlier[:-30]:                                       # keep a month
        old.unlink(missing_ok=True)
    if not earlier:
        return {"since": None, "items": []}
    try:
        prev = json.loads(earlier[-1].read_text())
    except (OSError, json.JSONDecodeError):
        return {"since": None, "items": []}
    items = []
    for k in DIGEST_KEYS:
        a, b = prev.get(k), now_metrics.get(k)
        items.append({"key": k, "label": LABELS[k], "prev": None if a is None else str(a),
                      "now": None if b is None else str(b), "changed": a != b})
    return {"since": earlier[-1].stem, "items": items}


def audit_trail(*, deploys: Iterable[Path], account: Mapping[str, Any] | None, runs: Sequence[dict[str, Any]],
                alert_history: Sequence[dict[str, Any]], audit_rows: Sequence[dict[str, Any]],
                keep: int = 200) -> list[dict[str, Any]]:
    """One time-ordered trail. Owner free text (KILL reasons, latch-reset reasons) never leaves the host."""
    ev: list[dict[str, Any]] = []
    for p in deploys:
        try:
            d = json.loads(p.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        ok = d.get("smoke_ok")
        try:                                                       # records are named %Y%m%dT%H%M%SZ.json
            at = dt.datetime.strptime(p.stem, "%Y%m%dT%H%M%SZ").replace(tzinfo=dt.UTC).isoformat()
        except ValueError:
            continue
        ev.append({"at": at, "kind": "deploy", "source": "deploy",
                   "detail": f"to {str(d.get('to', ''))[:12]}; smoke {'ok' if ok else 'FAILED' if ok is False else '?'}"})
    for h in (account or {}).get("latch_history") or []:
        if isinstance(h, dict):
            ev.append({"at": str(h.get("at")), "kind": "latch_reset", "source": "virtual_account",
                       "detail": f"by {h.get('reset_by') or 'owner'}"})
    for r in runs:
        if r.get("status") in ("refused", "failed", "killed", "timeout"):
            ev.append({"at": str(r.get("started")), "kind": f"job_{r.get('status')}", "source": "runs",
                       "detail": str(r.get("job"))})
    for a in alert_history:
        ev.append({"at": str(a.get("at")), "kind": f"alert_{a.get('event')}", "source": "alerts",
                   "detail": str(a.get("title") or a.get("key") or "")})
    for a in audit_rows:
        if "kind" in a:
            ev.append({"at": str(a.get("at")), "kind": str(a["kind"]), "source": "audit", "detail": None})
    ev.sort(key=lambda e: e["at"])
    return ev[-keep:]


def alert_log(alert_history: Sequence[dict[str, Any]], keep: int = 100) -> list[dict[str, Any]]:
    return [{"at": a.get("at"), "key": a.get("key"), "event": a.get("event"), "title": a.get("title"),
             "priority": a.get("priority")} for a in alert_history[-keep:]]
