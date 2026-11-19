"""DEC-0063: B's target exit waits for the bid to reach the target and never sells below it (EXP-0048)."""
from __future__ import annotations

import inspect

from wt.live import runner_b
from wt.live.runner_b import target_exit_limit


def test_waits_while_the_bid_is_below_the_target() -> None:
    # the EXP-0048 case: a wide quote whose mid is over the target while the bid is far under it
    assert target_exit_limit((250.10, 252.50, None), 251.00) is None


def test_sells_at_the_target_once_the_bid_reaches_it() -> None:
    assert target_exit_limit((251.00, 251.02, None), 251.00) == 251.00
    assert target_exit_limit((251.40, 251.42, None), 251.00) == 251.00   # limit at the target: marketable, never below


def test_missing_zero_or_crossed_quotes_wait() -> None:
    assert target_exit_limit(None, 251.0) is None
    assert target_exit_limit((0.0, 251.5, None), 251.0) is None
    assert target_exit_limit((251.5, 251.4, None), 251.0) is None


def test_the_session_loop_uses_the_guard() -> None:
    src = inspect.getsource(runner_b._session)
    assert "target_exit_limit(q, plan.target)" in src
    assert 'reason="target"' in src
    assert "last_mid >= plan.target" not in src
