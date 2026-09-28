"""Indicator helpers. Every function is causal: value at index i uses data <= i only."""
from __future__ import annotations

import numpy as np
import pandas as pd


def ema(x: np.ndarray, n: int) -> np.ndarray:
    a = 2 / (n + 1)
    out = np.empty(len(x))
    out[0] = x[0]
    for k in range(1, len(x)):
        out[k] = a * x[k] + (1 - a) * out[k - 1]
    return out


def rsi(close: np.ndarray, n: int = 14) -> np.ndarray:
    d = np.diff(close, prepend=close[0])
    up, dn = np.clip(d, 0, None), np.clip(-d, 0, None)
    au, ad = np.zeros(len(close)), np.zeros(len(close))
    for k in range(1, len(close)):
        au[k] = (au[k - 1] * (n - 1) + up[k]) / n
        ad[k] = (ad[k - 1] * (n - 1) + dn[k]) / n
    rs = np.divide(au, ad, out=np.full(len(close), np.inf), where=ad > 0)
    out = 100 - 100 / (1 + rs)
    out[:n] = 50.0
    return out


def bollinger(close: np.ndarray, n: int = 20, k: float = 2.0):
    s = pd.Series(close)
    mid = s.rolling(n, min_periods=n).mean().to_numpy()
    sd = s.rolling(n, min_periods=n).std(ddof=0).to_numpy()
    return mid - k * sd, mid, mid + k * sd


def session_vwap(bars: pd.DataFrame) -> np.ndarray:
    tp = (bars.h + bars.l + bars.c) / 3
    return (np.cumsum(tp * bars.v) / np.maximum(np.cumsum(bars.v), 1)).to_numpy()


def resample_5m(bars1: pd.DataFrame) -> tuple[pd.DataFrame, np.ndarray]:
    """5-min bars from 1-min regular-session bars + map: 1m index -> index of last COMPLETED 5m bar (-1 if none).
    5m bar k spans 1m indices [5k, 5k+4] and is complete at 1m index 5k+4."""
    n = len(bars1)
    g = np.arange(n) // 5
    b5 = bars1.groupby(g).agg(t=("t", "first"), o=("o", "first"), h=("h", "max"), l=("l", "min"),
                              c=("c", "last"), v=("v", "sum")).reset_index(drop=True)
    last_done = np.where((np.arange(n) % 5) == 4, np.arange(n) // 5, np.arange(n) // 5 - 1)
    return b5, last_done
