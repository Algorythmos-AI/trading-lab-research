"""The nightly jobs, defined once.

The launchd agents (`wt.ops.agents`), the systemd units (`wt.ops.units`), the job runner (`wt.ops.jobs`) and the
deploy gate (`wt.ops.window`) all read this table, so a schedule can't drift between them.

Two clocks, one table:
  * launchd (the Mac) fires on the host's local clock, Australia/Sydney: `hour`/`minute`/`weekday`.
  * systemd (the Linux VM) fires in America/New_York directly: `et` is an OnCalendar day-and-time spec, rendered
    with the zone, so neither daylight-saving change ever needs a schedule edit (US clocks change on Sundays;
    no job fires on a weekend).
Session logic never trusts either: every job converts to America/New_York itself and waits in-process for its
real start (the routine for 07:55 ET, paper-b for the open, forward for close + 20 min).
"""
from __future__ import annotations

import datetime as dt
from dataclasses import dataclass
from zoneinfo import ZoneInfo

SYDNEY = ZoneInfo("Australia/Sydney")
NEW_YORK = ZoneInfo("America/New_York")
PY = ".venv/bin/python"
_DAYS = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")


def et_days(spec: str) -> set[int]:
    """Weekdays (Monday = 0) of an OnCalendar day spec: "Mon..Fri", "Fri" or "Mon,Wed"."""
    out: set[int] = set()
    for part in spec.split(","):
        if ".." in part:
            a, b = (_DAYS.index(x) for x in part.split(".."))
            out.update(range(a, b + 1))
        else:
            out.add(_DAYS.index(part))
    return out


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
    et: str | None = None         # systemd OnCalendar day/time in America/New_York, e.g. "Mon..Fri 07:30"
    runtime_max_h: float = 6.0    # systemd RuntimeMaxSec: above the job's own deadline plus its in-process wait
    desk: str = "stocks"          # wt.core.desk: whose snapshot, alerts and SLA the job belongs to
    # systemd OnCalendar in UTC for an interval job that must stay on a clock boundary (a 15-minute bar close):
    # OnUnitActiveSec counts from the last start and drifts. interval_s still says how often it runs.
    calendar: str | None = None
    # systemd OnCalendar specs, each with its own zone, for a job with more than one rhythm (the stocks publisher:
    # every 5 minutes in the US session, every 15 otherwise). `interval_s` stays the slowest of them: it is what
    # the cadence check holds the job to at any hour.
    calendars: tuple[str, ...] = ()


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

    def fires_et(self, after: dt.datetime, days: int = 8) -> list[dt.datetime]:
        """systemd fire times (America/New_York) strictly after ``after``, for the next ``days`` days."""
        if not self.et:
            return []
        day_spec, hhmm = self.et.split()
        wanted, (h, m) = et_days(day_spec), (int(x) for x in hhmm.split(":"))
        start = after.astimezone(NEW_YORK)
        out: list[dt.datetime] = []
        for i in range(days + 1):
            d = start.date() + dt.timedelta(days=i)
            t = dt.datetime(d.year, d.month, d.day, h, m, tzinfo=NEW_YORK)
            if d.weekday() in wanted and t > start:
                out.append(t)
        return out


