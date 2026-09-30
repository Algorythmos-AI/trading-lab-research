"""The risk limits in force and how much of each is used today (plan v4.2, Wave 1a).

The limits are *read* from where they are enforced, never restated for display only:
  * pre-trade limits from config/risk.yaml (wt.risk.pretrade.load_limits);
  * the loss latches (-2% day, -4% week, -10% from the high-water mark) and the 1% risk per trade are literals in
    wt.risk.virtual_account and wt.live.runner_b. They are declared once below, and tests/unit/test_risk_view.py
    drives the real VirtualAccount and reads runner_b.RISK_PCT, so a change in either place fails CI until this
    module agrees.
Each row carries the sha256 (first 12) of the file that enforces it, so the dashboard can show which code a limit
came from. Money is published as % of the virtual account only (alerts and the page carry R and %).
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json
from pathlib import Path
from typing import Any

from wt.core.config import CONFIG_DIR, DATA_DIR, ROOT
from wt.ops import thresholds

DAY_LOSS_PCT = 2.0          # virtual_account.check_limits: day P&L <= -2% of equity latches
WEEK_LOSS_PCT = 4.0         # ... trailing 7 calendar days <= -4% latches
DRAWDOWN_PCT = 10.0         # ... equity <= 90% of the high-water mark latches
RISK_PER_TRADE_PCT = 1.0    # runner_b.RISK_PCT: position size risks 1% of virtual equity to the stop

SOURCES = {"virtual_account": "src/wt/risk/virtual_account.py", "runner_b": "src/wt/live/runner_b.py",
           "risk_yaml": "config/risk.yaml"}


def source_hashes(root: Path = ROOT) -> dict[str, str]:
    out = {}
    for k, rel in SOURCES.items():
        try:
            out[k] = hashlib.sha256((root / rel).read_bytes()).hexdigest()[:12]
        except OSError:
            out[k] = ""
    return out


def state(used_pct: float | None) -> str:
    """ok below LOSS_LIMIT_AMBER of the limit, warn from there, at_limit once it is used up, n/a when unknown."""
    if used_pct is None:
        return "n/a"
    if used_pct >= 100:
        return "at_limit"
    return "warn" if used_pct >= thresholds.LOSS_LIMIT_AMBER * 100 else "ok"


def _pct(x: float | None, of: float | None) -> float | None:
    return round(x / of * 100, 2) if x is not None and of else None


def _usage(loss_pct: float | None, limit_pct: float) -> float | None:
    """How much of a loss limit is used: 0 when flat or up, 100 at the limit."""
    return None if loss_pct is None else round(max(0.0, -loss_pct) / limit_pct * 100, 1)


def load_account(path: Path = DATA_DIR / "live" / "virtual_account.json") -> dict[str, Any] | None:
    try:
        raw = json.loads(path.read_text())
        return raw if isinstance(raw, dict) else None
    except (OSError, json.JSONDecodeError):
        return None


def view(today: dt.date, account: dict[str, Any] | None, kill: bool, root: Path = ROOT,
         risk_yaml: Path | None = None, va_path: Path | None = None) -> dict[str, Any]:
    """`va_path` lets the view see the latch sentinel: a sentinel with an account that says unlatched (a failed
    account write, or a tampered file) is reported latched, because the runner refuses to arm on it."""
    from wt.risk.pretrade import load_limits
    from wt.risk.virtual_account import VirtualAccount
    hashes = source_hashes(root)
    try:
        lim = load_limits("B", risk_yaml or CONFIG_DIR / "risk.yaml")
        pre: dict[str, Any] = {"max_qty": lim.max_qty, "max_notional": lim.max_notional,
                               "max_entries_per_day": lim.max_entries_per_day,
                               "max_orders_per_day": lim.max_orders_per_day,
                               "allowlist": ",".join(sorted(lim.allowlist))}
    except Exception:  # noqa: BLE001 — an unreadable risk.yaml (YAMLError included) shows "?" rather than no view
        pre = {}
    sentinel = va_path is not None and VirtualAccount.sentinel(va_path).exists()
    a = account or {}
    eq = a.get("equity") if isinstance(a.get("equity"), int | float) else None
    hw = a.get("high_water") if isinstance(a.get("high_water"), int | float) else None
    raw_pnl = a.get("day_pnl")
    day_pnl: dict[str, Any] = raw_pnl if isinstance(raw_pnl, dict) else {}
    k = today.isoformat()
    d = day_pnl.get(k) if account else None
    week = sum(float(v) for dd, v in day_pnl.items()
               if isinstance(v, int | float) and 0 <= (today - dt.date.fromisoformat(dd)).days < 7) if account else None
    dd_pct = round((eq / hw - 1) * 100, 3) if eq is not None and hw else None
    day_pct, week_pct = _pct(float(d) if isinstance(d, int | float) else (0.0 if account else None), eq), \
        _pct(week, eq)
    entries = (a.get("trades_by_day") or {}).get(k, 0) if account else None
    max_entries = pre.get("max_entries_per_day")

    def row(id_: str, label: str, limit: str, used: str | None, used_pct: float | None, source: str) -> dict[str, Any]:
        return {"id": id_, "label": label, "limit": limit, "used": used, "used_pct": used_pct,
                "state": state(used_pct), "source": source, "source_sha": hashes.get(source, "")}

    limits = [
        row("day_loss", "Daily loss latch", f"-{DAY_LOSS_PCT:g}% of equity",
            None if day_pct is None else f"{day_pct:+.2f}%", _usage(day_pct, DAY_LOSS_PCT), "virtual_account"),
        row("week_loss", "Weekly loss latch (7 days)", f"-{WEEK_LOSS_PCT:g}% of equity",
            None if week_pct is None else f"{week_pct:+.2f}%", _usage(week_pct, WEEK_LOSS_PCT), "virtual_account"),
        row("drawdown", "Drawdown latch (from high-water)", f"-{DRAWDOWN_PCT:g}%",
            None if dd_pct is None else f"{dd_pct:+.2f}%", _usage(dd_pct, DRAWDOWN_PCT), "virtual_account"),
        row("risk_per_trade", "Risk per trade", f"{RISK_PER_TRADE_PCT:g}% of equity to the stop", None, None,
            "runner_b"),
        row("entries_per_day", "Entries per day", str(max_entries) if max_entries is not None else "?",
            None if entries is None else str(entries),
            round(entries / max_entries * 100, 1) if entries is not None and max_entries else None, "risk_yaml"),
        row("max_qty", "Max shares per order", str(pre.get("max_qty", "?")), None, None, "risk_yaml"),
        row("max_notional", "Max notional per order", f"US${pre.get('max_notional', '?')}", None, None, "risk_yaml"),
        row("orders_per_day", "Orders per day", str(pre.get("max_orders_per_day", "?")), None, None, "risk_yaml"),
        row("allowlist", "Symbols B may trade", str(pre.get("allowlist", "?")), None, None, "risk_yaml"),
    ]
    raw_hist = a.get("latch_history")
    history: list[Any] = raw_hist if isinstance(raw_hist, list) else []
    return {
        "limits": limits,
        "controls": {"kill": kill,
                     "latched": True if sentinel else bool(a.get("latched")) if account else None,
                     "latch_reason": a.get("latch_reason") or ("latch sentinel present" if sentinel else None),
                     "latch_resets": len(history),
                     "last_reset": str(history[-1].get("at")) if history and isinstance(history[-1], dict) else None,
                     "entries_allowed": False if sentinel else (not kill and not a.get("latched")) if account
                     else None},
        "used_today": {"date": k, "day_pnl_pct": day_pct, "week_pnl_pct": week_pct, "drawdown_pct": dd_pct,
                       "entries": entries},
        "sources": hashes,
    }
