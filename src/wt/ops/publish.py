"""Publish a sanitized status snapshot to the Vercel dashboard (plan PR 6).

    python -m wt.ops.publish [--dry-run] [--no-collect]

Pipeline:
  1. Run the collector (scripts/status_dashboard.py), which writes seven documents to var/dashboard/docs/.
  2. Build one snapshot from those documents, plus runtime extras: job heartbeats, firing alerts, the kill switch,
     the last deploy, preflight, expected activity windows and R series.
  3. Sanitize it against ALLOW, a declarative allowlist that fails closed:
     * a field that is not listed is dropped;
     * free text (T) is redacted, truncated and leak-checked against the restricted course corpus;
     * a text that shares any 8-word phrase with the corpus is withheld;
     * if the corpus can't be read, *strict* mode drops every free-text field.
  4. Validate against the JSON Schema generated from ALLOW (dashboard/src/lib/snapshot.schema.json). The Vercel
     ingest route enforces the same file, with unknown properties rejected.
  5. Sign with HMAC-SHA256 over "<timestamp>.<body>" and POST it with the deployment-protection bypass header.

Nothing RESTRICTED leaves the machine: spec text, decision and hypothesis prose, setup names, news headlines, review
links, log lines and commit subjects are never published (AGENTS.md "Data classes").
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import hmac
import json
import os
import re
import subprocess
import sys
import time
from collections import defaultdict
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import requests

from wt.core.clock import ET, et
from wt.core.config import DATA_DIR, FORWARD_LEDGER, ROOT, STATE_DIR
from wt.ops import safeio, thresholds

SCHEMA_ID = "trading-lab/snapshot"
SCHEMA_VERSION = 3                        # v3 only adds optional keys: every v2 snapshot is a valid v3 one
SCHEMA_PATH = ROOT / "dashboard" / "src" / "lib" / "snapshot.schema.json"
OUT = STATE_DIR / "dashboard"
MAX_BODY = 3_000_000                      # Vercel's request limit is 4.5 MB
BUDGET = 300_000                          # what a snapshot should stay under; over it prints a warning (not a failure)
TEXT_MAX, SHORT_MAX = 300, 200
LIST_MAX = 2000
NGRAM = 8


# ---- the allowlist -------------------------------------------------------------------------------------------------

@dataclass(frozen=True)
class Leaf:
    kind: str                             # S short string · T free text · N number · I integer · B boolean


@dataclass(frozen=True)
class OneOf:
    values: tuple[str, ...]               # a short string from a closed set (anything else publishes as null)


@dataclass(frozen=True)
class Map:
    value: Any                            # a dict with arbitrary short keys, each value following `value`


S, T, N, I, B = Leaf("S"), Leaf("T"), Leaf("N"), Leaf("I"), Leaf("B")
SOURCE = {"ok": B, "stale": B, "as_of": S, "error": T, "ms": I}
LOG = {"file": S, "exists": B, "bytes": I, "modified": S, "errors_count": I, "last_error": T}
LIMIT_STATE = OneOf(("ok", "warn", "at_limit", "n/a"))
SLA_STATUS = OneOf(("ok", "refused", "failed", "partial", "missed", "none", "n/a"))

ALLOW: dict[str, Any] = {
    "schema": S, "schema_version": I, "run_id": S, "as_of": S, "redaction": S, "withheld": I, "truncated": I,
    "collector": {"sha": S, "branch": S, "dirty": B, "exit_code": I, "fresh_sources": I, "total_sources": I,
                  "duration_s": N, "sources": Map(SOURCE)},
    "market": {"phase": S, "et": S, "sydney": S, "trading_day_et": S},
    "dst": [{"zone": S, "at_utc": S, "local_date": S, "from_offset": S, "to_offset": S, "days_away": I}],
    "overview": {
        "headline": T, "subline": T,
        "kpis": [{"id": S, "label": S, "value": S, "unit": S, "state": S, "detail": T}],
        "needs_you": [{"id": S, "rank": I, "title": T, "why": T, "blocks": T, "command": T, "when": T, "severity": S,
                       "manual": B}],
        "gates": [{"id": S, "name": S, "criteria": T, "status": S, "evidence": T, "next": T, "progress": T}]},
    "research": {
        "scoreboard": [{"label": S, "span": S, "verdict": S, "ref": S, "note": T, "n": I, "expectancy_r": N,
                        "ci_low": N, "ci_high": N, "profit_factor": N, "dsr": N, "win_rate": N,
                        "years_profitable": S, "error": T}],
        "cat01": {"accuracy_pct": N, "target_pct": N, "passed": B, "verdicts_done": I, "verdicts_total": I},
        "round3": [{"id": S, "set": S, "hyp_status": S, "run": B}],                 # IDs only, never setup names
        "decisions": [{"id": S, "date": S, "status": S}],                         # never titles
        "hypotheses": [{"id": S, "status": S, "stale": B}],                       # never names or statements
        "active_strategies": [S],
        "trials": {"used": I, "budget_if_round3": I, "in_force": I, "in_force_by": S, "proposed": I, "proposed_by": S,
                   "g1_failed_at": I},
        "dec0010_status": S,
        "lessons_count": I},
    "spec": {"spec_id": S, "version": S, "status": S, "total": I, "by_status": Map(I), "by_level": Map(I),
             "by_area": [{"area": S, "total": I, "implemented": I, "planned": I, "n_a": I, "needs_data": I}],
             "checklist": [{"total": I, "implemented": I, "state": S, "reqs": [S]}]},   # never requirement text
    "platform": {
        "backlog_repo": S, "ci_repo": S,
        "milestones": [{"key": S, "title": T, "state": S, "open": I, "closed": I, "p0_open": I}],
        "items_total": I, "items_done": I,
        "releases": [{"tagName": S, "name": T, "publishedAt": S, "isLatest": B}],
        "runs": [{"workflow": S, "conclusion": S, "created": S, "branch": S}], "required_checks": B,
        "roadmap": [{"rank": I, "priority": S, "title": T, "why": T, "owner": S}]},
    "ops": {
        "deployed": {"head": S, "branch": S, "committed": S, "modified": I, "untracked": I, "main": S, "behind": I,
                     "ahead": I},
        "routine": {"date": S, "stages": [{"stage": S, "as_of_et": S, "feed": S, "stats": Map(N), "counts": Map(I),
                                           "tier1": [{"symbol": S, "score": N}], "tier2": [S], "primary": S,
                                           "error": T}], "log": LOG},
        "paper": {"events": Map(I), "bad_lines": I, "armed_sessions": I, "last_armed": S, "trades": I, "total_r": N,
                  "mean_r": N, "virtual": {"equity": N, "start": N, "latched": B, "latch_reason": T},
                  "recent": [{"ts": S, "event": S, "detail": T}],
                  "g2": {"trades": I, "trades_needed": I, "sessions": I, "sessions_needed": I, "armed_sessions": I,
                         "incident_free_streak": I, "incident_free_needed": I, "agreement_level": S,
                         "agreement_days": I, "agreement_agree": I}, "log": LOG},
        "forward": {"exists": B, "sessions": I, "first": S, "last": S, "errors": I, "bad_lines": I,
                    "strategies": [{"strategy": S, "n": I, "mean_r": N, "total_r": N}], "latest_scorecard": S,
                    "log": LOG},
        "host": {"jobs": [{"label": S, "local_time": S, "name": S, "loaded": B, "running": B, "last_exit": I}],
                 "disk_free_gb": N, "disk_total_gb": N, "disk_floor_gb": N, "disk_target_gb": N, "swap_warn_pct": N,
                 "swap": {"total_gb": N, "used_gb": N, "free_gb": N, "used_pct": N},
                 "wake_coverage": [{"needed": S, "covered": B}],
                 "schedule": [{"job": S, "local": S, "et": S, "et_date": S, "session": B, "ok": B,
                               "must_start_before_et": S}]},
        "account": {"equity": N, "last_equity": N, "cash": N, "buying_power": N, "daytrade_count": I,
                    "pattern_day_trader": B, "status": S, "trading_blocked": B, "market_is_open": B, "next_open": S,
                    "next_close": S, "paper": B,
                    "positions": [{"symbol": S, "qty": N, "market_value": N, "unrealized_pl": N, "in_mandate": B,
                                   "legacy": B}]}},
    "jobs": {"last": Map({"status": S, "exit": I, "started": S, "ended": S, "sha": S, "detail": T}),
             "runs": [{"job": S, "status": S, "exit": I, "started": S, "ended": S, "sha": S}]},
    "alerts": {"firing": [{"key": S, "since": S, "title": T}],
               "history": [{"at": S, "key": S, "event": OneOf(("fired", "resolved")), "title": T, "priority": I}]},
    "kill": {"on": B, "since": S, "reason": T},
    "deploy": {"to": S, "rollback_tag": S, "at": S, "smoke_ok": B},
    "preflight": [{"name": S, "ok": B, "detail": T}],
    "expected_windows": [{"session": S, "start": S, "end": S}],
    "series": {"forward": [{"strategy": S, "session": S, "n": I, "cum_r": N}],
               "paper": [{"date": S, "equity": N, "cum_r": N, "trades": I}]},
    "history": {"timeline": [{"date": S, "event": T}],
                "legacy": {"total": I, "orders_placed": I, "first": S, "last": S, "by_outcome": Map(I)}},
    # ---- v3 (Wave 1a) ----
    "risk": {"limits": [{"id": S, "label": S, "limit": S, "used": S, "used_pct": N, "state": LIMIT_STATE,
                         "source": S, "source_sha": S}],
             "controls": {"kill": B, "latched": B, "latch_reason": S, "latch_resets": I, "last_reset": S,
                          "entries_allowed": B},
             "used_today": {"date": S, "day_pnl_pct": N, "week_pnl_pct": N, "drawdown_pct": N, "entries": I},
             "sources": Map(S)},
    "perf": {"stats": {"n": I, "excluded_estimated": I, "win_rate": N, "avg_win_r": N, "avg_loss_r": N,
                       "expectancy_r": N, "total_r": N, "sample_ok": B, "ci_low": N, "ci_high": N, "profit_factor": N,
                       "pf_no_losses": B, "sharpe": N},
             "sessions": I, "min_trades": I, "min_sessions": I, "max_dd_pct": N, "max_dd_r": N,
             "curve": [{"date": S, "equity_pct": N, "cum_r": N, "dd_pct": N, "dd_r": N}],
             "histogram": [{"bin": S, "count": I}],
             "band": {"available": B, "reason": S}},
    "blotter": [{"date": S, "symbol": S, "qty": N, "entry": N, "exit": N, "stop": N, "r": N, "reason": S, "origin": S,
                 "estimated": B, "booked": B}],
    "sla": {"days": [S], "cells": [{"job": S, "date": S, "status": SLA_STATUS, "runs": I}],
            "summary": [{"job": S, "expected": I, "ok": I, "refused": I, "failed": I, "missed": I, "ok_pct": N}]},
    "digest": {"since": S, "items": [{"key": S, "label": S, "prev": S, "now": S, "changed": B}]},
    "audit": {"chain_ok": B, "chain_bad_seq": I, "events": [{"at": S, "kind": S, "source": S, "detail": T}]},
}
REQUIRED = ("schema", "schema_version", "run_id", "as_of")
_KEY = re.compile(r"^[\w.:+\- /|]{1,64}$")


def to_schema(spec: Any = ALLOW, top: bool = True) -> dict[str, Any]:
    """JSON Schema (draft-07) for the sanitized snapshot. Unknown properties are rejected everywhere."""
    if isinstance(spec, Leaf):
        leaves: dict[str, dict[str, Any]] = {"S": {"type": ["string", "null"], "maxLength": SHORT_MAX},
                "T": {"type": ["string", "null"], "maxLength": TEXT_MAX},
                "N": {"type": ["number", "null"]}, "I": {"type": ["integer", "null"]},
                "B": {"type": ["boolean", "null"]}}
        return leaves[spec.kind]
    if isinstance(spec, OneOf):
        return {"enum": [*spec.values, None]}
    if isinstance(spec, Map):
        return {"type": ["object", "null"], "propertyNames": {"pattern": _KEY.pattern},
                "additionalProperties": to_schema(spec.value, False), "maxProperties": 200}
    if isinstance(spec, list):
        return {"type": ["array", "null"], "items": to_schema(spec[0], False), "maxItems": LIST_MAX}
    out: dict[str, Any] = {"type": "object" if top else ["object", "null"], "additionalProperties": False,
                           "properties": {k: to_schema(v, False) for k, v in spec.items()}}
    if top:
        out = {"$schema": "http://json-schema.org/draft-07/schema#", "$id": SCHEMA_ID,
               "title": "Trading Lab published status snapshot (generated from wt.ops.publish.ALLOW)",
               **out, "required": list(REQUIRED)}
    return out


# ---- leak check --------------------------------------------------------------------------------------------------

def _tokens(text: str) -> list[str]:
    return re.findall(r"[a-z0-9]+", text.lower())


def _grams(tokens: list[str], n: int = NGRAM) -> Iterable[str]:
    return (" ".join(tokens[i:i + n]) for i in range(len(tokens) - n + 1))


def _h(gram: str) -> int:
    return int.from_bytes(hashlib.blake2b(gram.encode(), digest_size=8).digest(), "big", signed=True)


def corpus_files(root: Path = ROOT) -> list[Path]:
    """The restricted material: course extraction batches, K0 deliverables and the spec sources."""
    pats = ["knowledge/_work/batches/*.txt", "knowledge/*.md", "research/specs/**/*.md", "research/specs/**/*.txt"]
    return sorted({p for pat in pats for p in root.glob(pat) if p.is_file()})


class LeakIndex:
    """Sorted 64-bit hashes of every 8-word phrase in the corpus, cached until a corpus file changes."""

    def __init__(self, files: list[Path], cache: Path | None = None) -> None:
        self.files = files
        self.hashes = np.array([], dtype=np.int64)
        if not files:
            return
        sig = hashlib.sha256("\n".join(f"{p}:{p.stat().st_size}:{p.stat().st_mtime_ns}" for p in files).encode())
        tag = sig.hexdigest()[:16]
        if cache is not None and (cache / f"leak_{tag}.npy").exists():
            self.hashes = np.load(cache / f"leak_{tag}.npy")
            return
        hs: set[int] = set()
        for p in files:
            hs.update(_h(g) for g in _grams(_tokens(p.read_text(encoding="utf-8", errors="replace"))))
        self.hashes = np.array(sorted(hs), dtype=np.int64)
        if cache is not None:
            cache.mkdir(parents=True, exist_ok=True)
            for old in cache.glob("leak_*.npy"):
                old.unlink(missing_ok=True)
            np.save(cache / f"leak_{tag}.npy", self.hashes)

    @property
    def available(self) -> bool:
        return len(self.hashes) > 0

    def leaks(self, text: str) -> bool:
        grams = [_h(g) for g in _grams(_tokens(text))]
        if not grams or not self.available:
            return False
        q = np.array(grams, dtype=np.int64)
        idx = np.clip(np.searchsorted(self.hashes, q), 0, len(self.hashes) - 1)
        return bool(np.any(self.hashes[idx] == q))


# ---- sanitizing ----------------------------------------------------------------------------------------------------

@dataclass
class Sanitizer:
    redact: Callable[[Any], Any]
    leak: LeakIndex | None
    strict: bool
    withheld: int = 0
    truncated: int = 0                    # list items dropped by the per-list cap (the oldest go first)

    def text(self, v: Any, limit: int) -> str | None:
        if v is None:
            return None
        s = str(self.redact(str(v)))
        s = s if len(s) <= limit else s[: limit - 1] + "…"
        if self.leak is not None and self.leak.leaks(s):
            self.withheld += 1
            return None
        return s

    def apply(self, spec: Any, v: Any) -> Any:
        if v is None:
            return None
        if isinstance(spec, Leaf):
            k = spec.kind
            if k == "B":
                return v if isinstance(v, bool) else None
            if k == "N":
                return float(v) if isinstance(v, int | float) and not isinstance(v, bool) and np.isfinite(v) else None
            if k == "I":
                if isinstance(v, bool):
                    return None
                if isinstance(v, int):
                    return v
                return int(v) if isinstance(v, float) and v.is_integer() else None
            if k == "S":
                return self.text(v, SHORT_MAX) if isinstance(v, str | int | float) else None
            return None if self.strict else self.text(v, TEXT_MAX) if isinstance(v, str) else None
        if isinstance(spec, OneOf):
            return v if isinstance(v, str) and v in spec.values else None
        if isinstance(spec, Map):
            if not isinstance(v, dict):
                return None
            return {str(k): self.apply(spec.value, x) for k, x in list(v.items())[:200] if _KEY.match(str(k))}
        if isinstance(spec, list):
            if not isinstance(v, list):
                return None
            if len(v) > LIST_MAX:                 # builders append in time order: keep the newest
                self.truncated += len(v) - LIST_MAX
                v = v[-LIST_MAX:]
            return [self.apply(spec[0], x) for x in v]
        if not isinstance(v, dict):
            return None
        return {k: self.apply(s, v[k]) for k, s in spec.items() if k in v}


# ---- building the snapshot -----------------------------------------------------------------------------------------

_EXC = re.compile(r"\b([A-Z][A-Za-z0-9]*(?:Error|Exception|Timeout|Exit|Interrupt))\b")


def codeify(text: Any) -> str | None:
    """A short code for free text that must not leave the machine as written: exception messages, log lines,
    runner reasons. The exception class when there is one ("TransportError"), else "error"."""
    if text is None or text == "":
        return None
    m = _EXC.search(str(text))
    return m.group(1) if m else "error"


def blocker_codes(blockers: Any) -> str:
    """Runner blockers carry detail after a colon ("latched:daily loss limit -2%"); publish only the kind."""
    kinds = {str(b).split(":", 1)[0] for b in (blockers or [])}
    return ", ".join(sorted(k for k in kinds if k))


def _log(d: Any) -> dict[str, Any] | None:
    if not isinstance(d, dict):
        return None
    errs = d.get("errors") or []
    return {"file": d.get("file"), "exists": d.get("exists"), "bytes": d.get("bytes"), "modified": d.get("modified"),
            "errors_count": len(errs), "last_error": codeify(errs[-1]) if errs else None}


def _paper(p: dict[str, Any]) -> dict[str, Any]:
    """Paper events: the kind of each blocker and the class of each error, never the raw text."""
    recent = []
    for r in p.get("recent") or []:
        if not isinstance(r, dict):
            continue
        got = r.get("raw")
        raw: dict[str, Any] = got if isinstance(got, dict) else {}
        if raw.get("blockers"):
            detail: str | None = blocker_codes(raw["blockers"])
        elif raw.get("error"):
            detail = codeify(raw["error"])
        elif raw.get("reason"):
            detail = codeify(raw["reason"]) if raw.get("event") != "refuse_to_arm" else "refused"
        else:
            detail = str(raw.get("day") or "") or None
        recent.append({"ts": r.get("ts"), "event": r.get("event"), "detail": detail})
    return {**p, "recent": recent}


def private_action_ids(cfg_path: Path = ROOT / "config" / "dashboard.yaml") -> set[str]:
    """Owner actions marked `private: true` in the dashboard config never leave the machine."""
    import yaml
    try:
        cfg = yaml.safe_load(cfg_path.read_text()) or {}
    except (OSError, yaml.YAMLError):
        return {"webull-key"}                       # fail closed on the one we know is sensitive
    return {str(a.get("id")) for a in cfg.get("manual_actions") or [] if isinstance(a, dict) and a.get("private")}


def from_docs(docs: dict[str, Any], private_ids: set[str] | None = None) -> dict[str, Any]:
    """Map the collector's seven documents onto the snapshot layout (before the allowlist)."""
    meta, ov, rs, sp = docs.get("meta", {}), docs.get("overview", {}), docs.get("research", {}), docs.get("spec", {})
    hide = private_action_ids() if private_ids is None else private_ids
    ov = {**ov, "needs_you": [a for a in ov.get("needs_you") or [] if isinstance(a, dict) and str(a.get("id")) not in hide]}
    ops, hist = dict(docs.get("ops", {})), docs.get("history", {})
    for part in ("routine", "paper", "forward"):
        if isinstance(ops.get(part), dict):
            ops[part] = {**ops[part], "log": _log(ops[part].get("log"))}
    if isinstance(ops.get("paper"), dict):
        ops["paper"] = _paper(ops["paper"])
    sources = meta.get("sources") if isinstance(meta.get("sources"), dict) else {}
    sources = {k: ({**v, "error": codeify(v.get("error"))} if isinstance(v, dict) else v) for k, v in sources.items()}
    return {
        "collector": {**(meta.get("collector") or {}), "exit_code": meta.get("exit_code"),
                      "fresh_sources": meta.get("fresh_sources"), "total_sources": meta.get("total_sources"),
                      "duration_s": meta.get("duration_s"), "sources": sources},
        "market": ov.get("market") or ops.get("market"), "dst": meta.get("dst"),
        "overview": ov, "research": {**rs, "lessons_count": len(rs.get("lessons") or [])}, "spec": sp,
        "platform": docs.get("platform", {}), "ops": ops,
        "history": {"timeline": hist.get("timeline"), "legacy": hist.get("legacy")},
    }


