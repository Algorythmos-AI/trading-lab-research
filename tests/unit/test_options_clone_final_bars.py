"""The options clone judges only finished 2-minute bars (DEC-0030): a bucket whose second minute the feed has not
delivered yet waits for it, up to `runner_o.LAST_MINUTE_GRACE`, and a bar whose close changes after it was judged
is journaled as `bar_revised`. Same scripted market and paper broker as the session tests."""
from __future__ import annotations

import datetime as dt
import json
from typing import Any

import pytest
from test_options_clone_session import OPEN, at, run_until, world  # noqa: F401

from wt.live import runner_o
from wt.live.runner_o import Name
from wt.options import regime
from wt.options.regime import NEW_YORK


@pytest.fixture
def w(world):  # noqa: F811 — the session tests' fixture
    return world


def minute(t: dt.datetime, c: float) -> regime.Bar:
    return regime.Bar(t, t + dt.timedelta(minutes=1), c, c + 0.1, c - 0.1, c, 100.0, 100.0 * c)


def decision_bars(w: dict[str, Any]) -> list[str]:
    f = w["tmp"] / "options/decisions/2026-10-19.jsonl"
    return [json.loads(x)["bar"] for x in f.read_text().splitlines()] if f.exists() else []


def delayed(w: dict[str, Any], lag_s: float = 0.0, never: tuple[str, ...] = ()) -> None:
    """The market's 1-minute bars reach the clone `lag_s` after each minute ends; the minutes in `never` never come."""
    full = w["m"].minutes

    def minutes(symbols, start, end):
        out = full(symbols, start, end)
        keep = {}
        for s, rows in out.items():
            kept = []
            for r in rows:
                t = dt.datetime.fromisoformat(r["t"].replace("Z", "+00:00")).astimezone(NEW_YORK)
                if t.strftime("%H:%M") in never or t + dt.timedelta(minutes=1, seconds=lag_s) > end:
                    continue
                kept.append(r)
            keep[s] = kept
        return keep

    w["m"].minutes = minutes


# ---------------------------------------------------------------- the pure rule
def test_without_grace_a_bucket_with_only_its_first_minute_counts_at_its_end():
    ms = [minute(OPEN, 10.0)]
    (b,) = regime.resample(ms, 2, OPEN + dt.timedelta(minutes=2))
    assert b.c == 10.0                                    # the dry run's behaviour, unchanged


def test_with_grace_a_bucket_waits_for_its_second_minute():
    grace = dt.timedelta(seconds=15)
    end = OPEN + dt.timedelta(minutes=2)
    ms = [minute(OPEN, 10.0)]
    assert regime.resample(ms, 2, end, grace) == []
    assert regime.resample(ms, 2, end + dt.timedelta(seconds=14), grace) == []
    ms.append(minute(OPEN + dt.timedelta(minutes=1), 10.5))
    (b,) = regime.resample(ms, 2, end, grace)             # both minutes in: judged at once, no wait
    assert b.c == 10.5 and b.o == 10.0


def test_with_grace_a_minute_that_never_comes_still_ends_its_bucket():
    grace = dt.timedelta(seconds=15)
    end = OPEN + dt.timedelta(minutes=2)
    ms = [minute(OPEN, 10.0)]
    (b,) = regime.resample(ms, 2, end + grace, grace)
    assert b.c == 10.0


def test_with_grace_a_bucket_with_only_its_second_minute_is_finished():
    grace = dt.timedelta(seconds=15)
    ms = [minute(OPEN + dt.timedelta(minutes=1), 10.5)]
    (b,) = regime.resample(ms, 2, OPEN + dt.timedelta(minutes=2), grace)
    assert b.c == 10.5


# ---------------------------------------------------------------- the runner
def test_the_signal_bar_is_judged_once_its_late_second_minute_arrives(w):
    delayed(w, lag_s=5)
    r = w["make"]()
    w["m"].now = at("09:25")
    assert r.arm()
    run_until(r, w["m"], w["b"], at("10:26"))
    assert "10:26" not in decision_bars(w)               # 10:25's minute is not in yet: the bar waits
    assert not r.today()
    run_until(r, w["m"], w["b"], at("10:26", 10))
    assert decision_bars(w).count("10:26") == 1
    (p,) = r.today()
    assert p.signal_bar == "10:26" and p.setup == "retest" and p.state == "open"
    assert not [x for x in w["rows"] if x["event"] == "bar_revised"]


def test_on_time_minutes_are_judged_at_the_first_poll_after_the_bar(w):
    r = w["make"]()
    w["m"].now = at("09:25")
    assert r.arm()
    run_until(r, w["m"], w["b"], at("10:26"))
    assert decision_bars(w).count("10:26") == 1           # no added wait when the feed is on time
    (p,) = r.today()
    assert p.signal_bar == "10:26"


def test_a_minute_the_feed_never_sends_ends_its_bar_after_the_grace(w):
    delayed(w, never=("10:25",))
    r = w["make"]()
    w["m"].now = at("09:25")
    assert r.arm()
    run_until(r, w["m"], w["b"], at("10:26", 10))
    assert "10:26" not in decision_bars(w)
    run_until(r, w["m"], w["b"], at("10:26") + runner_o.LAST_MINUTE_GRACE + dt.timedelta(seconds=10))
    assert decision_bars(w).count("10:26") == 1


def test_a_bar_whose_close_changes_after_it_was_judged_is_journaled_once(w):
    r = w["make"]()
    nm = Name("SPY", [], {})
    first = [regime.Bar(OPEN, OPEN + dt.timedelta(minutes=2), 10.0, 10.2, 9.9, 10.1, 200.0, 2020.0)]
    nm.last_bar, nm.last_close = "09:32", 10.1
    r.note_revised(nm, first)
    assert not [x for x in w["rows"] if x["event"] == "bar_revised"]
    changed = [regime.Bar(OPEN, OPEN + dt.timedelta(minutes=2), 10.0, 10.3, 9.9, 10.25, 300.0, 3060.0)]
    r.note_revised(nm, changed)
    r.note_revised(nm, changed)
    (row,) = [x for x in w["rows"] if x["event"] == "bar_revised"]
    assert row == {"event": "bar_revised", "root": "SPY", "bar": "09:32", "judged": 10.1, "now": 10.25}
