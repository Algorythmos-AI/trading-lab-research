"""The registered gap exit, read live (wt.live.setups_live.wt_step), against the engine that defines it.

Each tape is run twice: through wt.backtest.engine.simulate with management.WT, and through a bar-by-bar walk that
only ever sees closed bars and asks `wt_step` what to do. The two must produce the same exits: time, shares, price
and reason. The walk fills as the engine fills (stop first, a target on a touch), so any difference is a difference
in the exit's decisions.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest
from spec_bars import minute_bars

from wt.backtest.engine import Costs, EntrySignal, simulate
from wt.backtest.management import REGISTRY
from wt.live import setups_live as sl

COSTS = Costs(slippage_per_share=0.01)


def walk(bars: pd.DataFrame, sig: EntrySignal, entry_i: int, entry: float, qty: int, flatten: int,
         bv_fail: bool = False, bv_i: int | None = None, slip: float = 0.01) -> list[tuple]:
    """The live reading: closed bars only, decisions from wt_step, fills as the engine makes them. `bv_i`: the bar
    at whose close the breakout-volume check is known (the entry bar when None). On that bar the engine asks the
    check before the target, so the walk takes no target there when the check failed."""
    o, h, low = (bars[k].to_numpy(float) for k in ("o", "h", "l"))
    s = sl.wt_start(entry, sig.stop, qty, bars.t.iloc[entry_i], sig.target, bv_fail=bv_fail,
                    bv_bar=None if bv_i is None else bars.t.iloc[bv_i])
    bv_at = entry_i if bv_i is None else bv_i
    pos, exits, pending = qty, [], None                      # pending: a market exit asked for at the last close
    for j in range(entry_i, len(bars)):
        if pending is not None:
            exits.append((bars.t.iloc[j], round(o[j] - slip, 6), pos, pending))
            return exits
        if j >= flatten:
            exits.append((bars.t.iloc[flatten], round(o[flatten] - slip, 6), pos, "eod_flatten"))
            return exits
        if low[j] <= s.stop:
            px = min(s.stop, o[j]) - slip if j > entry_i else s.stop - slip
            exits.append((bars.t.iloc[j], round(px, 6), pos, s.stop_reason))
            return exits
        seen = bars.iloc[: j + 1]
        if j > entry_i and not (s.bv_fail and j == bv_at) and not s.partial_done and h[j] >= s.t1:
            q = pos if s.qty0 < 2 else s.partial_qty
            exits.append((bars.t.iloc[j], round(max(s.t1, o[j]), 6), q, "target_all" if s.qty0 < 2 else "partial_t1"))
            pos -= q
            sl.wt_on_partial(s)
            if pos == 0:
                return exits
        for act in sl.wt_step(seen, s):
            if act.kind == "exit":
                pending = act.reason
    return exits


def engine(bars: pd.DataFrame, sig: EntrySignal, qty_risk: float, flatten: int):
    return simulate(bars, sig, REGISTRY["WT"](), COSTS, "ABC", "2024-03-01", risk_dollars=qty_risk, cash=1e9,
                    max_notional=1e9, flatten_idx=flatten)


def tape(seed: int, n: int = 240, drift: float = 0.0, vol: float = 0.05) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    px, rows = 10.0, []
    for _ in range(n):
        c = max(1.0, px + rng.normal(drift, vol))
        hi, lo = max(px, c) + abs(rng.normal(0, vol / 2)), min(px, c) - abs(rng.normal(0, vol / 2))
        rows.append((round(px, 2), round(hi, 2), round(lo, 2), round(c, 2), 500_000))
        px = c
    return minute_bars(rows)


def same(a: list[tuple], b: list[tuple]) -> bool:
    return len(a) == len(b) and all(x[0] == y[0] and x[2] == y[2] and x[3] == y[3] and abs(float(x[1]) - float(y[1])) < 1e-6
                                    for x, y in zip(a, b, strict=True))


@pytest.mark.parametrize("drift", [-0.004, 0.0, 0.004, 0.012])
def test_the_live_exit_makes_the_engines_exits_on_many_tapes(drift):
    checked, reasons = 0, set()
    for seed in range(120):
        bars = tape(seed, drift=drift)
        trigger = round(float(bars.c.iloc[5]) + 0.02, 2)
        sig = EntrySignal(5, trigger, round(trigger - 0.20, 2), None, "GG-1", meta={"strict_collar": True})
        for risk in (1.0, 0.3, 4.0):                          # 5 shares, 1 share, 20 shares at 20 cents of risk
            tr = engine(bars, sig, risk, flatten=230)
            if tr is None:
                continue
            entry_i = int(np.nonzero(pd.to_datetime(bars.t, utc=True) == tr.entry_time)[0][0])
            mine = walk(bars, sig, entry_i, tr.entry, tr.qty, flatten=230)
            assert same(mine, tr.exits), (seed, risk, mine, tr.exits)
            checked += 1
            reasons |= {e[3] for e in tr.exits}
    assert checked > 100
    assert reasons <= {"stop", "partial_t1", "target_all", "time_stop_5m", "runner_prior_5m_low",
                       "runner_5m_close_below_ema9", "eod_flatten"}


def test_between_them_the_tapes_reach_every_branch_of_the_exit():
    seen = set()
    for drift in (-0.004, 0.0, 0.004, 0.012):
        for seed in range(120):
            bars = tape(seed, drift=drift)
            trigger = round(float(bars.c.iloc[5]) + 0.02, 2)
            sig = EntrySignal(5, trigger, round(trigger - 0.20, 2), None, "GG-1", meta={"strict_collar": True})
            for risk in (1.0, 0.3):
                tr = engine(bars, sig, risk, flatten=230)
                if tr is not None:
                    seen |= {e[3] for e in tr.exits}
    assert {"stop", "partial_t1", "target_all", "time_stop_5m", "runner_prior_5m_low",
            "runner_5m_close_below_ema9"} <= seen


def test_a_setups_own_target_is_used_when_it_is_above_the_entry():
    s = sl.wt_start(10.03, 9.83, 6, pd.Timestamp("2024-03-01 09:35", tz="America/New_York"), 10.60)
    assert s.t1 == 10.60 and s.partial_qty == 3 and s.t1_price == 10.60
    s = sl.wt_start(10.03, 9.83, 6, pd.Timestamp("2024-03-01 09:35", tz="America/New_York"), 10.00)
    assert s.t1 == pytest.approx(10.43)                       # under the fill: 2R above it instead
    assert sl.wt_start(10.03, 9.83, 1, pd.Timestamp("2024-03-01 09:35", tz="America/New_York"), None).partial_qty == 1


def test_the_first_target_moves_the_stop_to_breakeven_and_never_down():
    s = sl.wt_start(10.03, 9.83, 6, pd.Timestamp("2024-03-01 09:35", tz="America/New_York"), None)
    act = sl.wt_on_partial(s)
    assert (act.kind, act.reason, act.price) == ("stop", "breakeven", 10.03) and s.partial_done
    s.stop = 10.50
    assert sl.wt_on_partial(s).price == 10.50


def test_a_failed_breakout_bar_exits_at_the_next_open_and_only_then():
    bars = tape(3)
    t = bars.t.iloc[10]
    s = sl.wt_start(10.0, 9.8, 4, t, None, bv_fail=True)
    assert sl.wt_step(bars.iloc[:10], s) == []                                    # the entry bar has not closed
    assert [a.reason for a in sl.wt_step(bars.iloc[:11], s)] == ["breakout_volume_fail"]
    ok = sl.wt_start(10.0, 9.8, 4, t, None)
    assert sl.wt_step(bars.iloc[:11], ok) == []
