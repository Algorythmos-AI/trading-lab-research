"""Turn collected sources into the seven section documents the dashboard page renders.

Every builder tolerates any source being missing (``data`` is None): it shows what it can and says
what it could not. Documents are then validated against ``status.schema.json`` and shrunk to the
size cap, so a malformed or oversized document is never pushed.
"""
from __future__ import annotations

import copy
import datetime as dt
import json
from typing import Any

from wt.ops.status import DOC_CAP_BYTES, DOC_NAMES, ET, SCHEMA_PATH, SCHEMA_VERSION, SYD, iso, market_state

STATUS_WORDS = {"planned": "planned", "n_a": "not applicable", "needs_data": "need data"}
AUTO_ACTION_ORDER = ("cat01", "swap", "disk", "deployed", "wake", "registration", "old_root")


def _d(sources: dict, name: str) -> Any:
    s = sources.get(name) or {}
    return s.get("data") if s.get("ok") else None


def _src_status(sources: dict, names: list[str]) -> dict:
    return {n: {k: (sources.get(n) or {}).get(k) for k in ("ok", "stale", "as_of", "error")} for n in names}


def _fmt_r(x: float | None) -> str:
    return "n/a" if x is None else f"{x:+.3f}R"


# ---------------------------------------------------------------- owner actions


def owner_actions(sources: dict, cfg: dict) -> list[dict]:
    acts: list[dict] = []
    cat = _d(sources, "cat01")
    if cat and cat.get("verdicts_total") and cat["verdicts_done"] < cat["verdicts_total"]:
        left = cat["verdicts_total"] - cat["verdicts_done"]
        acts.append({"id": "cat01", "title": f"Record the {left} remaining catalyst verdicts (CAT-01)",
                     "why": f"The classifier scores {cat.get('accuracy_pct')}% against the {cat.get('target_pct'):.0f}% target. "
                            "Your verdicts decide whether round 3 can start.",
                     "blocks": "DEC-0010 and every round-3 run", "command": None, "link": cat.get("review_url"),
                     "severity": "blocker"})
    dep = _d(sources, "deployed")
    if dep and dep.get("behind"):
        acts.append({"id": "deployed", "title": f"Update ~/trading: it is {dep['behind']} commit(s) behind GitHub main",
                     "why": "launchd runs this checkout, so tonight's jobs lack: "
                            + "; ".join(c["subject"] for c in dep.get("missing", [])[-3:]),
                     "blocks": "Correct live runs", "command": "git -C ~/trading pull --ff-only",
                     "when": "After 06:40 Sydney, when no job is running", "link": None, "severity": "high"})
    host = _d(sources, "host")
    if host:
        if host["disk_free_gb"] < host["disk_floor_gb"]:
            need = host["disk_floor_gb"] - host["disk_free_gb"]
            acts.append({"id": "disk", "title": f"Free at least {need:.1f} GB of disk",
                         "why": f"{host['disk_free_gb']:.1f} GB free; the pool build needs {host['disk_floor_gb']:.0f} GB",
                         "blocks": "Building the round-3 candidate pool", "command": None, "link": None, "severity": "high"})
        uncovered = [w["needed"] for w in host.get("wake_coverage", []) if not w["covered"]]
        if uncovered:
            acts.append({"id": "wake", "title": f"Schedule a daily wake at {uncovered[0]}",
                         "why": "Nothing wakes the Mac for the 21:30 routine. pmset keeps one repeating wake, so this "
                                "replaces the 22:25 one; the routine keeps the Mac awake until paper B starts.",
                         "blocks": "Unattended routine runs", "command": f"sudo pmset repeat wakeorpoweron MTWRFSU {uncovered[0]}:00",
                         "link": None, "severity": "medium"})
        swap = host.get("swap") or {}
        if swap.get("used_pct", 0) >= host.get("swap_warn_pct", 85):
            acts.append({"id": "swap", "title": "Close memory-heavy apps before the live session",
                         "why": f"Swap is {swap['used_gb']:.1f} of {swap['total_gb']:.0f} GB. macOS adds 1 GB swap files "
                                f"on the same disk, which has {host['disk_free_gb']:.1f} GB free; a full disk would stop the jobs.",
                         "blocks": "Safe overnight runs", "command": None, "link": None, "severity": "high"})
        if host.get("old_root_exists"):
            acts.append({"id": "old_root", "title": "Rename ~/Documents/trading (migration step 0.12)",
                         "why": "The frozen pre-migration copy still sits under its original name",
                         "blocks": "Nothing; housekeeping",
                         "command": "mv ~/Documents/trading ~/Documents/trading.pre-migration",
                         "when": "After this Claude session ends (it runs from that folder)", "link": None,
                         "severity": "low"})
    rep = _d(sources, "repos")
    reg = (rep or {}).get("registration_pr") or {}
    if reg.get("state") == "OPEN":
        acts.append({"id": "registration", "title": f"Merge {reg['repo']}#{reg['number']}, then sync properties",
                     "why": "Registers trading-lab-research in the org catalog", "blocks": "Org validation of the repo",
                     "command": None, "link": reg.get("url"), "severity": "medium"})
    order = {k: i for i, k in enumerate(AUTO_ACTION_ORDER)}
    acts.sort(key=lambda a: order.get(a["id"], 99))
    for m in cfg.get("manual_actions", []):
        if not m.get("done"):
            acts.append({"id": m["id"], "title": m["title"], "why": m.get("why", ""), "blocks": m.get("blocks", ""),
                         "command": m.get("command"), "link": m.get("link"), "severity": "low", "manual": True})
    for i, a in enumerate(acts, 1):
        a["rank"] = i
        a.setdefault("manual", False)
        a.setdefault("when", None)
    return acts


