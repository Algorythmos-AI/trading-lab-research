"""scripts/gap_expiry_audit.py: constructed journal rows and trades only. Its `main` and `sip_trades` (the parts that
read the journal file and the market-data API) are never called here."""
from __future__ import annotations

import datetime as dt
import importlib.util
import json
import sys
from pathlib import Path

import pytest

UTC = dt.timezone.utc
DAY = "2026-11-27"


@pytest.fixture
def mod():
    spec = importlib.util.spec_from_file_location("gap_expiry_audit",
                                                  Path(__file__).resolve().parents[2] / "scripts" / "gap_expiry_audit.py")
    m = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = m                   # a dataclass looks its module up while it is built
    spec.loader.exec_module(m)
    yield m
    sys.modules.pop(spec.name, None)


def at(hh: int, mm: int, ss: int = 0) -> dt.datetime:
    return dt.datetime(2026, 11, 27, hh, mm, ss, tzinfo=UTC)


def placed(n: int, t: dt.datetime, *, rotation: bool = True) -> dict:
    row = {"ts": t.isoformat(), "event": "entry_placed", "trade_id": f"{DAY}-S-ABC-{n}", "symbol": "ABC",
           "limit": 1.51, "detail": [["entry_placed", 1.49, 1.51, 22]]}
    if rotation:
        row["trigger"] = 1.49
    return row


def cancelled(n: int, t: dt.datetime, filled: int = 0, why: str = "expired", state: str = "aborted") -> dict:
    return {"ts": t.isoformat(), "event": "entry_cancelled", "trade_id": f"{DAY}-S-ABC-{n}", "symbol": "ABC",
            "why": why, "filled": filled, "state": state}


def test_only_expired_unfilled_entries_of_the_asked_sessions_are_judged(mod):
    rows = [placed(1, at(14, 31, 11)), cancelled(1, at(14, 32, 2)),
            placed(2, at(14, 35, 13), rotation=False), cancelled(2, at(14, 50, 3)),     # trigger from `detail`
            placed(3, at(15, 0)), cancelled(3, at(15, 1), filled=10),                   # it filled: not judged
            placed(4, at(15, 5)),                                                       # no cancel row: not judged
            {**placed(5, at(14, 40)), "trade_id": "2026-11-26-S-ABC-5"}]                # another session
    orders, n = mod.expired_orders(rows, {DAY})
    assert [o.trade_id[-1] for o in orders] == ["1", "2"] and n == {DAY: {"placed": 4, "other_cancel": 0}}
    assert all((o.trigger, o.limit) == (1.49, 1.51) for o in orders)
    assert orders[0].placed == at(14, 31, 11) and orders[0].ended == at(14, 32, 2)


def test_an_entry_cancelled_for_another_reason_is_counted_not_judged(mod):
    rows = [placed(1, at(14, 31)), cancelled(1, at(14, 33), why="withdrawn"),
            placed(2, at(14, 35)), cancelled(2, at(14, 36), why="replaced")]
    orders, n = mod.expired_orders(rows, {DAY})
    assert orders == [] and n == {DAY: {"placed": 2, "other_cancel": 2}}


def test_the_window_ends_at_the_confirmed_cancel_not_the_first_request(mod):
    rows = [placed(1, at(14, 35)), cancelled(1, at(14, 50), state="entry_working"),     # not confirmed: resting
            cancelled(1, at(14, 52), state="aborted")]
    orders, _ = mod.expired_orders(rows, {DAY})
    assert len(orders) == 1 and orders[0].ended == at(14, 52)
    assert mod.classify([(at(14, 51), 1.50)], orders[0]) == "in_band"                     # while it still rested
    only_requested, _ = mod.expired_orders(rows[:2], {DAY})
    assert only_requested == []                                                           # no confirmed cancel yet


def test_a_spike_before_the_order_existed_is_not_a_reach(mod):
    """Friday's shape: the opening minute printed 1.48 and higher prints came before the order was placed."""
    orders, _ = mod.expired_orders([placed(1, at(14, 31, 11)), cancelled(1, at(14, 32, 2))], {DAY})
    trades = [(at(14, 30, 5), 1.55), (at(14, 31, 10), 1.50), (at(14, 31, 30), 1.29), (at(14, 32, 5), 1.60)]
    assert mod.classify(trades, orders[0]) == "not_reached"


def test_the_three_classes(mod):
    orders, _ = mod.expired_orders([placed(1, at(14, 35)), cancelled(1, at(14, 50))], {DAY})
    o = orders[0]
    assert mod.classify([(at(14, 40), 1.48)], o) == "not_reached"
    assert mod.classify([(at(14, 40), 1.48), (at(14, 41), 1.49)], o) == "in_band"            # at the trigger
    assert mod.classify([(at(14, 40), 1.55), (at(14, 41), 1.53)], o) == "over_limit"         # gapped through
    assert mod.classify([(at(14, 40), 1.55), (at(14, 41), 1.50)], o) == "in_band"            # came back into band
    assert mod.classify([(at(14, 40), 1.50), (at(14, 39), 1.20)], o) == "in_band"            # order of the input
    assert mod.classify([(at(14, 40), 1.55), (at(14, 41), 1.20)], o) == "in_band"            # a limit buy once triggered
    assert mod.classify([(at(14, 39), 1.20), (at(14, 40), 1.55)], o) == "over_limit"         # cheap before the trigger


def test_a_sessions_line_carries_a_date_and_counts_and_nothing_else(mod):
    rows = [placed(1, at(14, 31, 11)), cancelled(1, at(14, 32, 2)), placed(2, at(14, 35)), cancelled(2, at(14, 50))]
    orders, n = mod.expired_orders(rows, {DAY})
    asked = []

    def trades_of(o):
        asked.append(o.trade_id)
        return [(at(14, 40), 1.50)] if o.trade_id.endswith("2") else []

    lines = mod.session_lines(orders, n, trades_of)
    assert asked == [f"{DAY}-S-ABC-1", f"{DAY}-S-ABC-2"]
    assert lines == [{"date": DAY, "placed": 2, "other_cancel": 0, "expired": 2, "not_reached": 1, "over_limit": 0,
                      "in_band": 1}]
    text = json.dumps(lines)
    assert "ABC" not in text and "." not in text
