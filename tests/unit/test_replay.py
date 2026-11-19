"""wt.live.replay: recorded data is served only as of the clock, and resting orders fill by the engine's rules."""
from __future__ import annotations

import datetime as dt

import pandas as pd
import pytest

from wt.brokers.base import TransportError
from wt.core.clock import ET
from wt.core.types import Order, OrderStatus
from wt.data.feeds import FeedNotNamed
from wt.live.replay import BarFillBroker, ReplayClock, ReplayCrash, ReplayREST, Tape

DAY = dt.date(2026, 10, 1)
SESSIONS = {DAY: ("09:30", "16:00")}
BARS_URL = "https://data.alpaca.markets/v2/stocks/bars"
QUOTE_URL = "https://data.alpaca.markets/v2/stocks/quotes/latest"


def at(h: int, m: int, s: int = 0) -> dt.datetime:
    return dt.datetime.combine(DAY, dt.time(h, m, s), tzinfo=ET)


def bars(rows: list[tuple[str, float, float, float, float, float]]) -> pd.DataFrame:
    """rows: (HH:MM, o, h, l, c, v)"""
    return pd.DataFrame([{"t": at(*map(int, hm.split(":"))).astimezone(dt.UTC), "o": o, "h": h, "l": lo, "c": c, "v": v}
                         for hm, o, h, lo, c, v in rows])


def rig(rows, quotes=None, start=(9, 30), **kw):
    tape = Tape({"ABC": bars(rows)}, {"ABC": quotes} if quotes is not None else {})
    clock = ReplayClock(at(*start))
    return clock, tape, BarFillBroker(clock, tape, SESSIONS, **kw)


def buy_stop_limit(cid="e1", qty=10, stop=10.00, limit=10.05) -> Order:
    return Order(cid, "ABC", "buy", qty, "stop_limit", limit_price=limit, stop_price=stop)


def test_a_bar_is_visible_only_after_its_minute_has_ended():
    clock, tape, _ = rig([("09:30", 10, 10.1, 9.9, 10.0, 5000), ("09:31", 10, 10.2, 10.0, 10.1, 5000)])
    rest = ReplayREST(clock, tape, SESSIONS)
    ask = {"symbols": "ABC", "timeframe": "1Min", "feed": "sip", "start": at(9, 30).isoformat()}
    assert rest.get(BARS_URL, ask)["bars"]["ABC"] == []
    clock.sleep(59)
    assert rest.get(BARS_URL, ask)["bars"]["ABC"] == []                 # 09:30:59: the first minute is still forming
    clock.sleep(1)
    assert [b["c"] for b in rest.get(BARS_URL, ask)["bars"]["ABC"]] == [10.0]
    clock.sleep(60)
    assert [b["c"] for b in rest.get(BARS_URL, ask)["bars"]["ABC"]] == [10.0, 10.1]


def test_a_quote_is_the_last_one_at_or_before_now_and_never_made_up():
    q = pd.DataFrame({"t": [at(9, 30, 10).astimezone(dt.UTC), at(9, 31, 5).astimezone(dt.UTC)],
                      "bp": [9.98, 10.08], "ap": [10.00, 10.11]})
    clock, tape, _ = rig([("09:30", 10, 10.1, 9.9, 10.0, 5000)], quotes=q)
    rest = ReplayREST(clock, tape, SESSIONS)
    ask = {"symbols": "ABC,XYZ", "feed": "sip"}
    assert rest.get(QUOTE_URL, ask)["quotes"] == {}                     # before the first quote: none, for either name
    clock.sleep(30)
    assert rest.get(QUOTE_URL, ask)["quotes"]["ABC"]["ap"] == 10.00
    clock.sleep(40)
    got = rest.get(QUOTE_URL, ask)["quotes"]
    assert got["ABC"]["bp"] == 10.08 and "XYZ" not in got


