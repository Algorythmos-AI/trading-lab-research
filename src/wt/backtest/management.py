"""Trade-management styles (knowledge/trade_management_catalog.md) as independent, pluggable policies.

Interface used by engine.simulate:
  init_state(trade, signal) -> dict with at least {"stop": float}
  limit_exits(state) -> list[(price, fraction_of_initial_qty, reason)] resting limit sells
  on_partial(state, reason) -> update after a limit fill (e.g. stop -> breakeven)
  on_bar_close(state, bars, j, trade) -> None | "exit_market" (rule exits act at next bar open)
"""
from __future__ import annotations

import numpy as np


def ema(values: np.ndarray, n: int) -> np.ndarray:
    a = 2 / (n + 1)
    out = np.empty_like(values, dtype=float)
    out[0] = values[0]
    for k in range(1, len(values)):
        out[k] = a * values[k] + (1 - a) * out[k - 1]
    return out


class Base:
    name = "base"

    def __init__(self, target_R: float = 2.0, time_stop_min: int | None = None, time_stop_min_R: float = 0.5):
        self.target_R, self.time_stop_min, self.time_stop_min_R = target_R, time_stop_min, time_stop_min_R

    def init_state(self, tr, sig) -> dict:
        R = tr.entry - tr.stop0
        tgt = sig.target if sig.target and sig.target > tr.entry else tr.entry + self.target_R * R
        return {"stop": tr.stop0, "R": R, "t1": tgt, "partial_done": False, "entry_bar_time": tr.entry_time}

    def limit_exits(self, s):
        return [(s["t1"], 1.0, "target")]

    def on_partial(self, s, reason):
        pass

    def _time_stop(self, s, bars, j, tr):
        if self.time_stop_min is None or s["partial_done"]:
            return None
        # this runs at bar j's close, one minute after its start stamp, and entry_time is the entry bar's start: without
        # the + 1 the stop fired (and exited) a minute late (audit)
        mins = (bars.t.iloc[j] - tr.entry_time).total_seconds() / 60 + 1
        if mins >= self.time_stop_min and (bars.c.iloc[j] - tr.entry) < self.time_stop_min_R * s["R"]:
            s["exit_reason"] = f"time_stop_{self.time_stop_min}m"
            return "exit_market"
        return None

    def on_bar_close(self, s, bars, j, tr):
        return self._time_stop(s, bars, j, tr)


class M3FixedTarget(Base):
    """Fixed target, no partial, no trail (control baseline)."""
    name = "M3_fixed_target"


class M1HalfBreakeven(Base):
    """Sell 1/2 at target 1 (2R or setup target), stop -> breakeven; runner exits on 5m-EMA9 break proxy."""
    name = "M1_half_breakeven"

    def limit_exits(self, s):
        return [] if s["partial_done"] else [(s["t1"], 0.5, "partial_t1")]

    def on_partial(self, s, reason):
        s["partial_done"] = True
        s["stop"] = max(s["stop"], s["entry"])  # breakeven after partial

    def init_state(self, tr, sig):
        s = super().init_state(tr, sig)
        s["entry"] = tr.entry
        return s

    def on_bar_close(self, s, bars, j, tr):
        if not s["partial_done"]:
            return self._time_stop(s, bars, j, tr)
        s["stop"] = max(s["stop"], tr.entry)          # breakeven
        closes = bars.c.to_numpy()[: j + 1]
        if len(closes) >= 45:                          # EMA9 on 5-min ~= EMA45 on 1-min
            if closes[-1] < ema(closes, 45)[-1]:
                s["exit_reason"] = "runner_ema_break"
                return "exit_market"
        return None


class M2BreakoutOrBailout(M1HalfBreakeven):
    def __init__(self, minutes: int = 5, **kw):
        super().__init__(time_stop_min=minutes, **kw)
        self.name = f"M2_bailout_{minutes}m"


class M4TrailOnly(Base):
    """No fixed target; trail stop at the low of the last completed 5-minute window."""
    name = "M4_trail_only"

    def limit_exits(self, s):
        return []

    def on_bar_close(self, s, bars, j, tr):
        lows = bars.l.to_numpy()
        if j >= 5:
            s["stop"] = max(s["stop"], float(lows[j - 4: j + 1].min()))
            s["stop_reason"] = "trail"
        return None


class M5Ladder(Base):
    """1/3 at 1R, 1/3 at 2R, 1/3 trailing (last-5-bar low); stop -> breakeven after first third."""
    name = "M5_ladder"

    def init_state(self, tr, sig):
        s = super().init_state(tr, sig)
        s.update(entry=tr.entry, legs=0)
        return s

    def limit_exits(self, s):
        e, R = s["entry"], s["R"]
        return [(e + R, 1 / 3, "ladder_1R")] if s["legs"] == 0 else ([(e + 2 * R, 1 / 3, "ladder_2R")] if s["legs"] == 1 else [])

    def on_partial(self, s, reason):
        s["legs"] += 1
        s["partial_done"] = True
        s["stop"] = max(s["stop"], s["entry"])

    def on_bar_close(self, s, bars, j, tr):
        if s["legs"] >= 2 and j >= 5:
            s["stop"] = max(s["stop"], float(bars.l.to_numpy()[j - 4: j + 1].min()))
            s["stop_reason"] = "trail"
        return None


