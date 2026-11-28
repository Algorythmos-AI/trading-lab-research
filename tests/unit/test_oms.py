from wt.brokers.sim import SimBroker
from wt.oms.manager import OMS, TradePlan, reconcile


def plan(qty=4):
    return TradePlan(date="2026-09-28", strategy="B", symbol="QQQM", qty=qty, trigger=250.0, limit=250.2, stop=249.0, target=252.0)


def mk():
    b = SimBroker()
    return b, OMS(b, sell_timeout_s=1.0, sleep=lambda s: None, unguarded=True)


def test_stop_placed_immediately_on_fill_and_resized_on_partial():
    b, oms = mk()
    p = plan()
    oms.place_entry(p)
    b.fill(p.entry_id, 250.05, qty=2)                       # partial
    oms.sync(p)
    assert b.get_order(p.stop_id).qty == 2
    b.fill(p.entry_id, 250.05, qty=2)
    oms.sync(p)
    assert p.state == "in_position" and b.get_order(p.stop_id).qty == 4
    assert sum(1 for o in b.open_orders() if o.side == "sell") == 1   # exactly one resting exit


def test_exit_cancels_stop_then_sells_and_never_double_sells():
    b, oms = mk()
    p = plan()
    oms.place_entry(p)
    b.fill(p.entry_id, 250.05)
    oms.sync(p)
    stop_id = p.stop_id

    def autofill_exit(order_id):  # the exit limit fills immediately
        b.fill(order_id, 251.9)

    orig_place = b.place

    def place_and_fill(o):
        r = orig_place(o)
        if o.client_order_id.startswith("wt-") and o.type == "limit":
            autofill_exit(o.client_order_id)
        return r
    b.place = place_and_fill
    assert oms.exit_now(p, 251.8, "target")
    assert b.get_order(stop_id).status.value == "canceled"
    assert b.positions() == [] and p.state == "closed"


def test_stop_already_filled_during_exit_means_no_sell():
    b, oms = mk()
    p = plan()
    oms.place_entry(p)
    b.fill(p.entry_id, 250.05)
    oms.sync(p)
    b.fill(p.stop_id, 249.0)                                # stop hits first
    assert oms.exit_now(p, 251.8, "target") is True
    assert p.exit_id == "" and b.positions() == []          # no sell order ever sent -> no accidental short


def test_unfilled_exit_restores_protective_stop():
    b, oms = mk()
    p = plan()
    oms.place_entry(p)
    b.fill(p.entry_id, 250.05)
    oms.sync(p)
    assert oms.exit_now(p, 260.0, "target") is False        # limit far away, never fills
    stops = [o for o in b.open_orders() if o.type == "stop"]
    assert len(stops) == 1 and stops[0].qty == 4 and p.state == "in_position"


def test_submit_timeout_resolved_by_id_lookup():
    b, oms = mk()
    p = plan()
    orig = b.place

    def place_then_timeout(o):
        orig(o)                                              # order reaches broker...
        raise TimeoutError("response lost")                  # ...but the response is lost
    b.place = place_then_timeout
    oms.place_entry(p)                                       # must NOT raise, must NOT duplicate
    assert len([o for o in b.orders.values() if o.side == "buy"]) == 1


def test_reconcile_places_missing_stop_and_cancels_strays():
    b, oms = mk()
    p = plan()
    oms.place_entry(p)
    b.fill(p.entry_id, 250.05)                               # filled while process was down: no stop yet
    stray = plan()
    stray.symbol = "XYZ"
    oms.place_entry(stray)
    acts = reconcile(b, known_symbols={"QQQM"}, stop_for={"QQQM": 249.0})
    assert any("placed missing stop QQQM" in a for a in acts)
    assert any("cancelled stray order" in a for a in acts)
    assert any(o.type == "stop" and o.symbol == "QQQM" for o in b.open_orders())


def test_reconcile_ignores_positions_outside_managed_symbols():
    b, oms = mk()
    b.pos["AAPL"] = __import__("wt.core.types", fromlist=["Position"]).Position("AAPL", 3, 150.0)
    acts = reconcile(b, known_symbols={"QQQM"}, stop_for={}, managed={"QQQM"})
    assert acts == []