def test_a_request_without_a_feed_is_refused_like_the_real_client():
    clock, tape, _ = rig([("09:30", 10, 10.1, 9.9, 10.0, 5000)])
    rest = ReplayREST(clock, tape, SESSIONS)
    with pytest.raises(FeedNotNamed):
        rest.get(BARS_URL, {"symbols": "ABC", "timeframe": "1Min", "start": at(9, 30).isoformat()})
    with pytest.raises(FeedNotNamed):
        rest.bars(["ABC"], "1Min", at(9, 30), at(9, 40))


def test_historical_bars_never_reach_past_the_clock():
    clock, tape, _ = rig([("09:30", 10, 10.1, 9.9, 10.0, 5000), ("09:31", 10, 10.2, 10.0, 10.1, 5000),
                          ("09:32", 10, 10.3, 10.0, 10.2, 5000)], start=(9, 32))
    rest = ReplayREST(clock, tape, SESSIONS)
    got = rest.bars(["ABC"], "1Min", at(9, 30), at(9, 59), feed="sip")
    assert list(got.c) == [10.0, 10.1]                                  # 09:32 is still forming at 09:32:00


def test_the_calendar_carries_a_half_day_close():
    clock, tape, _ = rig([("09:30", 10, 10.1, 9.9, 10.0, 5000)])
    half = dt.date(2026, 11, 27)
    rest = ReplayREST(clock, tape, {DAY: ("09:30", "16:00"), half: ("09:30", "13:00")})
    cal = rest.calendar("2026-10-01", "2026-12-01")
    assert list(cal.close) == ["16:00", "13:00"] and list(cal.date) == [DAY, half]


def test_stop_limit_entry_fills_at_the_trigger_plus_slippage():
    clock, _, b = rig([("09:30", 9.90, 9.95, 9.85, 9.90, 5000), ("09:31", 9.95, 10.20, 9.94, 10.15, 5000)])
    b.place(buy_stop_limit())
    clock.sleep(60)                                                     # 09:30 closed: high 9.95 never reached 10.00
    assert b.get_order("e1").filled_qty == 0
    clock.sleep(60)
    o = b.get_order("e1")
    assert o.status is OrderStatus.FILLED and o.avg_fill_price == pytest.approx(10.01)
    assert b.fills[0].rule == "stop_limit" and b.pos["ABC"].qty == 10


def test_an_open_above_the_collar_does_not_fill_then_fills_when_price_returns():
    clock, _, b = rig([("09:30", 10.20, 10.30, 10.10, 10.25, 5000),     # opens above the 10.05 limit: triggered, no fill
                       ("09:31", 10.25, 10.30, 10.04, 10.10, 5000)])    # trades back to the limit: fills at the limit
    b.place(buy_stop_limit())
    clock.sleep(60)
    assert b.get_order("e1").filled_qty == 0
    clock.sleep(60)
    o = b.get_order("e1")
    assert o.status is OrderStatus.FILLED and o.avg_fill_price == pytest.approx(10.05)
    assert b.fills[0].rule == "stop_limit_resting"


def test_an_entry_never_fills_above_its_limit():
    clock, _, b = rig([("09:30", 10.049, 10.20, 10.00, 10.10, 5000)])   # max(stop, open) + slip = 10.059 > limit
    b.place(buy_stop_limit())
    clock.sleep(60)
    assert b.get_order("e1").avg_fill_price == pytest.approx(10.05)


def test_a_buy_takes_at_most_a_tenth_of_the_bar_and_the_rest_keeps_working():
    clock, _, b = rig([("09:30", 10.00, 10.03, 9.99, 10.02, 40), ("09:31", 10.02, 10.04, 10.00, 10.03, 5000)])
    b.place(buy_stop_limit())
    clock.sleep(60)
    o = b.get_order("e1")
    assert o.status is OrderStatus.PARTIAL and o.filled_qty == 4
    clock.sleep(60)
    assert b.get_order("e1").status is OrderStatus.FILLED