def _read_jsonl(p: Path) -> list[dict[str, Any]]:
    rows, _ = safeio.read_jsonl(p) if p.exists() else ([], 0)
    return [r for r in rows if isinstance(r, dict)]


def forward_series(ledger: Path = FORWARD_LEDGER) -> list[dict[str, Any]]:
    by: dict[tuple[str, str], list[float]] = defaultdict(list)
    for r in _read_jsonl(ledger):
        if r.get("session_marker") or r.get("strategy_marker") or not isinstance(r.get("R"), int | float):
            continue
        by[(str(r.get("strategy")), str(r.get("session")))].append(float(r["R"]))
    out: list[dict[str, Any]] = []
    cum: defaultdict[str, float] = defaultdict(float)
    for (strat, sess), rs in sorted(by.items(), key=lambda kv: (kv[0][1], kv[0][0])):
        cum[strat] += sum(rs)
        out.append({"strategy": strat, "session": sess, "n": len(rs), "cum_r": round(cum[strat], 4)})
    return out


def paper_series(journal: Path = DATA_DIR / "live" / "journal.jsonl") -> list[dict[str, Any]]:
    days: dict[str, dict[str, Any]] = {}
    cum = 0.0
    for r in _read_jsonl(journal):
        day = str(r.get("day") or str(r.get("ts", ""))[:10])
        if r.get("event") == "trade_closed" and isinstance(r.get("R"), int | float):
            cum += float(r["R"])
            d = days.setdefault(day, {"date": day, "equity": None, "cum_r": cum, "trades": 0})
            d["cum_r"], d["trades"] = round(cum, 4), d["trades"] + 1
        if r.get("event") == "session_end" and isinstance((r.get("virtual") or {}).get("equity"), int | float):
            d = days.setdefault(day, {"date": day, "equity": None, "cum_r": round(cum, 4), "trades": 0})
            d["equity"] = float(r["virtual"]["equity"])
    return [days[k] for k in sorted(days)]


