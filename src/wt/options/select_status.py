"""The Radar → Options shadow (DEC-0070), as one status block for the Radar page's pipeline card: for each recent
session the shadow ran for, what the Radar gave, what the gate kept and what Stage 1 scored.

Read from `var/options-select/<S>/run.json` (written whole by `wt.options.radar_select`), and sent inside the paper
options document (`wt.options.paper_site`, version 4). Codes, counts, times and flags only: no symbol, no pick, no
desk list, no detail text (`radar_detail` is free text and stays on the host), nothing of the Radar edition (SAFE,
"Data classes" in AGENTS.md). A folder that is not a finished run, or a file that cannot be read, is left out; a
field that is not what it should be is sent as null. `block` never raises for a bad file.
"""
from __future__ import annotations

import json
import re
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from wt.core.config import ROOT

VAR = ROOT / "var" / "options-select"  # wt.options.radar_select.VAR (the checkout's var/), not imported here
OFF = "OFF"                            # wt.options.radar_select.OFF
MAX_SESSIONS = 10                      # the schema's cap: the newest are kept
RUN_SCHEMA = "wt.options/radar-select-run"
STATUSES = ("ok", "radar_missing", "radar_stale", "radar_invalid")
ORIGINS = ("core", "radar", "both")
_DAY = re.compile(r"\d{4}-\d{2}-\d{2}")
_CODE = re.compile(r"[a-z0-9_-]{1,32}")         # the schema's `code`
_STAMP = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})")
MAX_COUNT = 100_000


def _count(v: Any) -> int | None:
    return v if isinstance(v, int) and not isinstance(v, bool) and 0 <= v <= MAX_COUNT else None


def _flag(v: Any) -> bool | None:
    return v if isinstance(v, bool) else None


def _stamp(v: Any) -> str | None:
    return v if isinstance(v, str) and _STAMP.fullmatch(v) else None


def _codes(v: Any) -> dict[str, int]:
    """A code → count map, keeping only closed-code keys with a count."""
    if not isinstance(v, Mapping):
        return {}
    out = {k: n for k, raw in v.items() if isinstance(k, str) and _CODE.fullmatch(k) and (n := _count(raw)) is not None}
    return dict(sorted(out.items()))


def _part(v: Any, keys: tuple[str, ...]) -> dict[str, int | None]:
    m = v if isinstance(v, Mapping) else {}
    return {k: _count(m.get(k)) for k in keys}


def session_view(run: Mapping[str, Any]) -> dict[str, Any] | None:
    """One finished run as the page reads it, or None when `run` is not a run record."""
    session = run.get("session")
    if run.get("schema") != RUN_SCHEMA or not isinstance(session, str) or not _DAY.fullmatch(session):
        return None
    raw_counts, raw_picks = run.get("counts"), run.get("picks")
    counts: Mapping[str, Any] = raw_counts if isinstance(raw_counts, Mapping) else {}
    cand, uni, st1 = counts.get("candidates"), counts.get("universe"), counts.get("stage1")
    picks: list[Any] = raw_picks if isinstance(raw_picks, list) else []
    origins = [p.get("origin") for p in picks if isinstance(p, Mapping)]
    status = run.get("radar_status")
    return {
        "session": session,
        "radar_status": status if status in STATUSES else None,
        "run_at": _stamp(run.get("run_at")),
        "finished_at": _stamp(run.get("finished_at")),
        "late": _flag(run.get("late")),
        "gate_unset": _flag(run.get("gate_unset")),
        "radar_bars_ok": run.get("radar_bars_fetch") == "ok",
        "candidates": {**_part(cand, ("in_scope_symbols", "out_of_scope_symbols", "unknown_lists", "candidates",
                                      "core", "discovered")),
                       "rejected": _codes(cand.get("rejected") if isinstance(cand, Mapping) else None)},
        "universe": {**_part(uni, ("core", "candidates_gated", "admitted")),
                     "rejected": _codes(uni.get("rejected") if isinstance(uni, Mapping) else None)},
        "stage1": _part(st1, ("names", "data_valid", "ranked", "eligible", "picked")),
        "picks_from_radar": sum(1 for o in origins if o in ("radar", "both")),
    }


def block(root: Path = VAR) -> dict[str, Any] | None:
    """The shadow's status block, or None when the host has never run it (no folder)."""
    if not root.is_dir():
        return None
    sessions: list[dict[str, Any]] = []
    for folder in sorted(p for p in root.iterdir() if p.is_dir() and _DAY.fullmatch(p.name)):
        try:
            run = json.loads((folder / "run.json").read_text())
        except (OSError, ValueError):
            continue
        view = session_view(run) if isinstance(run, Mapping) else None
        if view is not None and view["session"] == folder.name:
            sessions.append(view)
    return {"mode": "shadow", "off": (root / OFF).exists(), "sessions": sessions[-MAX_SESSIONS:]}
