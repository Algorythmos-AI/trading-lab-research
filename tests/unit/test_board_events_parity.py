"""The Options board's event line (dashboard/src/lib/board-events.ts, DEC-0042 note of 2026-11-12) names a focus name
whose earnings dates have run out with the host's own horizon, and leaves out the names that report no earnings by the
clone's own list: each constant there equals its source here, so the two cannot drift apart."""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import yaml

from wt.risk import events

ROOT = Path(__file__).resolve().parents[2]
TS = (ROOT / "dashboard/src/lib/board-events.ts").read_text()
CFG: dict[str, Any] = yaml.safe_load((ROOT / "config/options_clone.yaml").read_text())


def const(name: str) -> str:
    """The right-hand side of `export const NAME ... = <value>;` in the TS file."""
    m = re.search(rf"export const {name}\b[^=]*=\s*(.+?);\s*$", TS, re.M)
    assert m, f"{name} is not exported from board-events.ts"
    return m.group(1).strip()


def test_earnings_horizon_is_the_hosts() -> None:
    assert int(const("EARNINGS_MAX_AGE_DAYS")) == events.EARNINGS_MAX_AGE_DAYS


def test_index_names_are_the_clones() -> None:
    assert json.loads(const("INDEX_NAMES")) == CFG["contract"]["index_names"]