def expected_windows(now: dt.datetime, sessions: dict[dt.date, Any], hours: int = 48) -> list[dict[str, str]]:
    """When the Mac should be publishing: from 07:30 ET (the routine is up) to close + 2 h, next 48 hours."""
    out = []
    for d, s in sorted(sessions.items()):
        start, end = et(d, "07:30"), s.close + dt.timedelta(hours=2)
        if end > now and start < now + dt.timedelta(hours=hours):
            out.append({"session": d.isoformat(), "start": start.astimezone(dt.UTC).isoformat(),
                        "end": end.astimezone(dt.UTC).isoformat()})
    return out


def v3_views(now: dt.datetime, *, runs: list[dict[str, Any]], sessions: dict[dt.date, Any], kill: bool,
             root: Path = ROOT, live: Path = DATA_DIR / "live", alert_dir: Path | None = None,
             deploy_dir: Path | None = None, audit_log: Path | None = None) -> dict[str, Any]:
    """The Wave 1a sections: risk, perf, blotter, sla, audit and the alert history (the digest is added in
    _publish, from the built snapshot)."""
    from wt.analytics import ops_view, performance, risk_view
    from wt.ops import audit
    from wt.ops.alerts import ALERT_DIR
    today = now.astimezone(ET).date()
    journal = _read_jsonl(live / "journal.jsonl")
    trades = [r for r in journal if r.get("event") == "trade_closed"]
    armed_days = {str(r.get("day") or str(r.get("ts", ""))[:10]) for r in journal if r.get("event") == "armed"}
    account = risk_view.load_account(live / "virtual_account.json")
    curve = performance.curve(trades, start_equity=float((account or {}).get("start_equity") or 600.0))
    dd_pct, dd_r = performance.max_drawdown(curve)
    history = _read_jsonl((alert_dir or ALERT_DIR) / "history.jsonl")
    rows = audit.read(audit_log or audit.AUDIT)
    chain_ok, bad = audit.verify(rows)
    return {
        "risk": risk_view.view(today, account, kill, root=root),
        "perf": {"stats": performance.stats(trades, sessions=len(armed_days)), "sessions": len(armed_days),
                 "min_trades": thresholds.MIN_TRADES_STATS, "min_sessions": thresholds.MIN_SESSIONS_SHARPE,
                 "max_dd_pct": dd_pct, "max_dd_r": dd_r, "curve": curve, "histogram": performance.histogram(trades),
                 "band": {"available": False, "reason": "no expectation band until the DEC-0011 re-runs"}},
        "blotter": ops_view.blotter(journal),
        "sla": ops_view.sla(runs, today, sessions),
        "audit": {"chain_ok": chain_ok, "chain_bad_seq": bad,
                  "events": ops_view.audit_trail(deploys=sorted((deploy_dir or STATE_DIR / "deploy").glob("*.json")),
                                                 account=account, runs=runs, alert_history=history,
                                                 audit_rows=rows)},
        "alerts_history": ops_view.alert_log(history),
    }