# ---------------------------------------------------------------- documents


def build_overview(sources: dict, cfg: dict, now: dt.datetime) -> dict:
    res, spec, cat = _d(sources, "research"), _d(sources, "spec"), _d(sources, "cat01")
    paper, dep, host, org = _d(sources, "paper"), _d(sources, "deployed"), _d(sources, "host"), _d(sources, "org")
    legacy = _d(sources, "legacy")
    best = None
    if res:
        cands = [r for r in res["scoreboard"] if r.get("verdict") == "candidate" and r.get("span") == "development"
                 and r.get("expectancy_r") is not None]
        best = max(cands, key=lambda r: r["expectancy_r"], default=None)
    g1 = next((g for g in cfg.get("gates", []) if g["id"] == "G1"), {})
    edge = g1.get("status") == "passed"
    headline = "Edge proven at G1." if edge else "No proven edge yet."
    if cat and cat.get("verdicts_total") and cat["verdicts_done"] < cat["verdicts_total"]:
        left = cat["verdicts_total"] - cat["verdicts_done"]
        headline += f" Round 3 is waiting on {left} catalyst verdict{'s' if left != 1 else ''} from you."
    elif cat and cat.get("passed"):
        headline += " CAT-01 passes, so round 3 can run."
    sub = []
    if best:
        sub.append(f"Best candidate: {best['label']}, {_fmt_r(best['expectancy_r'])} over {best['n']} trades"
                   + (f", deflated Sharpe {best['dsr']:.2f} (needs 0.95)" if best.get("dsr") is not None else ""))
    orders = (legacy or {}).get("orders_placed", 0) + (paper or {}).get("trades", 0)
    sub.append("No order has ever been placed." if orders == 0 else f"{orders} paper trade(s) closed so far.")

    trials = cfg.get("trials", {})
    kpis = [
        {"id": "edge", "label": "Proven edge", "value": "Yes" if edge else "No", "state": "good" if edge else "bad",
         "detail": f"G1 failed after {trials.get('used', '?')} trials" if not edge else "G1 passed"},
        {"id": "trials", "label": "Trials used", "value": str(trials.get("used", "?")),
         "unit": f"of {trials.get('budget_if_round3', '?')}", "state": "neutral",
         "detail": "Round 3 adds 10 when DEC-0010 takes effect"},
    ]
    if cat:
        kpis.append({"id": "cat01", "label": "Catalyst accuracy", "value": f"{cat['accuracy_pct']:.0f}%" if cat.get("accuracy_pct") is not None else "n/a",
                     "unit": f"target {cat['target_pct']:.0f}%", "state": "good" if cat.get("passed") else "warn",
                     "detail": f"Your verdicts: {cat['verdicts_done']}/{cat.get('verdicts_total') or '?'}"})
    if spec:
        impl = spec["by_status"].get("implemented", 0)
        kpis.append({"id": "spec", "label": "SPEC-0001 coverage", "value": f"{impl}/{spec['total']}", "unit": "requirements",
                     "state": "good" if impl >= spec["total"] - 6 else "warn",
                     "detail": ", ".join(f"{v} {STATUS_WORDS.get(k, k)}" for k, v in sorted(spec["by_status"].items()) if k != "implemented")})
    if paper:
        g2 = paper["g2"]
        kpis.append({"id": "g2", "label": "G2 paper evidence", "value": f"{g2['trades']}/{g2['trades_needed']}",
                     "unit": "trades", "state": "neutral", "detail": f"{g2['sessions']}/{g2['sessions_needed']} sessions armed"})
    if org:
        kpis.append({"id": "org", "label": "Org backlog", "value": f"{org['items_done']}/{org['items_total']}", "unit": "issues done",
                     "state": "neutral", "detail": next((f"Next: {m['title']}" for m in org["milestones"] if m["state"] == "open"), "")})
    if dep:
        behind = dep.get("behind")
        kpis.append({"id": "deployed", "label": "Live code", "value": dep["head"],
                     "unit": "up to date" if behind == 0 else (f"{behind} behind main" if behind else "compare unavailable"),
                     "state": "good" if behind == 0 else ("bad" if behind else "warn"), "detail": dep.get("subject", "")})
    if host:
        low = host["disk_free_gb"] < host["disk_floor_gb"]
        kpis.append({"id": "disk", "label": "Disk free", "value": f"{host['disk_free_gb']:.1f}", "unit": "GB",
                     "state": "bad" if low else "good", "detail": f"Pool build needs {host['disk_floor_gb']:.0f} GB"})

    gates = []
    for g in cfg.get("gates", []):
        gg = dict(g)
        if g["id"] == "G2" and paper:
            g2 = paper["g2"]
            gg["progress"] = f"{g2['trades']}/{g2['trades_needed']} trades, {g2['sessions']}/{g2['sessions_needed']} sessions"
        gates.append(gg)
    return {"headline": headline, "subline": " ".join(sub), "kpis": kpis, "needs_you": owner_actions(sources, cfg),
            "gates": gates, "market": market_state(now),
            "sources": _src_status(sources, ["research", "spec", "cat01", "paper", "deployed", "host", "org", "repos", "legacy"])}