def test_a_protective_stop_fills_at_the_stop_or_the_open_whichever_is_lower():
    clock, _, b = rig([("09:30", 10.00, 10.03, 9.99, 10.02, 5000), ("09:31", 10.02, 10.03, 10.00, 10.01, 5000),
                       ("09:32", 9.70, 9.75, 9.60, 9.65, 5000)])         # gaps down through the 9.80 stop
    b.place(buy_stop_limit())
    clock.sleep(60)
    b.place(Order("s1", "ABC", "sell", 10, "stop", stop_price=9.80, tif="gtc"))
    clock.sleep(60)
    assert b.get_order("s1").filled_qty == 0
    clock.sleep(60)
    s = b.get_order("s1")
    assert s.status is OrderStatus.FILLED and s.avg_fill_price == pytest.approx(9.69)
    assert b.pos["ABC"].qty == 0


def test_a_stop_inside_the_entry_bars_range_fills_on_the_entry_bar():
    clock, _, b = rig([("09:30", 9.95, 10.10, 9.78, 9.90, 5000), ("09:31", 9.90, 9.95, 9.85, 9.90, 5000)])
    b.place(buy_stop_limit())
    clock.sleep(60)                                                     # the entry fills on 09:30, whose low is 9.78
    b.place(Order("s1", "ABC", "sell", 10, "stop", stop_price=9.80, tif="gtc"))
    s = b.get_order("s1")
    assert s.status is OrderStatus.FILLED and s.avg_fill_price == pytest.approx(9.79)
    assert b.fills[-1].rule == "stop_on_entry_bar"


def test_the_stop_goes_before_the_target_when_one_bar_touches_both():
    clock, _, b = rig([("09:30", 10.00, 10.03, 9.99, 10.02, 5000), ("09:31", 10.02, 10.50, 9.75, 10.00, 5000)])
    b.place(buy_stop_limit())
    clock.sleep(60)
    b.place(Order("s1", "ABC", "sell", 10, "stop", stop_price=9.80, tif="gtc"))
    b.place(Order("t1", "ABC", "sell", 10, "limit", limit_price=10.40))
    clock.sleep(60)
    assert b.get_order("s1").status is OrderStatus.FILLED
    assert b.get_order("t1").filled_qty == 0 and b.pos["ABC"].qty == 0   # the target never sells a flat book short


@pytest.mark.parametrize("mode, high, filled", [("touch", 10.40, True), ("through", 10.40, False),
                                                ("through", 10.41, True)])
def test_a_target_fills_on_a_touch_or_only_on_a_trade_through(mode, high, filled):
    clock, _, b = rig([("09:30", 10.00, 10.03, 9.99, 10.02, 5000), ("09:31", 10.02, high, 10.00, 10.30, 5000)],
                      target_fill=mode)
    b.place(buy_stop_limit())
    clock.sleep(60)
    b.place(Order("t1", "ABC", "sell", 10, "limit", limit_price=10.40))
    clock.sleep(60)
    assert (b.get_order("t1").status is OrderStatus.FILLED) is filled


def test_a_market_exit_fills_at_the_next_bars_open():
    clock, _, b = rig([("09:30", 10.00, 10.03, 9.99, 10.02, 5000), ("09:31", 10.02, 10.10, 10.00, 10.05, 5000),
                       ("09:32", 10.07, 10.10, 10.00, 10.05, 5000)])
    b.place(buy_stop_limit())
    clock.sleep(60)
    clock.sleep(20)                                                     # 09:31:20, inside the 09:31 bar
    b.place(Order("m1", "ABC", "sell", 10, "market"))
    clock.sleep(40)                                                     # 09:31 closes: it had opened before the order
    assert b.get_order("m1").filled_qty == 0
    clock.sleep(60)
    assert b.get_order("m1").avg_fill_price == pytest.approx(10.06)


def test_an_order_placed_after_a_bar_closed_cannot_fill_on_it():
    clock, _, b = rig([("09:30", 9.95, 10.20, 9.90, 10.10, 5000), ("09:31", 9.90, 9.95, 9.85, 9.90, 5000)])
    clock.sleep(60)                                                     # 09:31:00: the 09:30 bar, high 10.20, is history
    b.place(buy_stop_limit())
    clock.sleep(60)
    assert b.get_order("e1").filled_qty == 0 and not b.fills