def add_digest(snap: dict[str, Any], san: Sanitizer, now: dt.datetime, daily_dir: Path = OUT / "daily") -> None:
    from wt.analytics import ops_view
    try:
        d = ops_view.digest(ops_view.digest_metrics(snap), daily_dir, now.astimezone(ET).date())
    except Exception as e:  # noqa: BLE001 — as above: the digest is optional, the publish is not
        print(f"digest failed ({e.__class__.__name__})", file=sys.stderr)
        d = {"since": None, "items": []}
    snap["digest"] = san.apply(ALLOW["digest"], d)


def extras(now: dt.datetime, root: Path = ROOT) -> dict[str, Any]:
    from wt.ops import preflight
    from wt.ops.alerts import Alerts
    from wt.ops.heartbeat import HEARTBEAT_DIR, last_runs
    from wt.ops.window import load_sessions
    runs = _read_jsonl(HEARTBEAT_DIR / "runs.jsonl")
    cutoff = (now - dt.timedelta(days=14)).isoformat()
    kill = root / "KILL"
    deploys = sorted((STATE_DIR / "deploy").glob("*.json"))
    last_deploy: dict[str, Any] = {}
    if deploys:
        try:
            d = json.loads(deploys[-1].read_text())
            last_deploy = {"to": str(d.get("to", ""))[:12], "rollback_tag": d.get("rollback_tag"),
                           "at": deploys[-1].stem, "smoke_ok": d.get("smoke_ok")}
        except (OSError, json.JSONDecodeError):
            pass
    sessions, _ = load_sessions(now, back=20)
    try:
        views = v3_views(now, runs=runs, sessions=sessions, kill=kill.exists(), root=root)
    except Exception as e:  # noqa: BLE001 — a new view must never stop the publish the watchdog depends on
        print(f"v3 views failed ({e.__class__.__name__}); publishing without them", file=sys.stderr)
        views = {"alerts_history": None}
    last = last_runs()
    prev = next((r for r in reversed(runs) if r.get("job") == "dashboard"), None)
    if prev is not None:                # this run is the one collecting: show the previous, completed publish
        last["dashboard"] = {**prev, "detail": "previous publish"}
    else:
        last.pop("dashboard", None)
    return {
        "jobs": {"last": last, "runs": [r for r in runs if str(r.get("started", "")) >= cutoff][-500:]},
        "alerts": {"firing": [{"key": k, "since": v.get("since"), "title": v.get("title")}
                              for k, v in sorted(Alerts().firing().items())],
                   "history": views.pop("alerts_history")},
        "kill": {"on": kill.exists(),
                 "since": dt.datetime.fromtimestamp(kill.stat().st_mtime, dt.UTC).isoformat() if kill.exists() else None,
                 "reason": None},              # the KILL file's note is the owner's free text: it stays local
        "deploy": last_deploy,
        "preflight": [{"name": c.name, "ok": c.ok, "detail": c.detail} for c in preflight.run_checks(root)],
        "expected_windows": expected_windows(now, sessions),
        "series": {"forward": forward_series(), "paper": paper_series()},
        **views,
    }


