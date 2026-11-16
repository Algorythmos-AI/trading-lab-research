"""A failure at arm is tried again until 09:58 (EXP-0029, fidelity fix): the broker part or the levels part, once a
minute, exits managed meanwhile, plans never re-read or re-booked; still failing at 09:58, one page and entries stay
off for the day. Same scripted market and paper broker as the session tests."""
from __future__ import annotations

from typing import Any

import pytest
from test_options_clone_session import at, events, run_until, world  # noqa: F401

from wt.brokers.base import TransportError
from wt.live import runner_o


@pytest.fixture
def w(world):  # noqa: F811 — the session tests' fixture
    return world


def failing_reconcile(r: runner_o.Runner, w: dict[str, Any], until: str | None) -> list[str]:
    real = r.oms.reconcile
    calls: list[str] = []

    def reconcile(plans):
        calls.append(w["m"].now.strftime("%H:%M:%S"))
        if until is None or w["m"].now < at(until):
            raise TransportError("paper-api answered 503")
        return real(plans)
    r.oms.reconcile = reconcile
    return calls


def failing_levels(r: runner_o.Runner, w: dict[str, Any], until: str | None) -> list[str]:
    """The fixture's prepare, failing the way the real one does (no names, `levels` off and kept for the retry)."""
    real = r.prepare
    calls: list[str] = []

    def prepare():
        calls.append(w["m"].now.strftime("%H:%M:%S"))
        if until is None or w["m"].now < at(until):
            r.off["levels"] = "levels unavailable"
            r.arm_failed["levels"] = TransportError("bars unavailable")
            return
        real()
    r.prepare = prepare
    return calls


def test_a_broker_that_comes_back_before_0958_arms_the_day_and_it_trades(w):
    r = w["make"]()
    calls = failing_reconcile(r, w, "09:40")
    w["m"].now = at("09:25")
    assert r.arm() is False and r.off == {"broker": "broker unreachable at arm"} and not r.names
    assert not events(w["rows"], "armed")
    run_until(r, w["m"], w["b"], at("10:27"))
    (back,) = events(w["rows"], "arm_retry")
    assert back["recovered"] == ["broker"] and back["still"] == [] and back["off"] == [] and back["names"] == ["SPY"]
    assert back["tries"] == len(calls) and 15 <= back["tries"] <= 17         # once a minute, 09:25 to 09:40
    (armed,) = events(w["rows"], "armed")
    assert armed["off"] == [] and armed["names"] == ["SPY"]
    assert w["pages"] == [p for p in w["pages"] if "entry" in p]             # no failure page
    (p,) = r.today()
    assert p.signal_bar == "10:26" and p.state == "open"


def test_levels_that_come_back_before_0958_turn_entries_back_on(w):
    r = w["make"]()
    calls = failing_levels(r, w, "09:33")
    w["m"].now = at("09:25")
    assert r.arm() is False and r.off == {"levels": "levels unavailable"}
    run_until(r, w["m"], w["b"], at("10:27"))
    (back,) = events(w["rows"], "arm_retry")
    assert back["recovered"] == ["levels"] and back["off"] == [] and len(calls) == back["tries"]
    assert len(events(w["rows"], "armed")) == 1                              # the arm line is not written twice
    (p,) = r.today()
    assert p.signal_bar == "10:26"


def test_still_failing_at_0958_pages_once_and_stops_trying(w):
    r = w["make"]()
    calls = failing_reconcile(r, w, None)
    w["m"].now = at("09:25")
    assert r.arm() is False
    run_until(r, w["m"], w["b"], at("09:57", 50))
    assert "options-clone:arm-broker" not in w["pages"]
    run_until(r, w["m"], w["b"], at("10:40"))
    assert w["pages"].count("options-clone:arm-broker") == 1
    (gave,) = events(w["rows"], "arm_retry")
    assert gave["gave_up"] and gave["still"] == ["broker"] and gave["tries"] == len(calls)
    assert max(calls) < "09:59"                                              # no try after the deadline
    assert r.off == {"broker": "broker unreachable at arm"} and r.today() == []


def test_a_failure_that_is_not_a_network_error_is_not_retried(w):
    r = w["make"]()
    w["b"].options_level = lambda: 1
    w["m"].now = at("09:25")
    assert r.arm() is False and "level" in r.off and r.arm_failed == {}
    run_until(r, w["m"], w["b"], at("10:00"))
    assert not events(w["rows"], "arm_retry")


def test_a_retry_never_reads_the_plans_again(w):
    r = w["make"]()
    failing_reconcile(r, w, "09:30")
    loads: list[int] = []
    real_load = r.store.load_all
    r.store.load_all = lambda: loads.append(1) or real_load()               # type: ignore[method-assign]
    w["m"].now = at("09:25")
    r.arm()
    run_until(r, w["m"], w["b"], at("09:45"))
    assert loads == [1] and len(events(w["rows"], "arm_retry")) == 1


def test_the_broker_back_but_levels_failing_then_back_is_two_recoveries(w):
    r = w["make"]()
    failing_reconcile(r, w, "09:30")
    failing_levels(r, w, "09:40")
    w["m"].now = at("09:25")
    r.arm()
    run_until(r, w["m"], w["b"], at("09:50"))
    got = events(w["rows"], "arm_retry")
    assert [(x["recovered"], x["still"]) for x in got] == [(["broker"], ["levels"]), (["levels"], [])]
    assert r.off == {} and r.names


def test_an_unexpected_error_in_a_retry_gives_up_without_costing_the_poll(w):
    r = w["make"]()
    failing_reconcile(r, w, None)
    w["m"].now = at("09:25")
    r.arm()

    def boom():
        raise RuntimeError("bug")
    r.connect_at_arm = boom                                                  # type: ignore[method-assign]
    run_until(r, w["m"], w["b"], at("09:30"))                                # step() never raised
    assert events(w["rows"], "arm_retry_fault") == [{"event": "arm_retry_fault", "error": "RuntimeError"}]
    assert r.arm_gave_up and "options-clone:arm-broker" in w["pages"]
    assert r.off == {"broker": "broker unreachable at arm"}                  # entries stay off


def test_an_arm_after_0958_that_fails_pages_at_once_and_never_retries(w):
    r = w["make"]()
    calls = failing_reconcile(r, w, "10:31")
    w["m"].now = at("10:30")                                                 # a restart after the deadline
    assert r.arm() is False and r.arm_gave_up
    assert w["pages"] == ["options-clone:arm-broker"]
    run_until(r, w["m"], w["b"], at("10:40"))
    assert calls == ["10:30:00"] and r.off == {"broker": "broker unreachable at arm"}


def test_with_the_whole_broker_down_the_0958_page_still_goes_out(w):
    """step's own "three polls in a row" page fires first; the give-up page must not be swallowed by it."""
    r = w["make"]()
    failing_reconcile(r, w, None)
    real = w["b"].positions

    def positions():
        if w["m"].now < at("10:05"):
            raise TransportError("down")
        return real()
    w["b"].positions = positions
    w["m"].now = at("09:25")
    assert r.arm() is False
    run_until(r, w["m"], w["b"], at("09:59"))
    assert "options-clone:broker" in w["pages"] and "options-clone:arm-broker" in w["pages"]
    (gave,) = events(w["rows"], "arm_retry")
    assert gave["gave_up"]
