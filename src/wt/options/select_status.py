"""The Radar → Options shadow (DEC-0070), as one status block for the Radar page's pipeline card: for each recent
session the shadow ran for, what the Radar gave, what the gate kept and what Stage 1 scored, the job's own check of the
run (`check.json`, `wt.options.radar_select.check_run`: clean or the reason codes, the replay's word, how many of its
picks are in the published focus) and the progress toward the switch's five clean sessions.

    python -m wt.options.select_status progress [--root <dir>]

prints the same, one line a session, for a terminal on the host.

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
CHECK_SCHEMA = "wt.options/radar-select-check"  # wt.options.radar_select.CHECK_SCHEMA
CHECK_FILE = "check.json"
# wt.options.radar_select.NOT_CLEAN, REPLAY_WORDS, PUBLISHED_WORDS and CLEAN_NEEDED (copied, not imported: this module
# runs in the paper-options job, which must not load the selection's code; test_select_status holds them equal).
NOT_CLEAN = ("radar_not_ok", "late", "radar_bars_failed", "no_radar_candidates", "facts_missing", "replay_differs",
             "replay_error")
REPLAY_WORDS = ("reproduces", "differs", "error")
PUBLISHED_WORDS = ("ok", "other_session", "unreadable", "not_read")
CLEAN_NEEDED = 5
CHECK_INVALID = "check_invalid"      # the page's own code: a record that is not clean but gives no reason it knows
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


def check_view(doc: Any, session: str) -> dict[str, Any] | None:
    """A run's check record as the page reads it, or None when there is none or it is not for `session`. Clean only
    when the record says so and gives no reason; a reason outside the closed set is dropped, a record that says clean
    but gives any reason reads not clean, and one not clean with no known reason reads `check_invalid`."""
    if not isinstance(doc, Mapping) or doc.get("schema") != CHECK_SCHEMA or doc.get("session") != session:
        return None
    raw = doc.get("reasons")
    reasons = list(dict.fromkeys(r for r in raw if isinstance(r, str) and r in NOT_CLEAN)) if isinstance(raw, list) else []
    clean = doc.get("clean") is True and isinstance(raw, list) and not raw
    raw_pub = doc.get("published")
    pub: Mapping[str, Any] = raw_pub if isinstance(raw_pub, Mapping) else {}
    status = pub.get("status")
    status = status if status in PUBLISHED_WORDS else None
    replay = doc.get("replay")
    return {
        "checked_at": _stamp(doc.get("checked_at")),
        "clean": clean,
        "reasons": [] if clean else (reasons or [CHECK_INVALID]),
        "replay": replay if replay in REPLAY_WORDS else None,
        "universe_version": _count(doc.get("universe_version")),
        "verdicts": _count(doc.get("verdicts")),
        "verdicts_with_facts": _count(doc.get("verdicts_with_facts")),
        "published": {"status": status,
                      "overlap": _count(pub.get("overlap")) if status == "ok" else None,
                      "of": _count(pub.get("of")) if status == "ok" else None},
    }


def _read_check(folder: Path, session: str) -> dict[str, Any] | None:
    try:
        return check_view(json.loads((folder / CHECK_FILE).read_text()), session)
    except (OSError, ValueError):
        return None


def session_view(run: Mapping[str, Any], check: dict[str, Any] | None = None) -> dict[str, Any] | None:
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
        "check": check,
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
        view = session_view(run, _read_check(folder, folder.name)) if isinstance(run, Mapping) else None
        if view is not None and view["session"] == folder.name:
            sessions.append(view)
    progress = {"clean": sum(1 for v in sessions if (v["check"] or {}).get("clean") is True),
                "checked": sum(1 for v in sessions if v["check"] is not None),
                "runs": len(sessions), "needed": CLEAN_NEEDED}
    return {"mode": "shadow", "off": (root / OFF).exists(), "sessions": sessions[-MAX_SESSIONS:],
            "progress": progress}


def progress_lines(b: Mapping[str, Any] | None) -> list[str]:
    """The block for a terminal: the progress, then one line a session (codes and counts, no symbol)."""
    if b is None:
        return ["options-select: the shadow has never run on this host (no var/options-select)"]
    pr = b["progress"]
    out = [f"options-select: {pr['clean']} of {pr['needed']} clean sessions "
           f"({pr['checked']} checked of {pr['runs']} runs){' · OFF' if b['off'] else ''}"]
    for v in reversed(b["sessions"]):
        c = v["check"]
        if c is None:
            verdict = "no check"
        elif c["clean"]:
            verdict = "CLEAN"
        else:
            verdict = "not clean: " + ", ".join(c["reasons"])
        pub = (c or {}).get("published") or {}
        agree = f"{pub['overlap']} of {pub['of']} published" if pub.get("status") == "ok" else f"published {pub.get('status')}"
        cand = v["candidates"]["candidates"]
        out.append(f"  {v['session']}  {verdict:<46} radar {v['radar_status']}, {cand} candidates, "
                   f"replay {(c or {}).get('replay')}, facts {(c or {}).get('verdicts_with_facts')}/{(c or {}).get('verdicts')}, "
                   f"{agree}{', LATE' if v['late'] else ''}")
    return out


def main(argv: list[str] | None = None) -> int:
    import argparse
    ap = argparse.ArgumentParser(prog="python -m wt.options.select_status")
    ap.add_argument("cmd", choices=["progress"])
    ap.add_argument("--root", type=Path, default=VAR)
    args = ap.parse_args(argv)
    for line in progress_lines(block(args.root)):
        print(line)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
