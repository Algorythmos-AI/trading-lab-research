"""After a reboot, which trading units should be running now? (Linux VM, ADR 0004)

    python -m wt.ops.bootreconcile        # prints the units to start, one per line (wt-boot-reconcile runs it)

systemd timers are Persistent=false, so a start that fell inside a reboot is not replayed. This names the jobs
whose window contains `now` so root's wt-boot-reconcile can start them; each job's own lock and in-process logic
make a second start harmless (the runner resumes its plan or runs exits-only; forward is idempotent).

Windows, on a session day (America/New_York):
  * paper-b: from 3 h before the open (the runner's own earliest arm) until the close;
  * forward: from 12:40 (its systemd start) until close + 20 min + its 90-minute deadline.
"""
from __future__ import annotations

import datetime as dt
import sys
from collections.abc import Mapping

from wt.core.clock import ET, et
from wt.ops.window import Session, load_sessions


def due(now: dt.datetime, sessions: Mapping[dt.date, Session]) -> list[str]:
    s = sessions.get(now.astimezone(ET).date())
    if s is None:
        return []
    out = []
    if s.open - dt.timedelta(hours=3) <= now < s.close:
        out.append("wt-paper-b.service")
    if et(s.date, "12:40") <= now < s.close + dt.timedelta(minutes=20 + 90):
        out.append("wt-forward.service")
    return out


def main() -> int:
    now = dt.datetime.now(dt.UTC)
    sessions, _ = load_sessions(now)
    for unit in due(now, sessions):
        print(unit)
    return 0


if __name__ == "__main__":
    sys.exit(main())