def build(docs: dict[str, Any], extra: dict[str, Any], san: Sanitizer, run_id: str, now: dt.datetime) -> dict[str, Any]:
    raw = {**from_docs(docs), **extra}
    clean: dict[str, Any] = san.apply(ALLOW, raw)
    clean.update(schema=SCHEMA_ID, schema_version=SCHEMA_VERSION, run_id=run_id,
                 as_of=now.isoformat(timespec="seconds"), redaction="strict" if san.strict else "standard",
                 withheld=san.withheld, truncated=san.truncated)
    return clean


def validate(snapshot: dict[str, Any], schema_path: Path = SCHEMA_PATH) -> list[str]:
    import jsonschema
    schema = json.loads(schema_path.read_text()) if schema_path.exists() else to_schema()
    v = jsonschema.Draft7Validator(schema)
    return [f"{'/'.join(map(str, e.absolute_path))}: {e.message[:160]}" for e in v.iter_errors(snapshot)][:20]


# ---- signing and sending -------------------------------------------------------------------------------------------

def sign(body: bytes, secret: str, ts: int) -> str:
    return "sha256=" + hmac.new(secret.encode(), f"{ts}.".encode() + body, hashlib.sha256).hexdigest()


def send(body: bytes, url: str, secret: str, bypass: str | None, tries: int = 3) -> tuple[bool, str]:
    last = ""
    for i in range(tries):
        ts = int(time.time())
        headers = {"content-type": "application/json", "x-wt-timestamp": str(ts),
                   "x-wt-signature": sign(body, secret, ts)}
        if bypass:
            headers["x-vercel-protection-bypass"] = bypass
        try:
            r = requests.post(url, data=body, headers=headers, timeout=20)
            if 200 <= r.status_code < 300:
                return True, f"HTTP {r.status_code}"
            last = f"HTTP {r.status_code}: {r.text[:160]}"
            if r.status_code in (400, 401, 403, 409, 413, 422):
                return r.status_code == 409, last          # 409: a newer snapshot is already stored; not an error
        except requests.RequestException as e:
            last = e.__class__.__name__
        time.sleep(2 ** (i + 1))
    return False, last


