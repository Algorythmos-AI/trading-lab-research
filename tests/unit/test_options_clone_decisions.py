"""The options clone's decision log says why a signal was refused and whether its contract's greeks were modelled
(logging only: no gate, threshold or exit changes). Same scripted market and paper broker as the session tests."""
from __future__ import annotations

import dataclasses
import datetime as dt
import json
from typing import Any

import pytest
from test_options_clone_session import CFG, DAY, LIM, at, run_until, world  # noqa: F401

from wt.brokers.base import BrokerRejected
from wt.options import chain


@pytest.fixture
def w(world):  # noqa: F811 — the session tests' fixture
    """The session tests' scripted market, paper broker and runner factory."""
    return world


def decisions(w: dict[str, Any]) -> list[dict[str, Any]]:
    return [json.loads(x) for x in (w["tmp"] / "options/decisions/2026-10-19.jsonl").read_text().splitlines()]


def signal_row(w: dict[str, Any]) -> dict[str, Any]:
    (row,) = [d for d in decisions(w) if d.get("signals")]
    return row


def session(w: dict[str, Any], **kw: Any) -> Any:
    r = w["make"](**kw)
    w["m"].now = at("09:25")
    r.arm()
    return r


def test_a_signal_refused_by_kill_names_kill_and_its_contract_expiry_and_modelled_flag(w):
    (w["tmp"] / "KILL").write_text("x")
    r = session(w)
    run_until(r, w["m"], w["b"], at("10:27"))
    row = signal_row(w)
    (s,) = row["signals"]
    assert row["action"] == "signal-refused"
    assert s["reason"] == "kill" and s["failed"] == ["kill"] and s["why"] == {}
    assert s["contract"] == {"expiry": "2026-10-19", "modelled": False, "delta": pytest.approx(0.5, abs=0.2)}


def test_a_contract_with_no_feed_greeks_is_logged_as_modelled_when_entered(w):
    w["m"].feed_greeks = False
    r = session(w)
    run_until(r, w["m"], w["b"], at("10:26", 10))
    row = signal_row(w)
    (s,) = row["signals"]
    assert row["action"] == "entered" and s["reason"] is None and s["failed"] == []
    assert s["contract"]["modelled"] is True and s["contract"]["expiry"] == "2026-10-19"


def test_a_contract_refusal_names_the_nearest_contracts_reason_and_numbers(w):
    w["m"].oi = 10
    r = session(w)
    run_until(r, w["m"], w["b"], at("10:27"))
    (s,) = signal_row(w)["signals"]
    assert s["reason"] == "open-interest-below-floor" and s["failed"] == ["contract"]
    assert s["why"]["open_interest"] == 10 and s["why"]["min"] == float(CFG["contract"]["min_open_interest"])
    assert s["why"]["candidates"] > 1
    assert s["contract"]["expiry"] == "2026-10-19" and s["contract"]["modelled"] is False


def test_a_guard_refusal_is_logged_as_entry_refused_with_the_guards_code(w):
    r = w["make"]()
    r.oms.lim = dataclasses.replace(LIM, max_entries_per_day=0)
    w["m"].now = at("09:25")
    r.arm()
    run_until(r, w["m"], w["b"], at("10:26", 10))
    (p,) = r.today()
    assert p.state == "rejected" and w["b"].placed == []
    row = signal_row(w)
    (s,) = row["signals"]
    assert row["action"] == "entry-refused"
    assert s["reason"] == "guard-max-entries" and s["failed"] == ["guard"] and s["why"] == {"entries": 0, "max": 0}
    assert s["contract"]["expiry"] == "2026-10-19" and s["contract"]["modelled"] is False


def test_a_broker_refusal_is_logged_as_entry_refused(w, monkeypatch):
    def refuse(order):
        raise BrokerRejected("422")
    monkeypatch.setattr(w["b"], "place", refuse)
    r = session(w)
    run_until(r, w["m"], w["b"], at("10:26", 10))
    row = signal_row(w)
    (s,) = row["signals"]
    assert row["action"] == "entry-refused" and s["reason"] == "broker-refused" and s["failed"] == ["broker"]


def test_the_published_document_carries_no_reason_contract_or_setup_field(w):
    from test_options_clone_session import Posted, _keys

    from wt.options import clone_site
    w["m"].oi = 10
    out = Posted()
    r = session(w, publisher=out)
    run_until(r, w["m"], w["b"], at("10:27"))
    r.publish()
    last = out.docs[-1]
    assert clone_site.validate(last) == []
    assert not {"setup", "reason", "why", "modelled", "failed", "refused_for"} & _keys(last)
    body = clone_site.body(last).decode()
    assert "retest" not in body and "rejection" not in body and "open-interest" not in body
    spy = next(g for g in last["gates"] if g["symbol"] == "SPY")
    assert spy["refused_by"] == {"contract": 1} and spy["entered"] == 0


def test_pick_reports_the_nearest_refused_contract_and_its_delta_against_the_floor():
    now = dt.datetime.combine(DAY, dt.time(10, 0), dt.UTC)
    c = {**CFG["contract"], "quote_stale_flat_s": 60}
    q = [chain.Quote(chain.Contract(f"SPY261019C{k * 1000:08d}", "SPY", DAY, "call", float(k)), 0.10, 0.11, now,
                     0.05, 0.2, 1e5, True) for k in (590, 600)]
    got = chain.pick(q, "SPY", "call", DAY, 580.0, now, c, {}, set(), late=False)
    assert got.quote is None and got.reasons == {"delta-below-floor": 2}
    assert got.miss == {"reason": "delta-below-floor", "expiry": "2026-10-19", "modelled": True, "delta": 0.05,
                        "floor": float(c["min_delta"])}


def test_a_fault_in_the_decision_log_never_costs_the_entry(w, monkeypatch):
    r = session(w)

    def broken(*a):
        raise KeyError("x")
    monkeypatch.setattr(r, "refusal", broken)
    run_until(r, w["m"], w["b"], at("10:26", 10))
    (p,) = r.today()
    assert p.state == "open"
    (s,) = signal_row(w)["signals"]
    assert "reason" not in s and s["log_fault"] == "KeyError"
