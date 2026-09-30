"""After a reboot the VM restarts paper-b and forward only inside their windows (wt.ops.bootreconcile)."""
import datetime as dt

import pytest

from wt.core.clock import ET, et
from wt.ops.bootreconcile import due
from wt.ops.window import Session

DAY = dt.date(2026, 10, 7)
FULL = {DAY: Session(DAY, et(DAY, "09:30"), et(DAY, "16:00"))}
EARLY = {DAY: Session(DAY, et(DAY, "09:30"), et(DAY, "13:00"))}


def at(hhmm: str) -> dt.datetime:
    return et(DAY, hhmm)


@pytest.mark.parametrize("hhmm,want", [
    ("06:00", []),
    ("06:30", ["wt-paper-b.service"]),                               # 3 h before the open
    ("11:00", ["wt-paper-b.service"]),
    ("12:40", ["wt-paper-b.service", "wt-forward.service"]),
    ("16:00", ["wt-forward.service"]),                               # the close: the runner is done
    ("17:49", ["wt-forward.service"]),
    ("17:50", []),                                                    # close + 20 min + 90 min
])
def test_windows_on_a_full_day(hhmm, want):
    assert due(at(hhmm), FULL) == want


def test_early_close_and_no_session():
    assert due(at("13:30"), EARLY) == ["wt-forward.service"]
    assert due(at("14:50"), EARLY) == []
    assert due(at("11:00"), {}) == []                                # a holiday: nothing to start
    assert due(dt.datetime(2026, 10, 7, 16, 0, tzinfo=dt.UTC), FULL) == ["wt-paper-b.service"]   # 12:00 ET
    assert ET.key == "America/New_York"