# ---- main --------------------------------------------------------------------------------------------------------

def collect(root: Path = ROOT, out: Path = OUT) -> int:
    """Run the collector as a child process. Exit 0/1 both leave usable documents."""
    r = subprocess.run([sys.executable, "scripts/status_dashboard.py", "--with-account", "--out", str(out)], cwd=root,
                       env={**os.environ, "PYTHONPATH": "src"}, capture_output=True, text=True, timeout=300)
    return r.returncode


def load_docs(out: Path = OUT) -> dict[str, Any]:
    docs = {}
    for p in sorted((out / "docs").glob("*.json")):
        docs[p.stem] = safeio.read_json(p)
    return docs


PUBLISH_STATE = OUT / "publish_state.json"
ALERT_AFTER_FAILURES = 2          # one failed publish is noise; the second in a row fails the job (and alerts)
LOCK_WAIT_S = 60.0                # `make publish` while the 15-minute job runs: wait a little, then give way


def error_code(detail: str) -> str:
    """A fixed code for a send failure ("http_503", "network_ConnectTimeout"): never the response text."""
    m = re.match(r"HTTP (\d{3})", detail)
    if m:
        return f"http_{m.group(1)}"
    return "network_" + re.sub(r"[^A-Za-z0-9]", "", detail)[:40] if detail else "unknown"


