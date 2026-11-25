"""wt.lab.tiers against the real market calendar the host reads."""
from __future__ import annotations

import datetime as dt

from wt.lab import tiers


def test_the_real_calendar_gives_thanksgiving_week_its_half_day_and_its_holiday() -> None:
    """2026-11-27 is shadow session 5 (owner, 2026-11-25): the recorder's ticks, after-close stop and upload deadline
    all key off this close, so the calendar the host reads must say 13:00 for it."""
    assert tiers.close_time(dt.date(2026, 11, 27)) == dt.time(13, 0)
    assert tiers.close_time(dt.date(2026, 11, 25)) == dt.time(16, 0)
    days = tiers.sessions()
    assert "2026-11-27" in days and "2026-11-26" not in days and "2026-11-25" in days
