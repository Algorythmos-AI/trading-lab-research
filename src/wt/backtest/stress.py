"""Per-fill cost stress and realised dollars for recorded trades (DEC-0011 M-FILL, M-STAT).

The recorded r3_eval stress subtracts (m - 1) x 2 x slip / risk from R: one entry and one full exit. Per share that
already covers partial exits (their sizes add up to the position), but it leaves out what is charged per ORDER or per
share sold (a commission for every fill, sell fees), and stops, which fire into fast tape, get no stress of their own.
Here every fill is re-priced and the P&L recomputed by Trade.pnl, so each partial exit is its own order.

Trade rows carry their fills only when a driver ran with a non-legacy method (detail()); recorded rows keep their
shape.
"""
from __future__ import annotations

from dataclasses import asdict, replace

import numpy as np
import pandas as pd

from wt.backtest.engine import Costs, Trade


def stressed_pnl(tr: Trade, costs: Costs, cost_mult: float = 1.0, stop_mult: float = 1.0,
                 slip_limits: bool = True) -> float:
    """P&L of a simulated trade with every fill re-priced.

    costs: the model the trade was simulated with. Each fill pays (cost_mult - 1) x its slippage more: the entry,
    each partial exit and the final exit. Limit fills paid no slippage in the simulation; slip_limits=True charges
    them too (a stressed target may need a marketable order), so this stress is never milder than the recorded one.
    Stop fills pay cost_mult x stop_mult x the stop slippage. Commissions and fees scale by cost_mult (Trade.pnl).
    cost_mult = stop_mult = 1 returns Trade.pnl(costs) exactly; with slip_limits=False the result equals re-simulating
    at Costs(cost_multiplier=cost_mult, stop_slip_multiplier=stop_mult) on any path where the entry collar does not
    bind and no stop level depends on the entry price (a breakeven stop moves with a stressed entry)."""
    if len(tr.exit_kinds) != len(tr.exits):
        raise ValueError("trade carries no per-fill kinds (simulated before exit_kinds existed)")
    slip, stop_slip = costs.slip(), costs.stop_slip()
    extra = slip * (cost_mult - 1)
    exits = []
    for (t, p, q, why), kind in zip(tr.exits, tr.exit_kinds, strict=True):
        if kind == "stop":
            d = stop_slip * (cost_mult * stop_mult - 1)
        elif kind == "limit" and not slip_limits:
            d = 0.0
        else:
            d = extra
        exits.append((t, p - d, q, why))
    moved = replace(tr, entry=tr.entry + extra, exits=exits)
    return moved.pnl(replace(costs, cost_multiplier=costs.cost_multiplier * cost_mult))


def detail(tr: Trade, costs: Costs) -> dict:
    """Row fields for per-fill evaluation: realised P&L, actual risk, every fill with its kind, the cost model."""
    return {"entry": tr.entry, "stop0": tr.stop0, "qty": tr.qty, "pnl": tr.pnl(costs),
            "risk_usd": tr.risk_per_share * tr.qty,
            "fills": [[str(t), float(p), int(q), why, kind]
                      for (t, p, q, why), kind in zip(tr.exits, tr.exit_kinds, strict=True)],
            "costs": asdict(costs)}


def trade_from_row(row: dict) -> tuple[Trade, Costs]:
    fills = row.get("fills")
    if not isinstance(fills, list) or not isinstance(row.get("costs"), dict):
        raise ValueError("trade row has no per-fill detail: re-run its driver with a non-legacy --method")
    tr = Trade(str(row.get("symbol", "")), str(row.get("date", "")), "", "", pd.NaT, float(row["entry"]),
               float(row["stop0"]), int(row["qty"]), exits=[(f[0], float(f[1]), int(f[2]), f[3]) for f in fills],
               exit_kinds=[f[4] for f in fills])
    return tr, Costs(**row["costs"])


def stressed_R(rows: pd.DataFrame, cost_mult: float = 1.0, stop_mult: float = 1.0) -> np.ndarray:
    """R of each row with every fill stressed; (1, 1) reproduces the rows' R."""
    out = []
    for row in rows.to_dict("records"):
        tr, costs = trade_from_row(row)
        risk = tr.risk_per_share * tr.qty
        out.append(stressed_pnl(tr, costs, cost_mult, stop_mult) / risk if risk > 0 else 0.0)
    return np.array(out, dtype=float)


def realised_usd(rows: pd.DataFrame) -> float:
    """Dollars the trades made: Trade.pnl when rows carry it, else R x ACTUAL risk ((entry - stop0) x qty), the same
    number. Never R x nominal risk, which integer-share sizing and the cash cap undershoot."""
    if not len(rows):
        return 0.0
    if "pnl" in rows and rows.pnl.notna().all():
        return float(rows.pnl.sum())
    return float((rows.R * (rows.entry - rows.stop0) * rows.qty).sum())
