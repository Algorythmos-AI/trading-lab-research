"""Performance statistics with the plan's G1 gate metrics."""
from __future__ import annotations

import math

import numpy as np
from scipy import stats as st


def summarize(r: np.ndarray, seed: int = 7, n_boot: int = 5000) -> dict:
    r = np.asarray(r, dtype=float)
    n = len(r)
    if n == 0:
        return {"n": 0}
    wins, losses = r[r > 0], r[r <= 0]
    rng = np.random.default_rng(seed)
    boots = rng.choice(r, size=(n_boot, n), replace=True).mean(axis=1)
    eq = np.cumsum(r)
    dd = float((eq - np.maximum.accumulate(np.r_[0, eq])[1:]).min()) if n else 0.0
    sharpe = float(r.mean() / r.std(ddof=1)) if n > 1 and r.std(ddof=1) > 0 else 0.0
    return {
        "n": n, "expectancy_R": float(r.mean()), "win_rate": float((r > 0).mean()),
        "avg_win_R": float(wins.mean()) if len(wins) else 0.0, "avg_loss_R": float(losses.mean()) if len(losses) else 0.0,
        "profit_factor": float(wins.sum() / -losses.sum()) if losses.sum() < 0 else math.inf,
        "ci95_expectancy": [float(np.percentile(boots, 2.5)), float(np.percentile(boots, 97.5))],
        "max_drawdown_R": dd, "per_trade_sharpe": sharpe,
        "skew": float(st.skew(r)) if n > 2 else 0.0, "kurtosis": float(st.kurtosis(r, fisher=False)) if n > 3 else 3.0,
    }


def deflated_sharpe_prob(sr: float, n: int, n_trials: int, skew: float, kurt: float, sr_var_trials: float = None) -> float:
    """Bailey & Lopez de Prado (2014) Deflated Sharpe Ratio probability (per-trade Sharpe)."""
    if n < 3 or n_trials < 1:
        return 0.0
    emc = 0.5772156649
    v = sr_var_trials if sr_var_trials else 1.0 / n
    sr0 = math.sqrt(v) * ((1 - emc) * st.norm.ppf(1 - 1 / n_trials) + emc * st.norm.ppf(1 - 1 / (n_trials * math.e))) if n_trials > 1 else 0.0
    denom = math.sqrt(max(1e-12, 1 - skew * sr + (kurt - 1) / 4 * sr ** 2))
    return float(st.norm.cdf((sr - sr0) * math.sqrt(n - 1) / denom))


def random_control_pvalue(real_mean: float, control_means: np.ndarray) -> float:
    return float((1 + (control_means >= real_mean).sum()) / (1 + len(control_means)))
