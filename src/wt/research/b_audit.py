"""Robot B audit diagnostics (EXP-0042, DEC-0061). Descriptive: no hypothesis, no trial, no market data.

Reads only committed evidence files and works out, for strategy B (QQQ signal, QQQM orders):
  * a reconciliation of the recorded figures (walk-forward 415 trades, DSR at 65 trials, the holdout summary);
  * the frozen rule's development record as a whole distribution, split by year, entry mark and exit;
  * what share of that record the paper runner can trade at all (no entry at or after 15:30 New York);
  * the deflated Sharpe at today's trial count and the probability of backtest overfitting (CSCV);
  * statistical power: how many trades the paper record needs to tell the claimed edge from zero;
  * the minimum track record length, and the boundaries of a sequential (SPRT) kill test, designed only.

Every function is pure: inputs in, numbers out. scripts/b_audit.py does the file reading and writing.
"""
from __future__ import annotations

import datetime as dt
import itertools
import math
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any
from zoneinfo import ZoneInfo

import numpy as np
from scipy import stats as st

from wt.backtest.stats import bootstrap_ci, deflated_sharpe_prob

ET = ZoneInfo("America/New_York")
LAST_RUNNER_ENTRY = dt.time(15, 30)     # runner_b.py: entries only while now < flatten (15:50) - 20 min on full days
EULER_GAMMA = 0.5772156649


@dataclass(frozen=True)
class Trade:
    date: dt.date
    r: float
    exit_reason: str
    mfe_r: float | None
    entry_et: dt.datetime | None


def parse_trades(rows: Iterable[Mapping[str, Any]]) -> list[Trade]:
    """Trades as stored in an experiment's results.json; entry_time is UTC there and is read in New York time."""
    out = []
    for row in rows:
        et = None
        if row.get("entry_time"):
            t = dt.datetime.fromisoformat(str(row["entry_time"]))
            if t.tzinfo is None:
                raise ValueError(f"entry_time without a time zone: {row['entry_time']!r}")
            et = t.astimezone(ET)
        mfe = row.get("mfe_R")
        out.append(Trade(dt.date.fromisoformat(str(row["date"])[:10]), float(row["R"]), str(row.get("exit_reason", "")),
                         None if mfe is None else float(mfe), et))
    return out


def in_span(trades: Sequence[Trade], start: dt.date, end: dt.date) -> list[Trade]:
    return [t for t in trades if start <= t.date <= end]


# ---------------------------------------------------------------- walk-forward (the recorded G1 selection, recomputed)

def folds(dev_start: dt.date, dev_end: dt.date) -> list[tuple[dt.date, dt.date, dt.date]]:
    """scripts/g1_eval.py folds: 12-month fit, 3-month test, first test window 2020-01-01."""
    out = []
    test_start = dt.date(2020, 1, 1)
    while test_start <= dev_end:
        fit_start = _add_months(test_start, -12)
        test_end = min(_add_months(test_start, 3) - dt.timedelta(days=1), dev_end)
        out.append((fit_start, test_start, test_end))
        test_start = _add_months(test_start, 3)
    return out


