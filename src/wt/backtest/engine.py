"""Intraday trade simulator on 1-minute bars (long only).

Conservative fill rules (plan: Research protocol / Fills):
  * Signals are evaluated on CLOSED bars; orders act from the NEXT bar (no look-ahead).
  * Entry = stop-limit: triggers when bar.high >= trigger; fill = max(trigger, bar.open) + slippage;
    no fill if bar.open > limit (price gapped past the collar).
  * Stop exit: bar.low <= stop -> fill = min(stop, bar.open) - slippage.
  * Limit target: bar.high >= target -> fill = max(target, bar.open)... capped at bar.high.
  * Same bar touches stop AND target -> STOP first (pessimistic).
  * Fill size capped at max_bar_volume_frac of the bar's volume.
  * Flatten at flatten_time (close - 10 min default) at bar open - slippage.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import pandas as pd


@dataclass
class EntrySignal:
    bar_index: int          # index of the CLOSED bar that produced the signal
    trigger: float          # stop-entry trigger price
    stop: float             # initial protective stop
    target: float | None    # first target (None = management decides)
    setup: str
    meta: dict = field(default_factory=dict)


@dataclass
class Costs:
    slippage_per_share: float = 0.01
    commission_per_order: float = 0.0
    fee_per_share_sell: float = 0.000166   # FINRA TAF-like, parameterised (confirm Webull AU schedule in Phase 0)
    sec_fee_rate_sell: float = 0.0000278   # SEC fee on sell notional (parameterised)
    collar_frac_of_R: float = 0.10         # stop-limit collar as fraction of initial risk
    cost_multiplier: float = 1.0           # 1.5x / 2x stress tests

    def slip(self) -> float:
        return self.slippage_per_share * self.cost_multiplier


@dataclass
class Trade:
    symbol: str
    date: str
    setup: str
    management: str
    entry_time: pd.Timestamp
    entry: float
    stop0: float
    qty: int
    exits: list = field(default_factory=list)   # (time, price, qty, reason)
    mfe: float = 0.0
    mae: float = 0.0

    @property
    def risk_per_share(self) -> float:
        return self.entry - self.stop0

    def pnl(self, costs: Costs) -> float:
        gross = sum((p - self.entry) * q for _, p, q, _ in self.exits)
        sells = sum(p * q for _, p, q, _ in self.exits)
        fees = (costs.commission_per_order * (1 + len(self.exits))
                + costs.fee_per_share_sell * self.qty + costs.sec_fee_rate_sell * sells) * costs.cost_multiplier
        return gross - fees

    def r_multiple(self, costs: Costs) -> float:
        risk = self.risk_per_share * self.qty
        return self.pnl(costs) / risk if risk > 0 else 0.0


def size_position(entry: float, stop: float, risk_dollars: float, cash: float, max_notional: float) -> int:
    per_share = entry - stop
    if per_share <= 0:
        return 0
    return int(max(0, math.floor(min(risk_dollars / per_share, cash / entry, max_notional / entry))))


def simulate(bars: pd.DataFrame, signal: EntrySignal, mgmt, costs: Costs, symbol: str, date: str,
             risk_dollars: float, cash: float, max_notional: float, flatten_idx: int,
             max_bar_volume_frac: float = 0.10) -> Trade | None:
    """bars: 1-min regular-session bars (columns t,o,h,l,c,v), integer-indexed 0..n-1."""
    o, h, l, c, v = (bars[k].to_numpy() for k in ("o", "h", "l", "c", "v"))
    R = signal.trigger - signal.stop
    if R <= 0:
        return None
    limit = signal.trigger + costs.collar_frac_of_R * R
    # ---- entry: from the bar after the signal, until flatten --------------------------------
    for i in range(signal.bar_index + 1, flatten_idx):
        if h[i] >= signal.trigger:
            if o[i] > limit:
                return None                      # gapped through collar -> no fill (same in live)
            fill = min(max(signal.trigger, o[i]) + costs.slip(), limit)
            qty = size_position(fill, signal.stop, risk_dollars, cash, max_notional)
            qty = min(qty, int(v[i] * max_bar_volume_frac))
            if qty < 1:
                return None
            tr = Trade(symbol, date, signal.setup, mgmt.name, bars.t.iloc[i], fill, signal.stop, qty)
            break
        if l[i] < signal.stop:                   # invalidated before trigger
            return None
    else:
        return None
    # ---- management loop ----------------------------------------------------------------------
    state = mgmt.init_state(tr, signal)
    pos = qty
    # entry bar: only the stop can hit after the fill (assume fill happened at trigger time)
    j = i
    while pos > 0:
        if j >= flatten_idx:
            px = o[flatten_idx] - costs.slip() if flatten_idx < len(o) else c[-1] - costs.slip()
            tr.exits.append((bars.t.iloc[min(flatten_idx, len(o) - 1)], px, pos, "eod_flatten"))
            break
        tr.mfe = max(tr.mfe, (h[j] - tr.entry) / tr.risk_per_share)
        tr.mae = min(tr.mae, (l[j] - tr.entry) / tr.risk_per_share)
        stop = state["stop"]
        if l[j] <= stop:                         # stop first (pessimistic)
            px = min(stop, o[j]) - costs.slip() if j > i else stop - costs.slip()
            tr.exits.append((bars.t.iloc[j], px, pos, state.get("stop_reason", "stop")))
            pos = 0
            break
        if j > i:                                # targets / rule exits only on bars after entry bar
            for (price, frac, reason) in mgmt.limit_exits(state):
                if pos > 0 and h[j] >= price:
                    q = pos if frac >= 1 else max(1, min(pos, round(qty * frac)))
                    tr.exits.append((bars.t.iloc[j], max(price, o[j]) if o[j] <= h[j] else price, q, reason))
                    pos -= q
                    mgmt.on_partial(state, reason)
            if pos > 0:
                act = mgmt.on_bar_close(state, bars, j, tr)
                if act == "exit_market" and j + 1 < len(o):
                    tr.exits.append((bars.t.iloc[j + 1], o[j + 1] - costs.slip(), pos, state.get("exit_reason", "rule")))
                    pos = 0
                    break
        j += 1
    return tr
