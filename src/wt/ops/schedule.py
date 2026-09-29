"""The nightly jobs, defined once.

The launchd templates (deploy/launchd/*.plist.in), the job runner (`wt.ops.jobs`) and the deploy gate
(`wt.ops.window`) all read this table, so a schedule can't drift between them.

launchd fires on the host's local clock (Australia/Sydney). Session logic never trusts that clock: every job
converts to America/New_York itself, so both daylight-saving changes need no schedule edits.
"""
from __future__ import annotations

import datetime as dt
from dataclasses import dataclass
from zoneinfo import ZoneInfo

SYDNEY = ZoneInfo("Australia/Sydney")
PY = ".venv/bin/python"


@dataclass(frozen=True)
class Job:
    name: str                     # short name used by `python -m wt.ops.jobs run <name>`
    label: str                    # launchd label
    hour: int                     # local (Sydney) fire time
    minute: int
    command: tuple[str, ...]      # argv after the interpreter
    mode: str                     # MODE for the child process
    log: str                      # logs/<log>_<YYYYMMDD>.log
    weekday: int | None = None    # launchd Weekday (0 or 7 = Sunday ... 6 = Saturday); None = every day
    deadline_min: int | None = None   # hard limit once the job's own work starts (after any wait)
    trading: bool = True          # the deploy gate treats it as part of the trading night
    what: str = ""
    interval_s: int | None = None     # run every N seconds (StartInterval) instead of at a clock time
    preflight: bool = True        # refuse on failed preflight; the dashboard publishes the failures instead


    def fires(self, after: dt.datetime, days: int = 8) -> list[dt.datetime]:
        """Local fire times strictly after ``after`` (aware), for the next ``days`` days."""
        start = after.astimezone(SYDNEY)
        out: list[dt.datetime] = []
        if self.interval_s:
            return out                # interval jobs have no clock time (and are never trading jobs)
        for i in range(days + 1):
            d = start.date() + dt.timedelta(days=i)
            if self.weekday is not None and (d.isoweekday() % 7) != self.weekday % 7:
                continue
            t = dt.datetime(d.year, d.month, d.day, self.hour, self.minute, tzinfo=SYDNEY)
            if t > start:
                out.append(t)
        return out


JOBS: dict[str, Job] = {j.name: j for j in (
    Job("routine", "com.wt.routine", 21, 30, ("scripts/premarket_routine.py",), "backtest", "routine",
        what="SPEC-0001 pre-market dry run; waits in-process until 07:55 ET"),
    Job("paper-b", "com.wt.paper-b", 22, 30, ("-c", "from wt.live.runner_b import run; run()"), "paper", "paper_b",
        what="Strategy B paper session; waits in-process until 09:30 ET, exits at the close"),
    # 05:40 Sydney is before the earliest possible close (06:00 AEST / 16:00 EDT). The runner waits in-process
    # until close + 20 min ET, so SIP data is older than the free plan's 15-minute delay.
    Job("forward", "com.wt.forward", 5, 40, ("scripts/forward_test.py",), "backtest", "forward", deadline_min=90,
        what="Nightly forward test of the frozen candidates, 20 min after the close"),
    Job("weekly", "com.wt.weekly", 11, 0, ("scripts/weekly_scorecard.py",), "backtest", "scorecard", weekday=6,
        deadline_min=30, what="Weekly scorecard after Friday's forward test (waits for the forward lock)"),
    Job("dashboard", "com.wt.dashboard", 0, 0, ("-m", "wt.ops.publish"), "backtest", "dashboard", deadline_min=6,
        trading=False, interval_s=900, preflight=False,
        what="Collect status, sanitize, publish to the Vercel dashboard every 15 minutes"),
)}
TRADING_JOBS = [j.name for j in JOBS.values() if j.trading]