def build_research(sources: dict, cfg: dict) -> dict:
    res, cat = _d(sources, "research"), _d(sources, "cat01")
    return {"scoreboard": (res or {}).get("scoreboard", []), "cat01": cat, "round3": (res or {}).get("round3", []),
            "round3_experiments": (res or {}).get("round3_experiments", []),
            "decisions": (res or {}).get("decisions", []), "hypotheses": (res or {}).get("hypotheses", []),
            "active_strategies": (res or {}).get("active_strategies", []), "lessons": (res or {}).get("lessons", []),
            "trials": cfg.get("trials", {}), "dec0010_status": (res or {}).get("dec0010_status"),
            "sources": _src_status(sources, ["research", "cat01"])}


def build_spec(sources: dict) -> dict:
    spec = _d(sources, "spec") or {}
    return {**spec, "sources": _src_status(sources, ["spec"])}


def build_platform(sources: dict, cfg: dict) -> dict:
    org = _d(sources, "org") or {}
    return {"capabilities": cfg.get("capabilities", []), "milestones": org.get("milestones", []),
            "open_items": org.get("open_items", []), "priority": org.get("priority", []),
            "items_total": org.get("items_total"), "items_done": org.get("items_done"),
            "releases": org.get("releases", []), "runs": org.get("runs", []),
            "required_checks": org.get("required_checks"), "roadmap": cfg.get("roadmap", []),
            "v1_gate": ["All P0 and P1 issues closed", "20 consecutive scheduled sessions with a complete ledger",
                        "No unexplained aborts", "Evals green"],
            "sources": _src_status(sources, ["org"])}


def build_ops(sources: dict, now: dt.datetime) -> dict:
    host = _d(sources, "host") or {}
    errors = []
    for name, key in (("routine", "log"), ("routine", "launchd_err"), ("paper", "log"), ("forward", "log")):
        dig = (_d(sources, name) or {}).get(key) or {}
        for line in dig.get("errors", []):
            errors.append({"source": dig.get("file", name), "line": line})
    return {"market": market_state(now), "deployed": _d(sources, "deployed"), "routine": _d(sources, "routine"),
            "paper": _d(sources, "paper"), "forward": _d(sources, "forward"), "host": host,
            "account": _d(sources, "account"), "errors": errors[-30:],
            "sources": _src_status(sources, ["deployed", "routine", "paper", "forward", "host", "account"])}