def test_an_entry_without_a_pre_trade_guard_is_refused_and_nothing_reaches_the_broker():
    b = SimBroker()
    oms = OMS(b, sell_timeout_s=1.0, sleep=lambda s: None)          # a caller that forgot the guard
    p = plan()
    oms.place_entry(p)
    assert p.state == "aborted" and not b.open_orders()
    assert any(e[0] == "entry_blocked" and "no pre-trade guard" in e[1] for e in p.log)


def test_risk_reduction_never_waits_for_a_guard():
    b, oms = mk()
    p = plan()
    oms.place_entry(p)
    oms.unguarded = False                                               # from here on, no guard and no exemption
    b.fill(p.entry_id, 250.05)
    oms.sync(p)                                                         # the protective stop still goes in
    assert p.state == "in_position" and b.get_order(p.stop_id).type == "stop"


def test_a_position_read_lagging_the_fill_never_closes_the_plan_unprotected():
    """The entry reports FILLED while the position read still shows flat: no stop yet, so nothing could have sold
    the shares. The plan stays open and the next loop places the stop."""
    b, oms = mk()
    p = plan()
    oms.place_entry(p)
    b.fill(p.entry_id, 250.05)
    real = b.positions
    lag = [2]

    def lagging():
        if lag[0]:
            lag[0] -= 1
            return []
        return real()
    b.positions = lagging                                               # type: ignore[method-assign]
    oms.sync(p)
    assert p.state == "in_position" and not p.stop_id
    assert [e[0] for e in p.log].count("flat_read_before_stop") == 1
    oms.sync(p)                                                         # the position shows ...
    oms.reconcile({p.symbol}, {}, plan=p)                               # ... and the runner's reconcile protects it
    assert p.state == "in_position" and b.get_order(p.stop_id).qty == 4


def test_a_real_stop_out_still_closes_the_plan():
    b, oms = mk()
    p = plan()
    oms.place_entry(p)
    b.fill(p.entry_id, 250.05)
    oms.sync(p)
    b.fill(p.stop_id, 249.0)
    oms.sync(p)
    assert p.state == "closed" and p.exit_reason == "stop"


def test_the_stop_rests_before_the_runner_books_the_entry():
    """on_entry (the runner's bookkeeping: a quote read, the account file, a page that says the stop rests) runs
    only once the protective stop is at the broker."""
    b = SimBroker()
    seen = []
    oms = OMS(b, sell_timeout_s=1.0, sleep=lambda s: None, unguarded=True,
              on_entry=lambda p: seen.append([o.type for o in b.open_orders() if o.side == "sell"]))
    p = plan()
    oms.place_entry(p)
    b.fill(p.entry_id, 250.05)
    oms.sync(p)
    assert seen == [["stop"]]


def test_a_stop_out_while_the_entry_still_works_cancels_the_rest_of_the_entry():
    b, oms = mk()
    p = plan()
    oms.place_entry(p)
    b.fill(p.entry_id, 250.05, qty=2)                                   # partial: 2 of 4
    oms.sync(p)
    assert p.state == "entry_working" and b.get_order(p.stop_id).qty == 2
    b.fill(p.stop_id, 249.0)                                            # the stop sells the 2
    oms.sync(p)
    entry = b.get_order(p.entry_id)
    assert entry.status.terminal and entry.filled_qty == 2              # the rest never buys back below the stop
    assert p.state == "closed" and p.exit_reason == "stop"
    assert any(e[0] == "stopped_while_entry_working" for e in p.log)


def test_a_stop_id_whose_order_never_reached_the_broker_is_no_evidence_of_a_stop_out():
    """The stop's submit failed (it never reached the broker), so its id is set but nothing could sell the shares: a
    lagging flat read must not close the plan."""
    b, oms = mk()
    p = plan()
    oms.place_entry(p)
    b.fill(p.entry_id, 250.05)
    b.fail_next_place = True                                            # the stop never reaches the broker
    try:
        oms.sync(p)
    except Exception:                                                   # the runner journals a refused protect
        pass
    assert p.stop_id and b.get_order(p.stop_id) is None
    real = b.positions
    b.positions = lambda: []                                            # type: ignore[method-assign]
    oms.sync(p)
    assert p.state in ("entry_working", "in_position")
    b.positions = real                                                  # type: ignore[method-assign]