JOBS: dict[str, Job] = {j.name: j for j in (
    Job("routine", "com.wt.routine", 21, 30, ("scripts/premarket_routine.py",), "backtest", "routine",
        what="SPEC-0001 pre-market dry run; waits in-process until 07:55 ET", et="Mon..Fri 07:30",
        runtime_max_h=6),
    # The runner arms up to 3 h before the open and runs to the close; its deadline is close + 45 min.
    Job("paper-b", "com.wt.paper-b", 22, 30, ("-c", "from wt.live.runner_b import run; run()"), "paper", "paper_b",
        what="Strategy B paper session; waits in-process until 09:30 ET, exits at the close", et="Mon..Fri 08:30",
        runtime_max_h=10),
    # 05:40 Sydney is before the earliest possible close (06:00 AEST / 16:00 EDT). The runner waits in-process
    # until close + 20 min ET, so SIP data is older than the free plan's 15-minute delay.
    # On systemd it starts at 12:40 ET, before the earliest early close (13:00 + 20 min), and waits.
    Job("forward", "com.wt.forward", 5, 40, ("scripts/forward_test.py",), "backtest", "forward", deadline_min=90,
        what="Nightly forward test of the frozen candidates, 20 min after the close", et="Mon..Fri 12:40",
        runtime_max_h=6),
    Job("weekly", "com.wt.weekly", 11, 0, ("scripts/weekly_scorecard.py",), "backtest", "scorecard", weekday=6,
        deadline_min=30, what="Weekly scorecard after Friday's forward test (waits for the forward lock)",
        et="Fri 20:00", runtime_max_h=4),
    Job("dashboard", "com.wt.dashboard", 0, 0, ("-m", "wt.ops.publish"), "backtest", "dashboard", deadline_min=6,
        trading=False, interval_s=900, preflight=False,
        # Minute 3, not 0: the routine writes each stage file at about :02, and it stays clear of the crypto cycle
        # (:00:10) and the crypto publish (:01).
        calendars=("Mon..Fri 07..17:03/5:00 America/New_York", "*:03/15:00 UTC"),
        what="Collect status, sanitize, publish to the dashboard: every 5 minutes in the US session, every 15 otherwise",
        runtime_max_h=0.25),
    # The crypto desk (ADR 0005) runs around the clock as two interval jobs on UTC calendar boundaries: one bar
    # cycle ten seconds after each 15-minute close, and its publish a minute after that. Neither is a trading job
    # for the equity deploy gate: a deploy waits for a cycle in flight (wt.ops.deploy.quiesced) instead.
    Job("crypto", "com.wt.crypto", 0, 0, ("-m", "wt.crypto.cycle"), "backtest", "crypto", deadline_min=5,
        trading=False, interval_s=900, calendar="*:0/15:10", desk="crypto",
        what="Crypto desk bar cycle: data, quality, exits, entries, evidence; after every 15-minute close",
        runtime_max_h=0.2),
    Job("dashboard-crypto", "com.wt.dashboard-crypto", 0, 0, ("-m", "wt.crypto.snapshot"), "backtest",
        "dashboard_crypto", deadline_min=6, trading=False, interval_s=900, calendar="*:1/15:00", desk="crypto",
        preflight=False, what="Publish the crypto desk's snapshot to the dashboard every 15 minutes",
        runtime_max_h=0.25),
    # The challengers (DEC-0016, 5): once a day, in the quiet hours between the US close and the pre-market
    # routine (03:30, not 02:30: that half hour does not exist on the night US clocks go forward). Most runs only check retirements and take seconds; the first of an ISO week draws up to two new
    # ones and backtests each (about 200 two-year runs). Not a trading job: a deploy waits for it instead.
    Job("crypto-challengers", "com.wt.crypto-challengers", 18, 30, ("-m", "wt.crypto.challengers"), "backtest",
        "crypto_challengers", deadline_min=60, trading=False, et="Mon..Sun 03:30", desk="crypto",
        what="Crypto challengers: retire, draw at most two a week, register, backtest (gate C1), admit",
        runtime_max_h=1.25),
    # The learning job (DEC-0016, 2 to 4), after the challengers: every signal's outcome, the model's checkpoint
    # tests, and once a week the retraining, which runs in the machine-learning environment as its own process.
    Job("crypto-learn", "com.wt.crypto-learn", 19, 30, ("-m", "wt.crypto.learn"), "backtest", "crypto_learn",
        deadline_min=90, trading=False, et="Mon..Sun 04:30", desk="crypto",
        what="Crypto learning: signal outcomes, the model's promotion tests, weekly retraining", runtime_max_h=1.75),
)}
TRADING_JOBS = [j.name for j in JOBS.values() if j.trading]
