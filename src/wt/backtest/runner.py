"""G1 research runner: 09:25 watchlist -> setup detectors -> simulated trades (R-multiples).

Account realism (plan): long-only; integer shares; cash cap; costs; optional max_trades_per_day=1 to
mimic one settled round trip per day in a small cash account. Max 2 attempts per symbol per day.
"""
from __future__ import annotations

import datetime as dt
import json
from dataclasses import asdict, dataclass

import pandas as pd

from wt.backtest.engine import Costs, simulate
from wt.backtest.management import REGISTRY
from wt.core.clock import et, to_utc_iso
from wt.core.config import DATA_DIR, ROOT
from wt.data.alpaca import AlpacaREST
from wt.signals import setups

MIN_DIR = DATA_DIR / "minute"


def minute_bars(a: AlpacaREST, d: dt.date, symbols: list[str], close_hhmm: str = "16:00") -> dict[str, pd.DataFrame]:
    """Regular-session 1m bars (09:30 -> close), cached per day."""
    MIN_DIR.mkdir(parents=True, exist_ok=True)
    f = MIN_DIR / f"{d}.parquet"
    have = pd.read_parquet(f) if f.exists() else pd.DataFrame(columns=["symbol"])
    need = sorted(set(symbols) - set(have.symbol.unique()))
    if need:
        new = a.bars(need, "1Min", to_utc_iso(et(d, "09:30")), to_utc_iso(et(d, close_hhmm)), feed="sip")
        have = pd.concat([have, new], ignore_index=True) if len(have) else new
        have.to_parquet(f)
    return {s: g.sort_values("t").reset_index(drop=True) for s, g in have[have.symbol.isin(symbols)].groupby("symbol")}


@dataclass
class StratConfig:
    name: str
    setup: str                  # s1_pm_high_break | s1_bull_flag_5m | s5_breakout_retest_pmh | ...
    management: str             # REGISTRY key
    window: tuple[int, int] = (0, 120)
    params: dict | None = None
    equity: float = 600.0
    risk_pct: float = 1.0
    max_trades_per_day: int | None = None
    cost_multiplier: float = 1.0


def detect(cfg: StratConfig, bars: pd.DataFrame, ctx: dict, start: int):
    p = dict(cfg.params or {})
    if cfg.setup == "s1_pm_high_break":
        return setups.s1_pm_high_break(bars, ctx["pm_high"], window=cfg.window, start=start, **p)
    if cfg.setup == "s1_bull_flag_5m":
        return setups.s1_bull_flag_5m(bars, window=cfg.window, start=start, **p)
    if cfg.setup == "s5_breakout_retest_pmh":
        return setups.s5_breakout_retest(bars, ctx["pm_high"], window=cfg.window, start=start, **p)
    if cfg.setup == "s2_extreme_reversal":
        return setups.s2_extreme_reversal(bars, window=cfg.window, start=start, **p)
    if cfg.setup == "s3_vwap_pullback":
        return setups.s3_vwap_pullback(bars, window=cfg.window, start=start, **p)
    if cfg.setup == "random_entry":
        return setups.random_entry(bars, window=cfg.window, start=start, **p)
    raise ValueError(cfg.setup)


def run_day(cfg: StratConfig, d: dt.date, watch: list[dict], bars_by_sym: dict, flatten_min: int = 380) -> list[dict]:
    costs = Costs(cost_multiplier=cfg.cost_multiplier)
    trades = []
    for w in watch:
        s = w["symbol"]
        b = bars_by_sym.get(s)
        if b is None or len(b) < 30:
            continue
        pmh = w.get("pm_high") or w["features"].get("pm_high")
        ctx = {"pm_high": pmh if pmh is not None and pmh == pmh else None}   # NaN -> None
        if ctx["pm_high"] is None and ("s1_pm" in cfg.setup or "pmh" in cfg.setup):
            continue
        start, attempts = 0, 0
        while attempts < 2:
            sig = detect(cfg, b, ctx, start)
            if sig is None:
                break
            tr = simulate(b, sig, REGISTRY[cfg.management](), costs, s, str(d),
                          risk_dollars=cfg.equity * cfg.risk_pct / 100, cash=cfg.equity, max_notional=cfg.equity,
                          flatten_idx=min(flatten_min, len(b) - 1))
            attempts += 1
            if tr is None:
                start = sig.bar_index + 1
                continue
            exit_t = tr.exits[-1][0]
            trades.append({"date": str(d), "symbol": s, "setup": tr.setup, "mgmt": tr.management,
                           "entry_time": str(tr.entry_time), "exit_time": str(exit_t), "entry": tr.entry,
                           "stop0": tr.stop0, "qty": tr.qty, "R": tr.r_multiple(costs), "mfe_R": tr.mfe,
                           "mae_R": tr.mae, "exit_reason": tr.exits[-1][3], "rank": w.get("rank"),
                           "score": w.get("score"), "rvol": w["features"].get("rvol_tod"),
                           "gap": w["features"].get("gap_pct"), "float": w["features"].get("float_shares"),
                           "catalyst": w["features"].get("catalyst_type")})
            start = int(b.index[b.t == exit_t][0]) + 1 if (b.t == exit_t).any() else len(b)
    trades.sort(key=lambda t: t["entry_time"])
    if cfg.max_trades_per_day:
        trades = trades[: cfg.max_trades_per_day]
    return trades


def save_experiment(exp_id: str, cfg_list: list[StratConfig], results: dict) -> None:
    out = ROOT / "research" / "experiments" / exp_id
    out.mkdir(parents=True, exist_ok=True)
    (out / "config.json").write_text(json.dumps([asdict(c) for c in cfg_list], indent=1, default=str))
    (out / "results.json").write_text(json.dumps(results, indent=1, default=str))