def _add_months(d: dt.date, months: int) -> dt.date:
    """pandas DateOffset(months=...) semantics: same day of month, clipped to the month's last day."""
    m = d.month - 1 + months
    y, mo = d.year + m // 12, m % 12 + 1
    last = (dt.date(y + mo // 12, mo % 12 + 1, 1) - dt.timedelta(days=1)).day
    return dt.date(y, mo, min(d.day, last))


def walk_forward(variants: Mapping[str, Sequence[Trade]], dev_start: dt.date, dev_end: dt.date,
                 min_fit: int = 20) -> tuple[list[Trade], list[tuple[str, str]]]:
    """Each fold picks the variant with the best fit-window mean R (at least `min_fit` fit trades; ties keep the
    first in input order, as g1_eval does) and pools that variant's trades in the test window."""
    pooled: list[Trade] = []
    picks: list[tuple[str, str]] = []
    spans = {k: in_span(v, dev_start, dev_end) for k, v in variants.items()}
    for fs, ts, te in folds(dev_start, dev_end):
        best, best_e = None, -9.0
        for name, tr in spans.items():
            fit = [t.r for t in tr if fs <= t.date < ts]
            if len(fit) >= min_fit and float(np.mean(fit)) > best_e:
                best, best_e = name, float(np.mean(fit))
        if best is not None:
            pooled += [t for t in spans[best] if ts <= t.date <= te]
            picks.append((ts.isoformat(), best))
    return pooled, picks


# ---------------------------------------------------------------- the distribution

def _drawdown(r: np.ndarray) -> tuple[float, int]:
    """Deepest peak-to-trough fall of cumulative R (starting from 0) and its length in trades, peak to trough."""
    eq = np.r_[0.0, np.cumsum(r)]
    peak_val, peak_i, worst, worst_len = 0.0, 0, 0.0, 0
    for i, v in enumerate(eq):
        if v > peak_val:
            peak_val, peak_i = float(v), i
        if v - peak_val < worst:
            worst, worst_len = float(v - peak_val), i - peak_i
    return worst, worst_len


def _longest_losing_run(r: np.ndarray) -> int:
    best = cur = 0
    for x in r:
        cur = cur + 1 if x <= 0 else 0
        best = max(best, cur)
    return best


def distribution(trades: Sequence[Trade], seed: int = 7, draws: int = 5000) -> dict[str, Any]:
    if not trades:
        return {"n": 0}
    r = np.array([t.r for t in trades], dtype=float)
    n = len(r)
    wins, losses = r[r > 0], r[r <= 0]
    sd = float(r.std(ddof=1)) if n > 1 else 0.0
    dd, dd_len = _drawdown(r)
    total = float(r.sum())
    top = np.sort(r)[::-1]
    out: dict[str, Any] = {
        "n": n, "expectancy_R": float(r.mean()), "sd_R": sd, "win_rate": float((r > 0).mean()),
        "avg_win_R": float(wins.mean()) if len(wins) else 0.0, "avg_loss_R": float(losses.mean()) if len(losses) else 0.0,
        "profit_factor": float(wins.sum() / -losses.sum()) if losses.sum() < 0 else None,
        "per_trade_sharpe": float(r.mean() / sd) if sd > 0 else 0.0,
        "skew": float(st.skew(r)) if n > 2 else 0.0, "kurtosis": float(st.kurtosis(r, fisher=False)) if n > 3 else 3.0,
        "total_R": total, "max_drawdown_R": dd, "max_drawdown_trades": dd_len, "longest_losing_run": _longest_losing_run(r),
        "top5_share_of_R": float(top[:5].sum() / total) if total > 0 else None,
        "top10_share_of_R": float(top[:10].sum() / total) if total > 0 else None,
        "expectancy_without_top10": float(top[10:].mean()) if n > 10 else None,
    }
    if n > 1:
        out["ci95_trade"] = bootstrap_ci(r, seed=seed, n_boot=draws, block="trade")
        out["ci95_day"] = bootstrap_ci(r, seed=seed, n_boot=draws, block="day", days=[t.date.isoformat() for t in trades])
    return out


def entry_mark(t: Trade) -> str | None:
    """The half-hour mark the entry filled in, New York time (e.g. '10:00' for a fill between 10:00 and 10:29)."""
    if t.entry_et is None:
        return None
    return f"{t.entry_et.hour:02d}:{0 if t.entry_et.minute < 30 else 30:02d}"


def runner_can_trade(t: Trade) -> bool | None:
    """False when the entry filled at or after 15:30 New York: the runner places no entry then on a full day.
    Half days (earlier cutoff) are not identified here; the report says so."""
    if t.entry_et is None:
        return None
    return t.entry_et.time() < LAST_RUNNER_ENTRY


def splits(trades: Sequence[Trade]) -> dict[str, dict[str, dict[str, float | int]]]:
    def agg(key: Any) -> dict[str, dict[str, float | int]]:
        groups: dict[str, list[float]] = {}
        for t in trades:
            k = key(t)
            groups.setdefault("unknown" if k is None else str(k), []).append(t.r)
        return {k: {"n": len(v), "expectancy_R": float(np.mean(v)), "sum_R": float(np.sum(v))}
                for k, v in sorted(groups.items())}
    return {"year": agg(lambda t: t.date.year), "entry_mark_et": agg(entry_mark), "exit_reason": agg(lambda t: t.exit_reason)}


def exit_quality(trades: Sequence[Trade], target_r: float = 2.0) -> dict[str, float | int | None]:
    with_mfe = [t for t in trades if t.mfe_r is not None]
    if not with_mfe:
        return {"n_with_mfe": 0}
    losers = [t for t in with_mfe if t.r <= 0]
    winners = [t for t in with_mfe if t.r > 0 and t.mfe_r and t.mfe_r > 0]
    return {
        "n_with_mfe": len(with_mfe),
        "share_reaching_target_mfe": float(np.mean([(t.mfe_r or 0) >= target_r for t in with_mfe])),
        "mean_mfe_R_of_losers": float(np.mean([t.mfe_r for t in losers])) if losers else None,
        "share_of_losers_that_were_1R_up": float(np.mean([(t.mfe_r or 0) >= 1.0 for t in losers])) if losers else None,
        "mean_R_over_mfe_of_winners": float(np.mean([t.r / (t.mfe_r or 1) for t in winners])) if winners else None,
    }


# ---------------------------------------------------------------- selection-bias statistics

def dsr(trades: Sequence[Trade], n_trials: int, sr_variance: float | None = None) -> float:
    r = np.array([t.r for t in trades], dtype=float)
    if len(r) < 3 or r.std(ddof=1) == 0:
        return 0.0
    sr = float(r.mean() / r.std(ddof=1))
    return deflated_sharpe_prob(sr, len(r), n_trials, float(st.skew(r)), float(st.kurtosis(r, fisher=False)),
                                sr_var_trials=sr_variance or 0.0)   # 0 -> the function uses 1/n


def sharpe_variance(variants: Mapping[str, Sequence[Trade]]) -> float:
    """Variance of the per-trade Sharpe across the evaluated configurations (DSR's V[SR_n])."""
    srs = []
    for tr in variants.values():
        r = np.array([t.r for t in tr], dtype=float)
        if len(r) > 1 and r.std(ddof=1) > 0:
            srs.append(r.mean() / r.std(ddof=1))
    return float(np.var(srs, ddof=1)) if len(srs) > 1 else 0.0


def daily_matrix(variants: Mapping[str, Sequence[Trade]]) -> tuple[list[str], list[dt.date], np.ndarray]:
    """Rows: every date on which any configuration traded; columns: configurations; cells: that day's summed R (0 when
    the configuration did not trade)."""
    names = list(variants)
    dates = sorted({t.date for tr in variants.values() for t in tr})
    idx = {d: i for i, d in enumerate(dates)}
    m = np.zeros((len(dates), len(names)))
    for j, name in enumerate(names):
        for t in variants[name]:
            m[idx[t.date], j] += t.r
    return names, dates, m


def pbo_cscv(m: np.ndarray, blocks: int = 16) -> dict[str, Any]:
    """Probability of backtest overfitting by combinatorially symmetric cross-validation (Bailey, Borwein, Lopez de
    Prado and Zhu, 2017). Rows are time, columns configurations; the metric is the mean row value. The rows are cut
    into `blocks` contiguous blocks (trailing remainder dropped); every half of the blocks is in turn the in-sample
    set. PBO is the share of splits in which the in-sample best ranks at or below the out-of-sample median."""
    t_rows, n_cfg = m.shape
    if blocks % 2 or blocks < 2:
        raise ValueError("blocks must be even and at least 2")
    if n_cfg < 2:
        raise ValueError("PBO needs at least two configurations")
    size = t_rows // blocks
    if size < 1:
        raise ValueError(f"{t_rows} rows cannot fill {blocks} blocks")
    parts = [m[i * size:(i + 1) * size] for i in range(blocks)]
    logits = []
    degradation = []
    for ins in itertools.combinations(range(blocks), blocks // 2):
        is_set = set(ins)
        is_rows = np.vstack([parts[i] for i in range(blocks) if i in is_set])
        oos_rows = np.vstack([parts[i] for i in range(blocks) if i not in is_set])
        is_perf, oos_perf = is_rows.mean(axis=0), oos_rows.mean(axis=0)
        best = int(np.argmax(is_perf))
        rank = float(st.rankdata(oos_perf, method="average")[best])      # 1 = worst out of sample
        omega = rank / (n_cfg + 1)
        logits.append(math.log(omega / (1 - omega)))
        degradation.append((float(is_perf[best]), float(oos_perf[best])))
    lam = np.array(logits)
    is_best, oos_best = np.array(degradation).T
    slope = float(np.polyfit(is_best, oos_best, 1)[0]) if np.ptp(is_best) > 0 else None
    return {"pbo": float((lam <= 0).mean()), "splits": len(lam), "configs": n_cfg, "rows_used": size * blocks,
            "rows_dropped": t_rows - size * blocks, "median_logit": float(np.median(lam)),
            "oos_mean_of_is_best": float(oos_best.mean()), "is_mean_of_is_best": float(is_best.mean()),
            "oos_on_is_slope": slope, "share_is_best_loses_oos": float((oos_best <= 0).mean())}


# ---------------------------------------------------------------- what the paper record can show

def trades_for_power(edge: float, sd: float, alpha: float = 0.05, power: float = 0.80) -> float:
    """Trades for a one-sided z-test of mean R > 0 to reach `power` when the true mean is `edge`."""
    if edge <= 0 or sd <= 0:
        return math.inf
    z = float(st.norm.ppf(1 - alpha) + st.norm.ppf(power))
    return (z * sd / edge) ** 2


def power_at(n: int, edge: float, sd: float, alpha: float = 0.05) -> float:
    if n < 1 or sd <= 0:
        return 0.0
    return float(st.norm.cdf(edge * math.sqrt(n) / sd - st.norm.ppf(1 - alpha)))


def min_track_record(sr: float, skew: float, kurt: float, sr_benchmark: float = 0.0, confidence: float = 0.95) -> float:
    """Minimum track record length in trades (Bailey and Lopez de Prado, 2012) for a per-trade Sharpe `sr`."""
    if sr <= sr_benchmark:
        return math.inf
    z = float(st.norm.ppf(confidence))
    return 1 + (1 - skew * sr + (kurt - 1) / 4 * sr ** 2) * (z / (sr - sr_benchmark)) ** 2


def sprt_design(h1_mean: float, sd: float, alpha: float = 0.05, beta: float = 0.20, h0_mean: float = 0.0) -> dict[str, float]:
    """Wald's SPRT for a normal mean with known sd, written on cumulative R so it reads beside the stop line.
    After n trades with cumulative R `S`, stop for 'no edge' when S <= lower + n*mid, for 'edge' when S >= upper + n*mid."""
    if h1_mean <= h0_mean or sd <= 0:
        raise ValueError("h1_mean must exceed h0_mean and sd must be positive")
    d = h1_mean - h0_mean
    a, b = math.log((1 - beta) / alpha), math.log(beta / (1 - alpha))
    upper, lower = sd ** 2 * a / d, sd ** 2 * b / d
    mid = (h0_mean + h1_mean) / 2
    # Wald's approximate expected sample sizes
    llr_h0 = -(d ** 2) / (2 * sd ** 2)
    llr_h1 = d ** 2 / (2 * sd ** 2)
    asn_h0 = ((1 - alpha) * b + alpha * a) / llr_h0
    asn_h1 = (beta * b + (1 - beta) * a) / llr_h1
    return {"h0_mean_R": h0_mean, "h1_mean_R": h1_mean, "sd_R": sd, "alpha": alpha, "beta": beta,
            "upper_offset_R": upper, "lower_offset_R": lower, "drift_per_trade_R": mid,
            "expected_trades_if_no_edge": asn_h0, "expected_trades_if_edge": asn_h1}


def sprt_lower_at(design: Mapping[str, float], n: int) -> float:
    """The 'no edge' boundary on cumulative R after n trades."""
    return design["lower_offset_R"] + n * design["drift_per_trade_R"]


def cost_slope(points: Mapping[float, float]) -> dict[str, float | None]:
    """Expectancy against the cost multiple (1.0 = the recorded cost): slope per +1.0x and the break-even multiple."""
    xs = np.array(sorted(points), dtype=float)
    ys = np.array([points[x] for x in sorted(points)], dtype=float)
    if len(xs) < 2:
        return {"slope_per_1x": None, "break_even_multiple": None}
    slope, icpt = np.polyfit(xs, ys, 1)
    return {"slope_per_1x": float(slope), "break_even_multiple": float(-icpt / slope) if slope < 0 else None}