def record_outcome(ok: bool, detail: str, now: dt.datetime, path: Path | None = None) -> dict[str, Any]:
    """Keep {last_attempt, last_ok, consecutive_failures, last_error_code} across runs. Never raises."""
    path = path or PUBLISH_STATE
    try:
        st: dict[str, Any] = json.loads(path.read_text())
    except (OSError, ValueError):
        st = {}
    st["last_attempt"] = now.isoformat()
    if ok:
        st.update(last_ok=now.isoformat(), consecutive_failures=0, last_error_code=None)
    else:
        st.update(consecutive_failures=int(st.get("consecutive_failures") or 0) + 1, last_error_code=error_code(detail))
    try:
        safeio.atomic_write(path, json.dumps(st, indent=1), path.parent)
    except OSError:
        pass
    return st


def health_url(ingest_url: str) -> str:
    return re.sub(r"/api/ingest/?$", "/api/health", ingest_url)


def verify_stored(snap: dict[str, Any], url: str, bypass: str | None) -> tuple[bool, str]:
    """Read /api/health back and check it now serves this snapshot (run_id and as_of)."""
    headers = {"x-vercel-protection-bypass": bypass} if bypass else {}
    try:
        r = requests.get(health_url(url), headers=headers, timeout=20)
        h = r.json()
    except (requests.RequestException, ValueError) as e:
        return False, f"health unreadable ({e.__class__.__name__})"
    got = (h.get("snapshot_run_id"), h.get("snapshot_as_of"))
    want = (snap["run_id"], snap["as_of"])
    if got[0] != want[0]:
        return False, f"health serves run {got[0]} as of {got[1]}, expected {want[0]}"
    return True, f"health serves run {got[0]} as of {got[1]}"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m wt.ops.publish")
    ap.add_argument("--dry-run", action="store_true", help="build and validate, write the outbox, don't send")
    ap.add_argument("--no-collect", action="store_true", help="reuse the last collector documents")
    ap.add_argument("--verify", action="store_true", help="after sending, read /api/health back and check it")
    a = ap.parse_args(argv)
    from wt.ops.locks import job_lock
    with job_lock("publish", wait_s=LOCK_WAIT_S) as got:
        if not got:
            print("another publish is still running; not starting a second one")
            return 0
        return _publish(a)


