"""Virtual small account enforced inside a larger paper account (Alpaca paper enforces PDT under $25k).

Tracks virtual equity, settled cash (T+1), realised P&L, the loss-limit latch and trade counts.

Hardening (audit C1, C4, M2):
  * Idempotent by trade id. A round trip is booked once, even if a restart replays it.
  * The day's trade counter moves on the *first fill* (count_entry), not at exit. A crash between a stop-out and
    its accounting can therefore never free up a second entry for the same day.
  * Saves are atomic (temp file, fsync, rename). While the account is latched, a sentinel file `<name>.latch`
    exists. Deleting the JSON can't clear a latch: load() refuses when the sentinel exists without the account.
  * Only reset_latch() clears a latch, and it keeps a history of every reset.
"""
from __future__ import annotations

import datetime as dt
import json
import os
from dataclasses import asdict, dataclass, field, fields
from pathlib import Path
from typing import Any


class StateError(RuntimeError):
    """The account state can't be trusted (corrupt file, or a latch sentinel without its account)."""


@dataclass
class VirtualAccount:
    start_equity: float = 600.0
    equity: float = 600.0
    settled_cash: float = 600.0
    unsettled: list[Any] = field(default_factory=list)      # [(settle_date_iso, amount)]
    high_water: float = 600.0
    latched: bool = False
    latch_reason: str = ""
    day_pnl: dict[str, float] = field(default_factory=dict)         # date -> pnl
    trades_by_day: dict[str, int] = field(default_factory=dict)   # date -> entries (counted on first fill)
    counted_entries: list[str] = field(default_factory=list)  # trade ids already counted
    recorded_trades: list[str] = field(default_factory=list)  # trade ids already booked
    latch_history: list[dict[str, Any]] = field(default_factory=list)   # [{at, reason, reset_by}]

    def roll(self, today: dt.date) -> None:
        keep = []
        for d, amt in self.unsettled:
            if dt.date.fromisoformat(d) <= today:
                self.settled_cash += amt
            else:
                keep.append((d, amt))
        self.unsettled = keep

    def count_entry(self, today: dt.date, trade_id: str) -> bool:
        """Count a trade against the day on its first fill. Returns False if it was already counted."""
        if trade_id in self.counted_entries:
            return False
        self.counted_entries.append(trade_id)
        k = today.isoformat()
        self.trades_by_day[k] = self.trades_by_day.get(k, 0) + 1
        return True

    def record_round_trip(self, today: dt.date, next_session: dt.date, cost: float, proceeds: float,
                          trade_id: str | None = None) -> bool:
        """Book a completed trade once. Returns False (and changes nothing) if trade_id was already booked."""
        if trade_id is not None:
            if trade_id in self.recorded_trades:
                return False
            self.recorded_trades.append(trade_id)
            self.count_entry(today, trade_id)
        else:
            k = today.isoformat()
            self.trades_by_day[k] = self.trades_by_day.get(k, 0) + 1
        pnl = proceeds - cost
        self.settled_cash -= cost                      # bought with settled cash
        self.unsettled.append((next_session.isoformat(), proceeds))   # T+1 settlement
        self.equity += pnl
        self.high_water = max(self.high_water, self.equity)
        k = today.isoformat()
        self.day_pnl[k] = self.day_pnl.get(k, 0.0) + pnl
        self.check_limits(today)
        return True

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
        if not self.latched:
            self.latched, self.latch_reason = True, why

    # ---- persistence ------------------------------------------------------------------------------
    @staticmethod
    def sentinel(path: Path) -> Path:
        return path.with_suffix(path.suffix + ".latch")

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f".{path.name}.tmp")
        with open(tmp, "w") as fh:
            fh.write(json.dumps(asdict(self), indent=1))
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
        s = self.sentinel(path)
        if self.latched:
            s.write_text(self.latch_reason or "latched")
        elif s.exists():
            s.unlink()

    @classmethod
    def load(cls, path: Path, start_equity: float = 600.0) -> VirtualAccount:
        if path.exists():
            try:
                raw: dict[str, Any] = json.loads(path.read_text())
            except (OSError, json.JSONDecodeError) as e:
                raise StateError(f"{path.name} is unreadable ({e.__class__.__name__}); refusing to arm") from e
            known = {f.name for f in fields(cls)}
            va = cls(**{k: v for k, v in raw.items() if k in known})
            if cls.sentinel(path).exists() and not va.latched:
                raise StateError(f"{path.name} says unlatched but its latch sentinel exists; refusing to arm")
            return va
        if cls.sentinel(path).exists():
            raise StateError(f"{path.name} is missing but the account was latched; refusing to arm")
        return cls(start_equity, start_equity, start_equity, high_water=start_equity)


def reset_latch(path: Path, reason: str, by: str = "owner") -> VirtualAccount:
    """The only way to clear a latch (`make reset-latch REASON=...`). Keeps a history of every reset."""
    if not reason.strip():
        raise ValueError("a reason is required to reset the latch")
    try:
        va = VirtualAccount.load(path)
    except StateError:
        raw = json.loads(path.read_text()) if path.exists() else {}
        known = {f.name for f in fields(VirtualAccount)}
        va = VirtualAccount(**{k: v for k, v in raw.items() if k in known}) if raw else VirtualAccount()
    va.latch_history.append({"at": dt.datetime.now(dt.UTC).isoformat(timespec="seconds"),
                             "reason": va.latch_reason, "reset_by": by, "note": reason.strip()[:200]})
    va.latched, va.latch_reason = False, ""
    va.save(path)
    return va