def build_history(sources: dict, cfg: dict) -> dict:
    rep = _d(sources, "repos") or {}
    return {"legacy": _d(sources, "legacy"), "timeline": cfg.get("timeline", []), "repos": rep.get("repos", []),
            "registration_pr": rep.get("registration_pr"), "sources": _src_status(sources, ["legacy", "repos"])}


def build_meta(sources: dict, cfg: dict, now: dt.datetime, run_id: str, duration_s: float, collector: dict) -> dict:
    host = _d(sources, "host") or {}
    fresh = sum(1 for s in sources.values() if s.get("ok") and not s.get("stale"))
    return {"as_of": iso(now), "as_of_sydney": now.astimezone(SYD).strftime("%a %d %b %Y, %H:%M %Z"),
            "as_of_et": now.astimezone(ET).strftime("%a %d %b, %H:%M %Z"), "run_id": run_id,
            "duration_s": round(duration_s, 1), "refresh_minutes": cfg.get("refresh_minutes", 15),
            "sources": {n: {k: s.get(k) for k in ("ok", "stale", "as_of", "error", "ms")} for n, s in sources.items()},
            "fresh_sources": fresh, "total_sources": len(sources), "dst": host.get("dst", []),
            "collector": collector, "last_error": None}


def build_docs(sources: dict, cfg: dict, now: dt.datetime, run_id: str, duration_s: float, collector: dict) -> dict[str, dict]:
    docs = {
        "meta": build_meta(sources, cfg, now, run_id, duration_s, collector),
        "overview": build_overview(sources, cfg, now),
        "research": build_research(sources, cfg),
        "spec": build_spec(sources),
        "platform": build_platform(sources, cfg),
        "ops": build_ops(sources, now),
        "history": build_history(sources, cfg),
    }
    for name, d in docs.items():
        d["schema_version"] = SCHEMA_VERSION
        d["doc"] = name
        d["as_of"] = iso(now)
        d["run_id"] = run_id
    return docs


# ---------------------------------------------------------------- validation and size cap


def _size(doc: dict) -> int:
    return len(json.dumps(doc, separators=(",", ":"), default=str).encode())


def shrink(doc: dict, cap: int = DOC_CAP_BYTES) -> dict:
    """Halve the longest list until the document fits. Records what was cut in ``_truncated``."""
    doc = copy.deepcopy(doc)
    cut: dict[str, int] = {}
    for _ in range(200):
        if _size(doc) <= cap:
            break
        longest, path = None, None
        stack: list[tuple[Any, list]] = [(doc, [])]
        while stack:
            node, p = stack.pop()
            if isinstance(node, dict):
                stack.extend((v, p + [k]) for k, v in node.items())
            elif isinstance(node, list):
                if longest is None or len(node) > len(longest):
                    longest, path = node, p
                stack.extend((v, p + [i]) for i, v in enumerate(node))
        if not longest or len(longest) <= 1:
            break
        keep = len(longest) // 2
        cut[".".join(map(str, path))] = cut.get(".".join(map(str, path)), 0) + len(longest) - keep
        del longest[keep:]
    if cut:
        doc["_truncated"] = cut
    if _size(doc) > cap:
        raise ValueError(f"document {doc.get('doc')} is {_size(doc)} bytes after shrinking (cap {cap})")
    return doc


def load_schema() -> dict:
    return json.loads(SCHEMA_PATH.read_text())


def validate(docs: dict[str, dict], schema: dict | None = None) -> list[str]:
    """Problems found; empty means every document is valid and all seven are present."""
    import jsonschema

    schema = schema or load_schema()
    problems = []
    for name in DOC_NAMES:
        if name not in docs:
            problems.append(f"{name}: missing")
            continue
        sub = schema["definitions"].get(name)
        v = jsonschema.Draft7Validator({**schema, **sub}) if sub else None
        if v:
            for err in sorted(v.iter_errors(docs[name]), key=str)[:5]:
                where = "/".join(map(str, err.absolute_path)) or "(root)"
                problems.append(f"{name}: {where}: {err.message[:160]}")
        if _size(docs[name]) > DOC_CAP_BYTES:
            problems.append(f"{name}: {_size(docs[name])} bytes over the {DOC_CAP_BYTES} cap")
    return problems