def test_a_lost_response_order_still_fills_and_a_refused_one_never_exists():
    clock, _, b = rig([("09:30", 9.95, 10.20, 9.94, 10.10, 5000)])
    b.lose_next_response = True
    with pytest.raises(TransportError):
        b.place(buy_stop_limit())
    b.fail_next_place = True
    with pytest.raises(TimeoutError):
        b.place(buy_stop_limit("e2"))
    clock.sleep(60)
    assert b.get_order("e1").status is OrderStatus.FILLED and b.get_order("e2") is None


def quotes(rows: list[tuple[tuple[int, int, int], float, float]]) -> pd.DataFrame:
    return pd.DataFrame({"t": [at(*hms).astimezone(dt.UTC) for hms, _, _ in rows],
                         "bp": [b for _, b, _ in rows], "ap": [a for _, _, a in rows]})


def test_a_marketable_exit_fills_at_once_at_the_bid():
    q = quotes([((9, 31, 10), 10.30, 10.32)])
    clock, _, b = rig([("09:30", 10.00, 10.03, 9.99, 10.02, 5000), ("09:31", 10.02, 10.35, 10.00, 10.30, 5000)], quotes=q)
    b.place(buy_stop_limit())
    clock.sleep(60)
    clock.sleep(20)                                                     # 09:31:20, bid 10.30
    b.place(Order("t1", "ABC", "sell", 4, "limit", limit_price=10.25))  # at or under the bid: sells at the bid
    assert b.get_order("t1").avg_fill_price == pytest.approx(10.30) and b.fills[-1].rule == "marketable_limit"
    b.place(Order("t2", "ABC", "sell", 3, "limit", limit_price=10.40))  # above the bid: rests
    assert b.get_order("t2").filled_qty == 0
    b.place(Order("m1", "ABC", "sell", 3, "market"))
    assert b.get_order("m1").avg_fill_price == pytest.approx(10.29) and b.pos["ABC"].qty == 3


def test_a_stale_quote_never_fills_an_order_on_placement():
    q = quotes([((9, 30, 5), 10.00, 10.02)])
    clock, _, b = rig([("09:30", 10.00, 10.03, 9.99, 10.02, 5000), ("09:31", 10.02, 10.10, 10.00, 10.05, 5000),
                       ("09:32", 10.07, 10.10, 10.00, 10.05, 5000)], quotes=q, quote_fill_age_s=30)
    b.place(buy_stop_limit())
    clock.sleep(80)                                                     # 09:31:20, the only quote is 75 s old
    b.place(Order("m1", "ABC", "sell", 10, "market"))
    assert b.get_order("m1").filled_qty == 0
    clock.sleep(100)
    assert b.get_order("m1").avg_fill_price == pytest.approx(10.06)     # the bar rule: next bar's open less slippage


def test_a_sell_never_fills_against_a_flat_book_on_placement():
    q = quotes([((9, 30, 5), 10.00, 10.02)])
    _, _, b = rig([("09:30", 10.00, 10.03, 9.99, 10.02, 5000)], quotes=q, start=(9, 30, 10))
    b.place(Order("m1", "ABC", "sell", 10, "market"))
    assert b.get_order("m1").filled_qty == 0 and "ABC" not in b.pos


def test_the_brokers_clock_follows_the_replay_clock():
    clock, _, b = rig([("09:30", 10, 10.1, 9.9, 10.0, 5000)], start=(9, 0))
    c = b.clock()
    assert not c.is_open and c.next_open == at(9, 30) and c.next_close == at(16, 0)
    clock.sleep(45 * 60)
    assert b.clock().is_open and b.clock().timestamp == at(9, 45)


def test_a_replayed_crash_is_not_an_ordinary_exception():
    clock = ReplayClock(at(9, 30), crash_at=at(9, 31))
    with pytest.raises(ReplayCrash):
        try:
            clock.sleep(120)
        except Exception:                                               # a runner's blanket handler must not catch it
            pytest.fail("the crash was swallowed")
