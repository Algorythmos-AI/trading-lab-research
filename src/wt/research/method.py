"""Evaluation-methodology presets (DEC-0011).

Every recorded experiment was produced by LEGACY, and LEGACY stays the default of every driver so those results
reproduce exactly. The DEC-0011 re-runs select the corrected preset by name, `--method dec0011` (METHOD):

  aspect          legacy                               dec0011
  target fills    a touch fills (engine default)       one tick through (engine target_fill="through")
  cost stress     R - (m-1) x 2 x slip / risk          every fill re-priced: entry, each partial, the final exit
  stop stress     none                                 stop fills at 2x and 3x slippage, reported separately
  bootstrap CI    trades resampled                     sessions resampled (day blocks)
  DSR trials      each driver's recorded source        the global registry (wt.research.trials)
  $ P&L           R x nominal risk                     realised dollars (Trade.pnl)
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from wt.research.trials import global_trial_count


@dataclass(frozen=True)
class Method:
    name: str
    target_fill: str = "touch"
    tick: float = 0.01
    bootstrap_block: str = "trade"
    dsr_trials: str = "recorded"            # "recorded": whatever the driver used before; "global": the registry
    pnl: str = "nominal"                    # "nominal": R x nominal risk; "realised": Trade.pnl
    fill_stress: bool = False               # needs per-fill trade rows (wt.backtest.stress.detail)
    stop_slip_stress: tuple[float, ...] = ()

    @property
    def legacy(self) -> bool:
        return self.name == LEGACY.name

    def sim_kwargs(self) -> dict[str, Any]:
        """Keyword arguments for engine.simulate."""
        return {"target_fill": self.target_fill, "tick": self.tick}

    def dsr_trial_count(self, recorded: int) -> int:
        return global_trial_count() if self.dsr_trials == "global" else recorded


LEGACY = Method("legacy")
DEC0011 = Method("dec0011", target_fill="through", bootstrap_block="day", dsr_trials="global", pnl="realised",
                 fill_stress=True, stop_slip_stress=(2.0, 3.0))
METHODS = {m.name: m for m in (LEGACY, DEC0011)}
METHOD = DEC0011.name                       # the corrected preset the DEC-0011 re-runs use


def get_method(name: str | Method | None = None) -> Method:
    if isinstance(name, Method):
        return name
    if name is None:
        return LEGACY
    if name not in METHODS:
        raise ValueError(f"unknown method {name!r}; known: {sorted(METHODS)}")
    return METHODS[name]


def pop_method(argv: list[str]) -> tuple[Method, list[str]]:
    """Take `--method NAME` or `--method=NAME` out of a hand-parsed argv (LEGACY when absent)."""
    rest, name = [], None
    it = iter(argv)
    for a in it:
        if a == "--method":
            name = next(it, None)
            if name is None:
                raise ValueError("--method needs a name")
        elif a.startswith("--method="):
            name = a.split("=", 1)[1]
        else:
            rest.append(a)
    return get_method(name), rest
