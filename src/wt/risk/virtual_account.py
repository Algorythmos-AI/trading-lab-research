"""Virtual small account enforced inside a larger paper account (Alpaca paper enforces PDT < $25k).
Tracks virtual equity, settled cash (T+1), realised P&L, loss-limit latch and trade counts."""
from __future__ import annotations

import datetime as dt
import json
from dataclasses import asdict, dataclass, field
from pathlib import Path


@dataclass
class VirtualAccount:
    start_equity: float = 600.0
    equity: float = 600.0
    settled_cash: float = 600.0
    unsettled: list = field(default_factory=list)      # [(settle_date_iso, amount)]
    high_water: float = 600.0
    latched: bool = False
    latch_reason: str = ""
    day_pnl: dict = field(default_factory=dict)         # date -> pnl
    trades_by_day: dict = field(default_factory=dict)   # date -> count

    def roll(self, today: dt.date) -> None:
        keep = []
        for d, amt in self.unsettled:
            if dt.date.fromisoformat(d) <= today:
                self.settled_cash += amt
            else:
                keep.append((d, amt))
        self.unsettled = keep

    def record_round_trip(self, today: dt.date, next_session: dt.date, cost: float, proceeds: float) -> None:
        pnl = proceeds - cost
        self.settled_cash -= cost                      # bought with settled cash
        self.unsettled.append((next_session.isoformat(), proceeds))   # T+1 settlement
        self.equity += pnl
        self.high_water = max(self.high_water, self.equity)
        k = today.isoformat()
        self.day_pnl[k] = self.day_pnl.get(k, 0.0) + pnl
        self.trades_by_day[k] = self.trades_by_day.get(k, 0) + 1
        self.check_limits(today)

    def check_limits(self, today: dt.date) -> None:
        k = today.isoformat()
        if self.day_pnl.get(k, 0.0) <= -0.02 * self.equity:
            self.latch("daily loss limit -2%")
        week = sum(v for d, v in self.day_pnl.items() if (today - dt.date.fromisoformat(d)).days < 7)
        if week <= -0.04 * self.equity:
            self.latch("weekly loss limit -4%")
        if self.equity <= 0.90 * self.high_water:
            self.latch("drawdown -10% from high-water mark")

    def latch(self, why: str) -> None:
        self.latched, self.latch_reason = True, why

    def save(self, path: Path) -> None:
        path.write_text(json.dumps(asdict(self), indent=1))

    @classmethod
    def load(cls, path: Path, start_equity: float = 600.0) -> "VirtualAccount":
        if path.exists():
            return cls(**json.loads(path.read_text()))
        return cls(start_equity, start_equity, start_equity, high_water=start_equity)