def _publish(a: argparse.Namespace) -> int:
    now = dt.datetime.now(dt.UTC).replace(microsecond=0)
    if not a.no_collect:
        code = collect()
        if code not in (0, 1):
            print(f"collector failed with exit {code}; publishing the last good documents", file=sys.stderr)
    docs = load_docs()
    if not docs:
        print("no collector documents to publish", file=sys.stderr)
        return 2
    redact = safeio.Redactor(safeio.env_secret_values([ROOT / ".env"]))
    leak = LeakIndex(corpus_files(), cache=OUT / "cache")
    san = Sanitizer(redact, leak if leak.available else None, strict=not leak.available)
    run_id = now.strftime("%Y%m%dT%H%M%SZ") + "-" + hashlib.sha1(os.urandom(8)).hexdigest()[:6]
    snap = build(docs, extras(now), san, run_id, now)
    add_digest(snap, san, now)
    problems = validate(snap)
    if problems:
        print("snapshot failed schema validation:\n  " + "\n  ".join(problems), file=sys.stderr)
        return 2
    body = json.dumps(snap, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    if len(body) > MAX_BODY:
        print(f"snapshot is {len(body)} bytes, over the {MAX_BODY} cap", file=sys.stderr)
        return 2
    if len(body) > BUDGET:
        print(f"warning: snapshot is {len(body)} bytes, over the {BUDGET} budget (the page gets slow)", file=sys.stderr)
    (OUT / "outbox").mkdir(parents=True, exist_ok=True)
    safeio.atomic_write(OUT / "outbox" / "snapshot.json", body.decode(), OUT)
    print(f"snapshot {run_id}: {len(body)} bytes, redaction={snap['redaction']}, withheld={snap['withheld']}")
    if a.dry_run:
        return 0
    url, secret = os.environ.get("DASHBOARD_INGEST_URL"), os.environ.get("DASHBOARD_INGEST_SECRET")
    if not url or not secret:
        print("DASHBOARD_INGEST_URL / DASHBOARD_INGEST_SECRET not set: not sending (run provision_secrets.sh)")
        return 0
    bypass = os.environ.get("VERCEL_AUTOMATION_BYPASS_SECRET")
    ok, detail = send(body, url, secret, bypass)
    st = record_outcome(ok, detail, now)
    print(f"sent: {ok} ({error_code(detail) if not ok else detail}); consecutive failures {st['consecutive_failures']}")
    if ok and a.verify:
        good, why = verify_stored(snap, url, bypass)
        print(f"verify: {'ok' if good else 'FAILED'}: {why}")
        return 0 if good else 1
    if not ok and st["consecutive_failures"] < ALERT_AFTER_FAILURES:
        print("first failure in a row: not failing the job yet (the next one alerts)")
        return 0
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
