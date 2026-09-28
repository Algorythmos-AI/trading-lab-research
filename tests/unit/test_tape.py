"""Tape proxies (TAP-01..06) on synthetic ticks: quote rule, tick rule, surge and freeze ratios, 10-second bars."""
import numpy as np
import pandas as pd

from wt.data.tape import classify_sides, features, ten_second_bars

T0 = pd.Timestamp("2024-03-01 14:40:00", tz="UTC")


def sec(s):
    return T0 + pd.Timedelta(seconds=s)


def test_quote_rule_then_tick_rule():
    quotes = pd.DataFrame({"t": [sec(0)], "bid": [5.00], "ask": [5.02]})
    trades = pd.DataFrame({"t": [sec(1), sec(2), sec(3), sec(4)], "price": [5.02, 5.00, 5.015, 5.01], "size": [100] * 4})
    assert list(classify_sides(trades, quotes)) == [1, -1, 1, -1]       # ask=buy, bid=sell, inside: up-tick buy, down-tick sell


def test_surge_speed_and_freeze():
    quotes = pd.DataFrame({"t": [sec(-400)], "bid": [4.99], "ask": [5.00], "bid_size": [100], "ask_size": [5000]})
    slow = [(sec(-360 + 30 * k), 4.99, 100) for k in range(10)]            # 10 sells over the prior 5 minutes
    fast = [(sec(-59 + k), 5.00, 500) for k in range(59)]                   # 59 buys at the ask in the last minute
    after = [(sec(5), 5.02, 100)]                                            # tape nearly freezes after entry
    trades = pd.DataFrame(slow + fast + after, columns=["t", "price", "size"])
    f = features(trades, quotes, trigger_time=sec(0), level=5.00, entry_time=sec(1))
    assert f["tape_speed_ratio"] > 20 and f["buy_initiated_share"] == 1.0
    assert f["post_entry_freeze"] < 0.05


def test_ten_second_bars():
    trades = pd.DataFrame({"t": [sec(0), sec(3), sec(11), sec(19)], "price": [5.0, 5.1, 5.05, 5.2], "size": [1, 2, 3, 4]})
    b = ten_second_bars(trades)
    assert len(b) == 2 and list(b.h) == [5.1, 5.2] and list(b.v) == [3, 7]
