"""Session windows and the deploy gate, computed in America/New_York.

No rule here uses a fixed Sydney time. The US close falls at 06:00, 07:00 or 08:00 Sydney depending on which
daylight-saving regimes are in force (AEST/EDT until 2026-10-03, AEDT/EDT to 2026-10-31, AEDT/EST from
2026-11-01, AEST/EST from April), so every window is derived from the exchange calendar and zoneinfo.
"""
from __future__ import annotations

import datetime as dt
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Any

from wt.core.clock import ET, et
from wt.ops.schedule import JOBS, Job

PRE_SESSION_ET = "07:00"         # the routine's first stage is 08:00 ET; nothing changes after 07:00 ET
POST_CLOSE_MIN = 120             # forward test (close + 20 min) plus its 90-minute deadline, with slack
LEAD_MIN = 60                    # no deploy within an hour of a scheduled job start
FORWARD_DELAY_MIN = 20           # SIP data must be older than the free plan's 15-minute delay


@dataclass(frozen=True)
class Session:
    date: dt.date
    open: dt.datetime            # aware, America/New_York
    close: dt.datetime


def sessions_from_calendar(rows: Iterable[Mapping[str, Any]]) -> dict[dt.date, Session]:
    """Alpaca /v2/calendar rows ({date, open "09:30", close "16:00"}) to sessions keyed by date."""
    out = {}
    for r in rows:
        d = r["date"] if isinstance(r["date"], dt.date) else dt.date.fromisoformat(str(r["date"])[:10])
        out[d] = Session(d, et(d, str(r["open"])[:5]), et(d, str(r["close"])[:5]))
    return out


def weekday_sessions(start: dt.date, days: int) -> dict[dt.date, Session]:
    """Fallback when the calendar can't be read: every weekday 09:30-16:00 (ignores holidays and half days)."""
    out = {}
    for i in range(days):
        d = start + dt.timedelta(days=i)
        if d.weekday() < 5:
            out[d] = Session(d, et(d, "09:30"), et(d, "16:00"))
    return out


def load_sessions(now: dt.datetime, back: int = 5, ahead: int = 10) -> tuple[dict[dt.date, Session], bool]:
    """Sessions around ``now`` from the Alpaca calendar. Returns (sessions, exact); exact is False on fallback."""
    d = now.astimezone(ET).date()
    try:
        from wt.data.alpaca import AlpacaREST
        cal = AlpacaREST(per_minute=30).calendar((d - dt.timedelta(days=back)).isoformat(),
                                                (d + dt.timedelta(days=ahead)).isoformat())
        return sessions_from_calendar(cal.to_dict(orient="records")), True
    except Exception:  # noqa: BLE001 — any calendar failure falls back, and callers see exact=False
        return weekday_sessions(d - dt.timedelta(days=back), back + ahead + 1), False


def trading_blackout(now: dt.datetime, sessions: Mapping[dt.date, Session]) -> str | None:
    """Reason why ``now`` is inside a trading night (07:00 ET to close + 2 h on a session day), else None."""
    n = now.astimezone(ET)
    s = sessions.get(n.date())
    if s is None:
        return None
    start, end = et(s.date, PRE_SESSION_ET), s.close + dt.timedelta(minutes=POST_CLOSE_MIN)
    if start <= n <= end:
        return (f"inside the trading window for {s.date} ({start:%H:%M} ET to {end:%H:%M} ET, "
                f"close {s.close:%H:%M} ET)")
    return None


def upcoming_starts(now: dt.datetime, jobs: Iterable[Job] | None = None, lead_min: int = LEAD_MIN) -> list[str]:
    """Trading jobs that launchd will start within ``lead_min`` minutes of ``now``."""
    out = []
    for j in jobs if jobs is not None else JOBS.values():
        if not j.trading:
            continue
        for t in j.fires(now, days=1):
            if t - now.astimezone(t.tzinfo) <= dt.timedelta(minutes=lead_min):
                out.append(f"{j.label} starts at {t:%H:%M} Sydney ({t.astimezone(ET):%H:%M} ET)")
    return out


def deploy_blockers(now: dt.datetime, sessions: Mapping[dt.date, Session], running: Mapping[str, bool],
                    locks: Iterable[str], exact_calendar: bool = True) -> list[str]:
    """Every reason a deploy must not touch the live checkout now. Empty means allowed."""
    out = [f"{label} is running" for label, r in sorted(running.items()) if r]
    out += [f"job lock held: {name}" for name in locks]
    if (b := trading_blackout(now, sessions)) is not None:
        out.append(b)
    out += upcoming_starts(now)
    if not exact_calendar:
        out.append("market calendar unavailable (weekday fallback in use); retry when the Alpaca calendar answers")
    return out


def forward_wait_until(now: dt.datetime, sessions: Mapping[dt.date, Session],
                       delay_min: int = FORWARD_DELAY_MIN) -> dt.datetime | None:
    """When the forward job should start its work: close + ``delay_min`` if today's session is open or just closed.

    Returns None to run immediately. Outside a session (weekend, before the open, late wake-up), running at once is
    right: the forward test catches up on completed sessions and skips the ones already done, so a late launch never
    waits a whole day holding its lock.
    """
    n = now.astimezone(ET)
    s = sessions.get(n.date())
    if s is None:
        return None
    target = s.close + dt.timedelta(minutes=delay_min)
    return target if s.open <= n < target else None
