"""The `today` snapshot section: what Paper B did, trade by trade, and what it made or lost.

Built from the paper journal's own rows (entry_placed, entry_filled, trade_closed, decision, armed, session_end)
and the virtual account. Named fields only: the `virtual` object on armed/session_end rows is never copied. Days
are New York session dates, as the runner writes them. Money is the US$600 paper ledger's, in dollars.
"""
from __future__ import annotations

import datetime as dt
from collections.abc import Iterable
from typing import Any

MAX_TRADES = 50
MAX_DAYS = 90
MAX_SIGNALS = 10


def _num(v: Any) -> float | None:
    return float(v) if isinstance(v, int | float) and not isinstance(v, bool) and v == v else None


def _iso(v: Any) -> str | None:
    """A journal or pandas timestamp as ISO 8601 ('2026-10-05 14:30:00+00:00' -> '2026-10-05T14:30:00+00:00')."""
    s = str(v or "").strip()
    return s.replace(" ", "T", 1) if len(s) >= 19 else None


def _day(r: dict[str, Any]) -> str:
    return str(r.get("day") or str(r.get("ts", ""))[:10])


def _minutes(a: str | None, b: str | None) -> float | None:
    try:
        return round((dt.datetime.fromisoformat(str(b)) - dt.datetime.fromisoformat(str(a))).total_seconds() / 60, 1)
    except (TypeError, ValueError):
        return None