class M7MeanReversion(Base):
    """Reversal: 1/2 at EMA9-proxy target (signal.target), rest at VWAP (meta), trail last-5-bar low after first scale."""
    name = "M7_mean_reversion"

    def init_state(self, tr, sig):
        s = super().init_state(tr, sig)
        s.update(entry=tr.entry, t2=sig.meta.get("vwap", s["t1"] + s["R"]))
        return s

    def limit_exits(self, s):
        return [(s["t1"], 0.5, "t1_ema9")] if not s["partial_done"] else [(max(s["t2"], s["t1"]), 1.0, "t2_vwap")]

    def on_partial(self, s, reason):
        s["partial_done"] = True
        s["stop"] = max(s["stop"], s["entry"])

    def on_bar_close(self, s, bars, j, tr):
        if s["partial_done"] and j >= 5:
            s["stop"] = max(s["stop"], float(bars.l.to_numpy()[j - 4: j + 1].min()))
        return None


class M8SellIntoStrength(M1HalfBreakeven):
    """M1 plus: exit 100% on an extension bar (range > 2.5x ATR14(1m), close in top 20% of range)."""
    name = "M8_sell_into_strength"

    def on_bar_close(self, s, bars, j, tr):
        h, l, c = bars.h.to_numpy(), bars.l.to_numpy(), bars.c.to_numpy()
        if j >= 15:
            atr = np.mean(h[j - 14: j] - l[j - 14: j])
            rng = h[j] - l[j]
            if atr > 0 and rng > 2.5 * atr and c[j] >= l[j] + 0.8 * rng and c[j] > tr.entry:
                s["exit_reason"] = "extension_bar"
                return "exit_market"
        return super().on_bar_close(s, bars, j, tr)


class WT(M1HalfBreakeven):
    """SPEC-0001 EXT-01..06 (exit style "WT"): sell floor(qty/2) at the first target (2R, or the setup's target)
    and move the stop to breakeven; a position under 2 shares exits in full there (D12). The runner's stop
    trails the low of the last completed clock-aligned 5-minute candle, and a 5-minute close below EMA9 exits at
    the next bar's open. Before the first target, the stagnation stop applies: under +0.5R at minute 5 -> exit.
    Runners have no time cap (C8)."""
    name = "WT"

    def __init__(self, minutes: int = 5, resolved_R: float = 0.5):
        super().__init__(time_stop_min=minutes, time_stop_min_R=resolved_R)

    def init_state(self, tr, sig):
        s = super().init_state(tr, sig)
        s["qty0"] = tr.qty
        s["warm_c5"] = list((sig.meta or {}).get("pm_c5", []))
        return s

    def limit_exits(self, s):
        if s["partial_done"]:
            return []
        q = s["qty0"]
        frac = 1.0 if q < 2 else (q // 2) / q
        return [(s["t1"], frac, "partial_t1" if frac < 1 else "target_all")]

    def on_bar_close(self, s, bars, j, tr):
        if not s["partial_done"]:
            return self._time_stop(s, bars, j, tr)
        if "b5" not in s:
            from wt.signals.bars import resample_clock
            b5, done = resample_clock(bars, 5)
            warm = np.asarray(s["warm_c5"], float)
            s.update(b5=b5, done5=done, e5=ema(np.r_[warm, b5.c.to_numpy(float)], 9)[len(warm):], last_k=-1)
        k = int(s["done5"][j])
        if k >= 0 and k != s["last_k"]:
            s["last_k"] = k
            s["stop"] = max(s["stop"], float(s["b5"].l.iloc[k]))
            s["stop_reason"] = "runner_prior_5m_low"
            if s["b5"].c.iloc[k] < s["e5"][k]:
                s["exit_reason"] = "runner_5m_close_below_ema9"
                return "exit_market"
        return None


class MeanRevert5(Base):
    """SPEC-0001 EXT-08: reversal exits 100% at the EMA9(5m) target fixed at the signal; the stagnation stop applies."""
    name = "REV_ema9"

    def __init__(self, minutes: int = 5, resolved_R: float = 0.5):
        super().__init__(time_stop_min=minutes, time_stop_min_R=resolved_R)


REGISTRY = {
    "M1": lambda: M1HalfBreakeven(), "M2_2": lambda: M2BreakoutOrBailout(2), "M2_5": lambda: M2BreakoutOrBailout(5),
    "M3": lambda: M3FixedTarget(), "M4": lambda: M4TrailOnly(), "M5": lambda: M5Ladder(),
    "M7": lambda: M7MeanReversion(), "M8": lambda: M8SellIntoStrength(),
    "WT": lambda: WT(), "REV5": lambda: MeanRevert5(),
}
