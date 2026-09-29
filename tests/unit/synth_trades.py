"""Synthetic one-trade bar paths through the real engine (shared by the DEC-0011 method tests)."""
import pandas as pd

from wt.backtest.engine import EntrySignal, simulate
from wt.backtest.management import M1HalfBreakeven


def path(kind: str, p: float, rps: float, vol: float = 1e6) -> pd.DataFrame:
    """Signal bar, entry bar (triggers at p), then a win (target 2R traded through), a stop, or a drift to the close."""
    tgt = p + 2 * rps
    rows = [[p - 0.02, p - 0.01, p - 0.03, p - 0.02, 1e6], [p - 0.01, p + 0.01, p - 0.02, p, vol]]
    if kind == "win":
        rows += [[p + rps, tgt + 0.05, p + 0.5 * rps, tgt, 1e6]] + [[tgt, tgt + 0.02, tgt - 0.02, tgt, 1e6]] * 3
    elif kind == "stop":
        rows += [[p - 0.2 * rps, p, p - 1.5 * rps, p - 1.2 * rps, 1e6]] + [[p - rps, p - rps, p - rps, p - rps, 1e6]] * 3
    else:
        rows += [[p + 0.1 * rps, p + 0.3 * rps, p - 0.1 * rps, p + 0.2 * rps, 1e6]] * 4
    df = pd.DataFrame(rows, columns=["o", "h", "l", "c", "v"])
    df.insert(0, "t", pd.date_range("2024-03-01 14:30", periods=len(df), freq="1min", tz="UTC"))
    return df


def sim(kind, p, rps, costs, mgmt=None, risk=6.0, cash=600.0, vol=1e6):
    b = path(kind, p, rps, vol)
    sig = EntrySignal(0, trigger=p, stop=p - rps, target=p + 2 * rps, setup="GG-2")
    return simulate(b, sig, mgmt or M1HalfBreakeven(), costs, "X", "2024-03-01", risk_dollars=risk, cash=cash,
                    max_notional=cash, flatten_idx=len(b) - 1, target_fill="through")