def closed_trades(rows: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """Every closed trade once (a replayed close counts once), oldest first, with its entry time and dollars."""
    rows = list(rows)
    filled: dict[str, dict[str, Any]] = {}
    target: dict[str, float | None] = {}
    placed: dict[str, Any] | None = None
    for r in rows:
        if r.get("event") == "entry_placed":
            placed = r
        elif r.get("event") == "entry_filled" and r.get("trade_id"):
            filled[str(r["trade_id"])] = r                           # the order placed just before this fill
            target[str(r["trade_id"])] = _num((placed or {}).get("target"))
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for r in rows:
        if r.get("event") != "trade_closed":
            continue
        tid = str(r.get("trade_id") or "")
        if tid and tid in seen:
            continue
        seen.add(tid)
        entry, exit_, qty, rr = _num(r.get("entry")), _num(r.get("exit")), _num(r.get("qty")), _num(r.get("R"))
        f = filled.get(tid) or {}
        entry_at, exit_at = _iso(f.get("ts")), _iso(r.get("ts"))
        pnl = round((exit_ - entry) * qty, 2) if entry is not None and exit_ is not None and qty is not None else None
        out.append({"session": _day(r), "symbol": r.get("symbol"), "qty": qty, "entry": entry, "entry_at": entry_at,
                    "exit": exit_, "exit_at": exit_at, "stop": _num(r.get("stop")),
                    "target": target.get(tid), "pnl": pnl,
                    "r": round(rr, 4) if rr is not None else None, "reason": r.get("reason"),
                    "held_min": _minutes(entry_at, exit_at), "estimated": bool(r.get("exit_price_estimated")),
                    "origin": r.get("origin") or "entry"})
    return out


def _sum(trades: list[dict[str, Any]], key: str) -> float:
    return round(sum(t[key] for t in trades if t[key] is not None), 4 if key == "r" else 2)


def pnl_summary(trades: list[dict[str, Any]], today: dt.date, account: dict[str, Any] | None) -> dict[str, Any]:
    """Realised profit and loss by day, week (Monday start), month and all time, in dollars and R."""
    week = (today - dt.timedelta(days=today.weekday())).isoformat()
    month = today.replace(day=1).isoformat()
    t_day = [t for t in trades if t["session"] == today.isoformat()]
    t_week = [t for t in trades if week <= t["session"] <= today.isoformat()]
    t_month = [t for t in trades if month <= t["session"] <= today.isoformat()]
    money: list[float] = [float(t["pnl"]) for t in trades if t["pnl"] is not None]
    wins, losses = [x for x in money if x > 0], [x for x in money if x < 0]
    peak = run = dd = 0.0
    for x in money:
        run += x
        peak = max(peak, run)
        dd = min(dd, run - peak)
    start = _num((account or {}).get("start_equity"))
    equity = _num((account or {}).get("equity"))
    return {
        "today": _sum(t_day, "pnl"), "week": _sum(t_week, "pnl"), "month": _sum(t_month, "pnl"),
        "total": _sum(trades, "pnl"), "today_r": _sum(t_day, "r"), "week_r": _sum(t_week, "r"),
        "month_r": _sum(t_month, "r"), "total_r": _sum(trades, "r"),
        "today_trades": len(t_day), "week_trades": len(t_week), "month_trades": len(t_month),
        "equity": equity, "start": start,
        "return_pct": round((equity / start - 1) * 100, 3) if equity is not None and start else None,
        "trades": len(trades), "wins": len(wins), "losses": len(losses),
        "win_rate": round(len(wins) / len(money) * 100, 1) if money else None,
        "avg_win": round(sum(wins) / len(wins), 2) if wins else None,
        "avg_loss": round(sum(losses) / len(losses), 2) if losses else None,
        "profit_factor": round(sum(wins) / -sum(losses), 2) if wins and losses else None,
        "best": max(money) if money else None, "worst": min(money) if money else None,
        "max_dd": round(dd, 2) if money else None,
    }


def by_day(trades: list[dict[str, Any]]) -> list[dict[str, Any]]:
    days: dict[str, dict[str, Any]] = {}
    for t in trades:
        d = days.setdefault(t["session"], {"date": t["session"], "pnl": 0.0, "r": 0.0, "trades": 0})
        d["pnl"] = round(d["pnl"] + (t["pnl"] or 0.0), 2)
        d["r"] = round(d["r"] + (t["r"] or 0.0), 4)
        d["trades"] += 1
    return [days[k] for k in sorted(days)][-MAX_DAYS:]


def _blockers(raw: Any) -> list[str]:
    """Blocker kinds only ('latched:daily loss...' -> 'latched'): the text after the colon can be free text."""
    return sorted({str(b).split(":", 1)[0] for b in (raw or [])})


def session(rows: Iterable[dict[str, Any]]) -> dict[str, Any]:
    """The latest session the runner armed for: what it was allowed to do, each signal, the open position and the
    one-word outcome. A session from before the runner recorded its outcome gets the same answer worked out here."""
    rows = list(rows)
    armed = [r for r in rows if r.get("event") == "armed"]
    if not armed:
        return {"session": None, "outcome": None, "ended": False, "armed": None, "signals": [], "position": None}
    last = armed[-1]
    start = rows.index(last)
    day, mine = _day(last), rows[start:]
    signals: list[dict[str, Any]] = [{"at": _iso(r.get("signal_t")), "trigger": _num(r.get("trigger")), "stop": _num(r.get("stop")),
                "blockers": ", ".join(_blockers(r.get("blockers"))) or None, "acted": bool(r.get("runner_acts"))}
               for r in mine if r.get("event") == "decision" and r.get("would_signal")][:MAX_SIGNALS]
    placed = next((r for r in reversed(mine) if r.get("event") == "entry_placed"), None)
    fill = next((r for r in reversed(mine) if r.get("event") == "entry_filled"), None)
    closed = any(r.get("event") == "trade_closed" for r in mine)
    end = next((r for r in reversed(mine) if r.get("event") == "session_end"), None)
    position: dict[str, Any] | None = None
    if placed is not None and not closed and end is None:
        position = {"symbol": "QQQM", "state": "in_position" if fill else "entry_working",
                    "qty": _num((fill or placed).get("qty")), "entry": _num((fill or {}).get("price")),
                    "entry_at": _iso((fill or {}).get("ts")), "trigger": _num(placed.get("trigger")),
                    "stop": _num(placed.get("stop")), "target": _num(placed.get("target"))}
    outcome = str(end.get("outcome")) if end is not None and end.get("outcome") else None
    if outcome is None and end is not None:
        free = [s for s in signals if not s["blockers"]]
        outcome = ("traded" if placed is not None else "signal_not_acted" if free
                   else f"blocked:{signals[0]['blockers'].split(', ')[0]}" if signals else "no_signal")
    if outcome is None and placed is not None:
        outcome = "traded"
    off = last.get("entries_off") or []
    return {"session": day, "outcome": ":".join(outcome.split(":")[:2]) if outcome else None,   # the kind, no free text
            "ended": end is not None,
            "armed": {"at": _iso(last.get("ts")), "kill": bool(last.get("kill")), "entries_off": len(off)},
            "signals": signals, "position": position}


def view(rows: Iterable[dict[str, Any]], today: dt.date, account: dict[str, Any] | None) -> dict[str, Any]:
    rows = list(rows)
    trades = closed_trades(rows)
    return {**session(rows), "pnl": pnl_summary(trades, today, account), "trades": trades[-MAX_TRADES:],
            "days": by_day(trades)}
