"""Gap Hunter's watch from outside its own process: the pages the runner cannot send because it is not running.

The runner (`wt.live.runner_s`) pages what it sees while it runs. It cannot page that it never started, that it
ended early, that its process died, or that it is up but never armed. This watch can: it runs inside the dashboard
publish job, every 5 minutes in the trading window, whatever the runner does. It reads three things the host
already keeps:

* the job's heartbeat (`var/heartbeats/paper-s.json`), written by the job runner at the start and the end of a run;
* the runner's own lock (`paper-s-runner`), held for as long as the runner process lives;
* the runner's journal (`data/live/smallcap_journal.jsonl`), for today's `armed` row, and its plan files, for an
  open position.

It reads the session from the calendar (`wt.ops.window`). A day the calendar does not list is not watched, so a
holiday never pages. Between the open plus 5 minutes and 1 minute before the close, each finding pages once a day
and is resolved when it clears. Nothing here places, cancels or changes an order, and a failure never fails the
publish job.
"""
from __future__ import annotations

import datetime as dt
import json
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from wt.core.clock import ET

GRACE = dt.timedelta(minutes=5)          # the open plus this before "not armed" is a finding (09:35 on a full day)
CLOSE_MARGIN = dt.timedelta(minutes=1)   # no finding in the last minute: the runner is ending by design
TAIL_BYTES = 2_000_000                   # the journal's tail: today's rows are always within it
KEYS = ("paper-s:watch-not-started", "paper-s:watch-ended", "paper-s:watch-dead", "paper-s:watch-not-armed")


@dataclass(frozen=True)
class Finding:
    key: str
    title: str
    message: str
    priority: int


def findings(now: dt.datetime, open_dt: dt.datetime | None, close_dt: dt.datetime | None,
             heartbeat: Mapping[str, Any] | None, runner_alive: bool, armed_today: bool,
             open_positions: int) -> list[Finding]:
    """What is wrong with today's Gap Hunter session as of `now`. Empty outside the watched window, on a day with
    no session, and when the runner is up and armed. `open_positions`: the desk's plans holding shares; a finding
    with one open is priority 5, as nothing then manages its exit but its resting stop."""
    if open_dt is None or close_dt is None or not (open_dt + GRACE <= now < close_dt - CLOSE_MARGIN):
        return []
    from wt.ops.alerts import count
    held = (f" The desk holds {count(open_positions)} open position(s): nothing manages the exit but the resting "
            "stop." if open_positions else "")
    prio = 5 if open_positions else 4
    started = _when(heartbeat.get("started")) if heartbeat else None
    if started is None or started.astimezone(ET).date() != now.astimezone(ET).date():
        return [Finding("paper-s:watch-not-started", "Gap Hunter did not start today",
                        "The paper-s job has no run today, and the market is open. Check the timer "
                        "(systemctl list-timers wt-paper-s) and the job log." + held, prio)]
    status = str(heartbeat.get("status", "")) if heartbeat else ""
    if status != "running":
        how = {"refused": "was refused (its preflight or keys)", "failed": "failed",
               "timeout": "hit its deadline", "ok": "ended", "skipped": "was skipped"}.get(status, "ended")
        return [Finding("paper-s:watch-ended", "Gap Hunter is not running in the session",
                        f"Today's paper-s run {how} before the close, and the market is open. The job "
                        "heartbeat and log say why." + held, prio)]
    if not runner_alive:
        return [Finding("paper-s:watch-dead", "Gap Hunter's process is gone",
                        "The paper-s heartbeat says running, but no runner process holds its lock. The process "
                        "likely died without the job runner seeing it. Check the unit (systemctl status "
                        "wt-paper-s)." + held, 5)]
    if not armed_today:
        return [Finding("paper-s:watch-not-armed", "Gap Hunter is running but not armed",
                        "The runner is up, but today's journal has no armed row and the market has been open "
                        "for 5 minutes. Its journal (refuse_to_arm, broker_connect_failed) says why." + held, prio)]
    return []


def _when(text: Any) -> dt.datetime | None:
    try:
        t = dt.datetime.fromisoformat(str(text))
    except ValueError:
        return None
    return t if t.tzinfo else t.replace(tzinfo=dt.UTC)


def armed_on(rows: Iterable[Mapping[str, Any]], day: dt.date) -> bool:
    return any(r.get("event") == "armed" and r.get("day") == day.isoformat() for r in rows)


def journal_tail(path: Path, max_bytes: int = TAIL_BYTES) -> list[dict[str, Any]]:
    """The journal's last rows. A torn first line (the tail cut it) and any unreadable line are skipped."""
    try:
        with open(path, "rb") as fh:
            fh.seek(0, 2)
            size = fh.tell()
            fh.seek(max(0, size - max_bytes))
            raw = fh.read().decode("utf-8", "replace").splitlines()
    except OSError:
        return []
    if size > max_bytes and raw:
        raw = raw[1:]
    out = []
    for line in raw:
        try:
            r = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(r, dict):
            out.append(r)
    return out


def open_positions(plans: Path) -> int:
    n = 0
    for f in sorted(plans.glob("*.json")) if plans.exists() else []:
        try:
            n += json.loads(f.read_text()).get("state") in ("in_position", "exiting")
        except (OSError, json.JSONDecodeError, AttributeError):
            continue
    return n


def run(now: dt.datetime | None = None, alerts: Any = None) -> list[str]:
    """Read the host's state, page each finding once a day, resolve the rest. Returns the keys that fired."""
    from wt.live import runner_s
    from wt.ops import locks
    from wt.ops.alerts import Alerts
    from wt.ops.heartbeat import last_runs
    from wt.ops.window import load_sessions

    now = now or dt.datetime.now(dt.UTC)
    alerts = alerts if alerts is not None else Alerts()
    if not runner_s.switched_on():
        return []                                      # nothing is switched on: the desk is meant to be idle
    sessions, _ = load_sessions(now)
    today = now.astimezone(ET).date()
    s = sessions.get(today)
    rows = journal_tail(runner_s.JOURNAL)
    found = findings(now, s.open if s else None, s.close if s else None, last_runs().get("paper-s"),
                     locks.is_held(runner_s.RUNNER_LOCK), armed_on(rows, today),
                     open_positions(runner_s.PLANS))
    day = today.isoformat()
    fired = []
    hit = {f.key for f in found}
    for f in found:
        if alerts.fire(f"{f.key}:{day}", f.title, f.message, f.priority):
            fired.append(f.key)
    if s is not None and s.open + GRACE <= now < s.close - CLOSE_MARGIN:
        for key in KEYS:
            if key not in hit:
                alerts.resolve(f"{key}:{day}", "Gap Hunter: running and armed", "The session is watched again.")
    return fired
