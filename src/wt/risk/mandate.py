"""What strategy B may hold, and the positions the owner has accepted as legacy.

B's mandate is its allowlist in config/risk.yaml (QQQM). Anything else in the paper account is outside the
mandate: the runner never touches it, and it is flagged until it is closed or recorded here as legacy.

config/legacy_positions.yaml (optional):

    positions:
      - {symbol: AAPL, qty: 1, note: "manual test buy before the audit"}

A legacy entry only covers the exact quantity recorded. Any change in quantity is flagged again.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

from wt.core.config import CONFIG_DIR

LEGACY_FILE = CONFIG_DIR / "legacy_positions.yaml"


def legacy_positions(path: Path | None = None) -> dict[str, int]:
    """symbol -> accepted quantity. A missing or unreadable file means no legacy positions."""
    try:
        raw: Any = yaml.safe_load((path or LEGACY_FILE).read_text()) or {}
    except (OSError, yaml.YAMLError):
        return {}
    out: dict[str, int] = {}
    for row in raw.get("positions") or []:
        try:
            out[str(row["symbol"]).upper()] = int(row["qty"])
        except (KeyError, TypeError, ValueError):
            continue
    return out


def out_of_mandate(positions: list[tuple[str, int]], allowlist: frozenset[str] | set[str],
                   legacy: dict[str, int] | None = None) -> list[tuple[str, int, bool]]:
    """(symbol, qty, is_legacy) for every non-zero position outside the allowlist."""
    legacy = legacy if legacy is not None else legacy_positions()
    return [(sym, qty, legacy.get(sym.upper()) == qty) for sym, qty in positions
            if qty and sym not in allowlist]
