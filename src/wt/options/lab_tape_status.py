"""The options lab's tape, as one status block for the Paper page (DEC-0060, DEC-0067): each recorded session's
health and whether it counts for EXP-0052, the shadow period's progress, and what is archived.

Read from the session manifests' JSON on the host (and the archive's receipts beside them). It never imports the lab
(tests/unit/test_lab_boundary.py: nothing outside `wt.lab` imports it) and it carries counts, rates, dates and
statuses only: no symbol, no name, no price (SAFE, "Data classes" in AGENTS.md).

The counting rules are EXP-0052's `counting.session_counts_when`, checked here field by field from the manifest; a
session written by the v1 recorder, or before DEC-0067's first v2 session, never counts.
"""
from __future__ import annotations

import json
import os
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from wt.core.config import ROOT

FIRST_V2 = "2026-11-20"            # EXP-0052's first v2 session (DEC-0067 accepted and on the host that morning)
SHADOW = 5                         # EXP-0052 counting.shadow_sessions
MAX_SESSIONS = 20                  # the schema's cap: the newest are kept
STOPS = {"off switch": "off_switch", "sigterm": "stopped", "memory limit": "memory"}


def tape_root(env: Mapping[str, str]) -> Path:
    """As `wt.lab.recorder.tape_root`, which this module may not import: `WT_LAB_TAPE` or `lab-tape` beside the
    checkout."""
    return Path(env.get("WT_LAB_TAPE") or ROOT.parent / "lab-tape")


def _num(v: Any) -> float | None:
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def stop_code(stopped: Any) -> str | None:
    if not isinstance(stopped, str) or not stopped:
        return None
    if stopped in STOPS:
        return STOPS[stopped]
    if stopped.startswith("free disk"):
        return "disk"
    if stopped.endswith("errors in a row"):
        return "errors"
    if stopped.startswith("never finished"):
        return "never_finished"
    return "other"


def why_not(m: Mapping[str, Any]) -> list[str]:
    """The EXP-0052 counting rules a recorded session fails, as codes; empty when it would count."""
    if m.get("recorder") != 2 or str(m.get("session", "")) < FIRST_V2:
        return ["v1"]                                    # not measured the v2 way: the other rules cannot be read
    out = []
    if m.get("focus_session") != m.get("session"):
        out.append("no_focus")
    if not m.get("opening_complete"):
        out.append("opening")
    if (_num(m.get("coverage_fresh_strict")) or 0.0) < 0.99:
        out.append("fresh_coverage")
    if (_num(m.get("longest_stale_s")) or 0.0) > 300:
        out.append("stale_run")
    if any(abs(x) > 250 for x in (_num(m.get("clock_offset_ms")), _num(m.get("clock_offset_ms_end"))) if x is not None) \
            or _num(m.get("clock_offset_ms")) is None or _num(m.get("clock_offset_ms_end")) is None:
        out.append("clock")
    if (_num(m.get("tier1_crossed_share")) or 0.0) > 0.005:
        out.append("crossed")
    return out


def session(m: Mapping[str, Any], archived: bool) -> dict[str, Any]:
    ac = m.get("after_close") if isinstance(m.get("after_close"), Mapping) else {}
    prints = ac.get("prints") if isinstance(ac.get("prints"), Mapping) else {}
    oi = ac.get("open_interest") if isinstance(ac.get("open_interest"), Mapping) else {}
    listed = _num(oi.get("contracts"))
    nulls = _num(oi.get("null_open_interest"))
    recorded = bool(m.get("recorded"))
    fails = why_not(m) if recorded else ["not_recorded"]
    stale = m.get("stale_ticks_by_name") if isinstance(m.get("stale_ticks_by_name"), Mapping) else {}
    return {
        "date": str(m.get("session")),
        "recorder": 2 if m.get("recorder") == 2 else 1,
        "recorded": recorded,
        "counts": recorded and not fails,
        "why_not": fails,
        "partial": recorded and int(_num(m.get("ticks_down")) or 0) > 0,
        "coverage": _num(m.get("coverage")),
        "coverage_fresh": _num(m.get("coverage_fresh_strict")),
        "stale_ticks": int(_num(m.get("stale_ticks")) or 0) if "stale_ticks" in m else None,
        "stale_names": sum(1 for v in stale.values() if isinstance(v, int) and v > 0),
        "longest_stale_s": _num(m.get("longest_stale_s")),
        "ticks_down": int(_num(m.get("ticks_down")) or 0) if "ticks_down" in m else None,
        "restarts": int(_num(m.get("restarts")) or 0),
        "stopped": stop_code(m.get("stopped")),
        "tier1": int(_num(m.get("tier1_final")) or 0),
        "tier2": int(_num(m.get("tier2_final")) or 0),
        "crossed_share": _num(m.get("tier1_crossed_share")),
        "prints": int(_num(prints.get("prints")) or 0) if prints else None,
        "after_close_ok": recorded and not ac.get("error") and not ac.get("skipped") and not prints.get("failed"),
        "oi_null_share": round(nulls / listed, 4) if nulls is not None and listed else None,
        "archived": archived,
    }


def _receipt_ok(root: Path, day: str) -> bool:
    try:
        doc = json.loads((root / "receipts" / f"{day}.json").read_text())
    except (OSError, ValueError):
        return False
    return isinstance(doc, dict) and bool(doc.get("verified"))


def block(env: Mapping[str, str] | None = None, root: Path | None = None) -> dict[str, Any] | None:
    """The lab tape's status, or None when no session folder exists yet (the page then says so)."""
    r = root or tape_root(os.environ if env is None else env)
    if not r.exists():
        return None
    rows = []
    for f in sorted(p for p in r.iterdir() if p.is_dir() and len(p.name) == 10 and p.name[4] == "-"):
        try:
            m = json.loads((f / "manifest.json").read_text())
        except (OSError, ValueError):
            continue                                     # unfinished (no manifest yet) or unreadable: not listed
        if isinstance(m, dict):
            rows.append(session({**m, "session": m.get("session", f.name)}, _receipt_ok(r, f.name)))
    if not rows:
        return None
    v2 = [s for s in rows if s["recorder"] == 2 and s["date"] >= FIRST_V2 and s["recorded"]]
    shadow, after = v2[:SHADOW], v2[SHADOW:]
    for s in shadow:
        s["shadow"] = True
    for s in rows:
        s.setdefault("shadow", False)
    return {
        "first_v2": FIRST_V2,
        "shadow_done": len(shadow), "shadow_needed": SHADOW,
        "counted": sum(1 for s in after if s["counts"]),
        "recorded": sum(1 for s in rows if s["recorded"]),
        "archived": sum(1 for s in rows if s["recorded"] and s["archived"]),
        "sessions": rows[-MAX_SESSIONS:],
    }
