import datetime as dt

from wt.core.clock import ET
from wt.risk import events


def test_fomc_blackout_and_quad_witching_reduce():
    fomc = dt.datetime(2026, 9, 16, 14, 10, tzinfo=ET)
    assert events.policy(fomc) == ("blackout", "fomc_decision")
    assert events.policy(fomc.replace(hour=10))[0] in ("ok", "reduce")
    assert events.policy(dt.datetime(2026, 9, 18, 10, 0, tzinfo=ET)) == ("reduce", "quad_witching")


def test_calendar_coverage_check():
    assert events.coverage_ok(dt.date(2026, 9, 28))
    assert not events.coverage_ok(dt.date(2027, 12, 20))
