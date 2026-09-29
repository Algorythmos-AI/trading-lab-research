"""Global DSR trial count, read from the append-only registry config/trial_registry.yaml (DEC-0005, DEC-0011).

Why a config file and not the decision records: the records state the count in prose ("Global trials: 65",
"global 75", "75 → 85"), which no parser reads reliably, and a frozen spec (SPEC-0001 `global_trials_after`) never
moves past its own round. The YAML is the one number code reads; tests/unit/test_trials.py ties every row to its
record (the total appears in it, the status agrees with it) and to the spec, so they cannot drift apart silently.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

from wt.core.config import CONFIG_DIR

REGISTRY = CONFIG_DIR / "trial_registry.yaml"
STATUSES = ("accepted", "proposed")


def trial_history(path: Path | None = None) -> list[dict[str, Any]]:
    """The registry rows, validated: known status, integer totals that never decrease."""
    rows: list[dict[str, Any]] = yaml.safe_load((path or REGISTRY).read_text())["history"]
    last = 0
    for r in rows:
        if r.get("status") not in STATUSES or not isinstance(r.get("total"), int) or not str(r.get("decision", "")):
            raise ValueError(f"bad trial registry row: {r}")
        if r["total"] < last:
            raise ValueError(f"trial registry total decreases at {r['decision']}: {r['total']} < {last}")
        last = r["total"]
    return rows


def global_trial_count(path: Path | None = None) -> int:
    """The global trial count in force: the newest accepted row (a proposed record does not count yet)."""
    accepted = [r for r in trial_history(path) if r["status"] == "accepted"]
    if not accepted:
        raise ValueError("trial registry has no accepted row")
    return int(accepted[-1]["total"])
