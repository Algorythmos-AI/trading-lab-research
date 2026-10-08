"""A book per registered trial, read from the forward ledger (DEC-0023).

The forward ledger is the one book of record. A "book" here is a view: a pure function of ledger rows, and
optionally of the funnel records beside it, by trial. It adds nothing the ledger does not hold: no compounding, no
resizing, no netting across trials and no limit. Dollars are nominal: R times the registered risk per trade (1% of
the equity the trial's own marker rows state).

Which trials get a book: those whose marker rows name a hypothesis, and strategy B. A strategy the ledger still
holds from before the audit (the legacy forward flags, biased by look-ahead) is never listed and never pooled.
A trial with sessions and no trade is listed with zeros: nothing happening is itself the record.
"""
from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import asdict, dataclass
from typing import Any

RISK_PCT = 1.0                               # RSK: the registered per-trade risk, percent of equity
ALWAYS = ("B_qqq_qqqm",)                     # the active strategy: listed although its markers name no hypothesis


@dataclass(frozen=True)
class Book:
    strategy: str
    hyp: str | None
    sessions: int                # sessions this trial completed (its marker rows)
    errors: int                  # error rows naming it: sessions it could not complete at the time
    first: str | None
    last: str | None
    trades: int
    total_r: float
    max_dd_r: float              # deepest fall of the running total from its high, in R; 0 with no trade
    last_trade: str | None
    risk_usd: float | None       # 1% of the registered equity, or None when the markers state no equity
    nominal_usd: float | None    # total_r * risk_usd
    signals: int | None          # chains that reached admission, summed over the funnel records; None without records
    refused: int | None          # of those, the ones admission refused


def _num(v: Any) -> float | None:
    return float(v) if isinstance(v, int | float) and not isinstance(v, bool) else None


def drawdown(rs: Iterable[float]) -> float:
    peak = cum = worst = 0.0
    for r in rs:
        cum += r
        peak = max(peak, cum)
        worst = max(worst, peak - cum)
    return worst


def funnel_part(strategy: str) -> tuple[str, str] | None:
    """Where a trial's counts sit in a funnel record: ("set_F", "GG-1") for r3:F:GG-1, ("MP-1", "") for r3:MP-1."""
    bits = strategy.split(":")
    if bits[0] != "r3":
        return None
    return (f"set_{bits[1]}", bits[2]) if len(bits) == 3 else (bits[1], "") if len(bits) == 2 else None


def funnel_counts(strategy: str, records: Iterable[Mapping[str, Any]]) -> tuple[int, int] | None:
    """(chains that reached admission, chains admission refused) for one trial over the funnel records."""
    where = funnel_part(strategy)
    if where is None:
        return None
    signals = refused = 0
    seen = False
    for rec in records:
        part = (rec.get("parts") or {}).get(where[0])
        trial = (part.get("trials") or {}).get(where[1]) if isinstance(part, dict) and where[1] else part
        if not isinstance(trial, dict):
            continue
        seen = True
        signals += int(_num(trial.get("candidates")) or 0)
        refused += sum(int(_num(v) or 0) for v in (trial.get("admission_skips") or {}).values())
    return (signals, refused) if seen else None


def books(rows: Iterable[Mapping[str, Any]], funnels: Iterable[Mapping[str, Any]] = ()) -> list[Book]:
    """One Book per registered trial, in the order of their hypothesis ids, then B."""
    rows, funnels = list(rows), list(funnels)
    hyp: dict[str, str] = {}
    equity: dict[str, float] = {}
    sessions: dict[str, set[str]] = {}
    errors: dict[str, int] = {}
    trades: dict[str, list[tuple[str, str, int, float]]] = {}
    for i, r in enumerate(rows):
        name = r.get("strategy")
        if not isinstance(name, str):
            continue
        if "error" in r:
            for n in name.split(","):
                errors[n] = errors.get(n, 0) + 1
        elif r.get("strategy_marker"):
            sessions.setdefault(name, set()).add(str(r.get("session")))
            if isinstance(r.get("hyp"), str):
                hyp[name] = r["hyp"]
            if _num(r.get("equity")) is not None:
                equity[name] = float(r["equity"])
        elif not r.get("session_marker") and _num(r.get("R")) is not None:
            trades.setdefault(name, []).append((str(r.get("session")), str(r.get("entry_time") or ""), i, float(r["R"])))
    listed = sorted(hyp, key=lambda n: (hyp[n], n)) + [n for n in ALWAYS if n in sessions or n in trades]
    out = []
    for name in listed:
        mine = sorted(trades.get(name, []))
        rs = [t[3] for t in mine]
        days = sorted(sessions.get(name, set()))
        risk = equity[name] * RISK_PCT / 100 if name in equity else None
        total = round(sum(rs), 4)
        counts = funnel_counts(name, funnels)
        out.append(Book(strategy=name, hyp=hyp.get(name), sessions=len(days), errors=errors.get(name, 0),
                        first=days[0] if days else None, last=days[-1] if days else None, trades=len(rs),
                        total_r=total, max_dd_r=round(drawdown(rs), 4), last_trade=mine[-1][0] if mine else None,
                        risk_usd=risk, nominal_usd=None if risk is None else round(total * risk, 2),
                        signals=counts[0] if counts else None, refused=counts[1] if counts else None))
    return out


def view(rows: Iterable[Mapping[str, Any]], funnels: Iterable[Mapping[str, Any]] = ()) -> list[dict[str, Any]]:
    return [asdict(b) for b in books(rows, funnels)]
