"""Status dashboard collector: one read-only snapshot of research, operations and the org backlog.

Each source is collected independently. A source that fails falls back to its last good result
(``cache/<source>.json``, marked stale) so one broken input never blanks the page. The sources are
then assembled into seven section documents (``meta``, ``overview``, ``research``, ``spec``,
``platform``, ``ops``, ``history``), each validated against ``status.schema.json`` and capped in
size before anything is written.

Nothing here writes outside the output root, and the live checkout (``deployed_root``) is only read.
"""
from __future__ import annotations

import csv
import datetime as dt
import io
import json
import re
import time
from collections import Counter, defaultdict
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import yaml

from wt.analytics import forward_book, g2
from wt.ops import safeio, thresholds
from wt.ops.safeio import SourceError

SYD = ZoneInfo("Australia/Sydney")
ET = ZoneInfo("America/New_York")
UTC = dt.timezone.utc
SCHEMA_VERSION = 1
DOC_NAMES = ("meta", "overview", "research", "spec", "platform", "ops", "history")
DOC_CAP_BYTES = 200 * 1024
REPO_ROOT = Path(__file__).resolve().parents[3]
SCHEMA_PATH = Path(__file__).with_name("status.schema.json")


# ---------------------------------------------------------------- context and source wrapper


@dataclass
class Ctx:
    cfg: dict
    root: Path              # research checkout (registry, spec, experiments)
    deployed: Path          # live checkout, read only
    org: Path
    old: Path
    out: Path               # output root; every write is confined here
    now: dt.datetime        # aware UTC
    github: bool = True
    with_account: bool = False
    deadline: float = 0.0   # time.monotonic() value

    def timeout(self, want: float = 20.0) -> float:
        left = self.deadline - time.monotonic()
        if left <= 2:
            raise SourceError("run deadline reached")
        return min(want, left - 1)

    def run(self, cmd: list[str], want: float = 20.0, cwd: Path | None = None) -> str:
        return safeio.run(cmd, timeout=self.timeout(want), cwd=cwd)

    def gh_json(self, args: list[str], want: float = 25.0) -> Any:
        if not self.github:
            raise SourceError("GitHub skipped (--no-github)")
        out = self.run(["gh", *args], want)
        try:
            return json.loads(out) if out.strip() else None
        except json.JSONDecodeError as e:
            raise SourceError(f"gh {args[0]} returned non-JSON") from e


def iso(t: dt.datetime) -> str:
    return t.astimezone(UTC).isoformat(timespec="seconds")


def _short_error(e: BaseException) -> str:
    if isinstance(e, SourceError):
        return str(e)[:200]
    return f"{type(e).__name__}: {str(e)[:160]}"


def collect(name: str, fn: Callable[[Ctx], Any], ctx: Ctx) -> dict:
    """Run one source. On any failure fall back to the cached last good result, marked stale."""
    t0 = time.monotonic()
    cache = ctx.out / "cache" / f"{name}.json"
    try:
        data = fn(ctx)
        res = {"ok": True, "stale": False, "as_of": iso(ctx.now), "data": data, "error": None}
        safeio.atomic_write(cache, json.dumps(res, default=str), ctx.out)
    except Exception as e:  # noqa: BLE001 - a source must never take the run down
        err = _short_error(e)
        prev = None
        if cache.exists():
            try:
                prev = json.loads(cache.read_text())
            except (OSError, json.JSONDecodeError):
                prev = None
        if prev and prev.get("ok") and "data" in prev:
            res = {"ok": True, "stale": True, "as_of": prev.get("as_of"), "data": prev["data"], "error": err}
        else:
            res = {"ok": False, "stale": False, "as_of": None, "data": None, "error": err}
    res["ms"] = int((time.monotonic() - t0) * 1000)
    return res


# ---------------------------------------------------------------- time helpers


def next_dst_changes(now: dt.datetime, zones: dict[str, ZoneInfo], horizon_days: int = 400) -> list[dict]:
    """The next UTC-offset change for each zone, found by stepping hours (exact to the hour)."""
    out = []
    for label, tz in zones.items():
        t = now.astimezone(UTC).replace(minute=0, second=0, microsecond=0)
        off = t.astimezone(tz).utcoffset()
        for _ in range(horizon_days * 24):
            t2 = t + dt.timedelta(hours=1)
            o2 = t2.astimezone(tz).utcoffset()
            if o2 != off:
                local = t2.astimezone(tz)
                out.append({"zone": label, "at_utc": iso(t2), "local_date": local.date().isoformat(),
                            "from_offset": _fmt_off(off), "to_offset": _fmt_off(o2),
                            "days_away": (t2 - now).days})
                break
            t = t2
    return sorted(out, key=lambda x: x["at_utc"])


def _fmt_off(o: dt.timedelta | None) -> str:
    if o is None:
        return "?"
    m = int(o.total_seconds() // 60)
    sign = "+" if m >= 0 else "-"
    return f"UTC{sign}{abs(m) // 60:02d}:{abs(m) % 60:02d}"


def _hm(s: str) -> dt.time:
    h, m = s.split(":")
    return dt.time(int(h), int(m))


def schedule_check(jobs: list[dict], now: dt.datetime, kind: str = "launchd", days: int = 10) -> list[dict]:
    """The next fire times of each job after ``now``, from the job table (wt.ops.schedule.JOBS) the agents and the
    units are rendered from, in time order, with whether each is early enough in ET.

    launchd (the Mac) fires on the host's Sydney clock, systemd (the VM) in America/New_York. Only future fires are
    listed and each job's own weekdays apply, so the first row of a job is its next run (a weekly job is not shown
    as today). ``local`` is always the owner's Sydney time, whichever clock fires the job. Weekend ET dates are marked ``no_session``; holidays are not known here (every job checks the
    market calendar itself). Uses zoneinfo, so both DST regimes are covered.
    """
    from wt.ops.schedule import JOBS
    rows = []
    for j in jobs:
        job = JOBS.get(j["label"].rsplit(".", 1)[-1])
        if job is None:
            continue
        need = _hm(j["must_start_before_et"])
        for t in (job.fires_et(now, days) if kind == "systemd" else job.fires(now, days)):
            et = t.astimezone(ET)
            session = et.weekday() < 5
            rows.append({"job": j["label"], "local": t.astimezone(SYD).strftime("%a %d %b %H:%M %Z"),
                         "et": et.strftime("%a %d %b %H:%M %Z"), "et_date": et.date().isoformat(),
                         "session": session, "ok": (et.time() <= need) if session else True,
                         "must_start_before_et": j["must_start_before_et"], "_at": et})
    rows.sort(key=lambda r: r["_at"])
    for r in rows:
        del r["_at"]
    return rows


def market_state(now: dt.datetime) -> dict:
    """Session phase from the ET clock alone (holidays are not known here)."""
    et = now.astimezone(ET)
    t = et.time()
    if et.weekday() >= 5:
        phase = "weekend"
    elif t < dt.time(4, 0):
        phase = "overnight"
    elif t < dt.time(9, 30):
        phase = "pre-market"
    elif t < dt.time(16, 0):
        phase = "regular session"
    elif t < dt.time(20, 0):
        phase = "after-hours"
    else:
        phase = "overnight"
    return {"phase": phase, "et": et.strftime("%a %d %b %H:%M %Z"),
            "sydney": now.astimezone(SYD).strftime("%a %d %b %H:%M %Z"), "trading_day_et": et.date().isoformat()}


# ---------------------------------------------------------------- research sources


_DATE_RE = re.compile(r"(20\d\d-\d\d-\d\d)")


def _dig(obj: Any, keys: list[str]) -> Any:
    for k in keys:
        if not isinstance(obj, dict) or k not in obj:
            raise SourceError(f"key {k!r} not found")
        obj = obj[k]
    return obj


def _num(x: Any, nd: int = 4) -> float | None:
    try:
        f = float(x)
    except (TypeError, ValueError):
        return None
    return round(f, nd) if f == f else None  # NaN -> None


def src_research(ctx: Ctx) -> dict:
    r = ctx.root / "research"
    if not r.is_dir():
        raise SourceError("research/ folder not found")
    decisions = []
    for p in sorted((r / "decisions").glob("DEC-*.md")):
        head = safeio.read_text(p, 2_000_000).splitlines()[:14]
        title = head[0].lstrip("# ").strip() if head else p.stem
        ident = p.stem[:8]
        title = title.split("—", 1)[1].strip() if "—" in title else title
        blob = "\n".join(head)
        m = re.search(r"\*\*Status:\s*([^*]+)\*\*", blob)
        dm = _DATE_RE.search(blob)
        decisions.append({"id": ident, "title": title[:140], "date": dm.group(1) if dm else None,
                          "status": m.group(1).strip().rstrip(".")[:80] if m else "recorded"})
    closed = set(ctx.cfg.get("closed_hypotheses", []))
    hyps = []
    for p in sorted((r / "hypotheses").glob("HYP-*.yaml")):
        try:
            d = yaml.safe_load(safeio.read_text(p, 1_000_000)) or {}
        except yaml.YAMLError:
            d = {}
        hid = str(d.get("id") or p.stem[:8])
        status = str(d.get("status") or "unknown")
        name = str(d.get("name") or d.get("title") or p.stem[9:].replace("_", " "))
        stale = ("draft" in status.lower()) or (hid in closed and "pre-registered" in status.lower())
        hyps.append({"id": hid, "name": name[:100], "status": status[:60], "stale": stale})

    files: dict[str, Any] = {}
    board = []
    for row in ctx.cfg.get("scoreboard", []):
        item = {k: row.get(k) for k in ("label", "span", "verdict", "ref", "note")}
        try:
            f = row["file"]
            if f not in files:
                files[f] = safeio.read_json(ctx.root / f)
            s = _dig(files[f], list(row["keys"]))
            ci = s.get("ci95_expectancy") or []
            item.update({"n": int(s.get("n") or 0), "expectancy_r": _num(s.get("expectancy_R")),
                         "ci_low": _num(ci[0]) if len(ci) == 2 else None,
                         "ci_high": _num(ci[1]) if len(ci) == 2 else None,
                         "profit_factor": _num(s.get("profit_factor"), 3), "dsr": _num(s.get("dsr_prob"), 3),
                         "win_rate": _num(s.get("win_rate"), 3), "years_profitable": s.get("years_profitable"),
                         "error": None})
        except (SourceError, KeyError, TypeError, IndexError, AttributeError) as e:
            item.update({"n": None, "expectancy_r": None, "ci_low": None, "ci_high": None, "error": _short_error(e)})
        board.append(item)

    r3_dirs = sorted(p.name for p in (r / "experiments").glob("EXP-0015-r3*"))
    hyp_by_id = {h["id"]: h for h in hyps}
    round3 = [{**t, "hyp_status": hyp_by_id.get(t["id"], {}).get("status", "missing"),
               "run": bool(r3_dirs)} for t in ctx.cfg.get("round3_trials", [])]
    active = sorted(p.stem for p in (r / "active_strategies").glob("*.yaml"))
    retired = sorted(p.stem for p in (r / "retired_strategies").glob("*.yaml")) if (r / "retired_strategies").is_dir() else []
    lessons = sorted(p.stem[:7] for p in (r / "lessons_learned").glob("LL-*"))
    dec10 = next((d for d in decisions if d["id"] == "DEC-0010"), None)
    return {"decisions": decisions, "hypotheses": hyps, "scoreboard": board, "round3": round3,
            "round3_experiments": r3_dirs, "active_strategies": active, "retired_strategies": retired,
            "lessons": lessons, "trials": ctx.cfg.get("trials", {}),
            "dec0010_status": dec10["status"] if dec10 else None}


def src_spec(ctx: Ctx) -> dict:
    d = ctx.root / "research/specs/SPEC-0001-warrior-methodology"
    spec = yaml.safe_load(safeio.read_text(d / "spec.yaml", 5_000_000)) or {}
    rows = list(csv.DictReader(io.StringIO(safeio.read_text(d / "traceability.csv", 5_000_000))))
    if not rows or "req_id" not in rows[0]:
        raise SourceError("traceability.csv has no req_id column")
    by_status = Counter(r["status"] for r in rows)
    by_level = Counter(r["level"] for r in rows)
    areas: dict[str, Counter] = defaultdict(Counter)
    for r in rows:
        areas[r["area"]][r["status"]] += 1
    by_area = [{"area": a, "total": sum(c.values()), **{k: c.get(k, 0) for k in ("implemented", "planned", "n_a", "needs_data")}}
               for a, c in areas.items()]
    open_reqs = [{"req_id": r["req_id"], "level": r["level"], "area": r["area"], "status": r["status"],
                  "statement": r["statement"][:160]} for r in rows if r["status"] != "implemented"]
    status_of = {r["req_id"]: r["status"] for r in rows}
    checklist = []
    for c in ctx.cfg.get("review_checklist", []):
        reqs = c.get("reqs", [])
        known = [q for q in reqs if q in status_of]
        impl = [q for q in known if status_of[q] == "implemented"]
        open_ = [f"{q} ({status_of[q]})" for q in known if status_of[q] != "implemented"]
        missing = [q for q in reqs if q not in status_of]
        state = "done" if known and len(impl) == len(known) and not missing else ("partial" if impl else "open")
        checklist.append({"item": c["item"], "total": len(reqs), "implemented": len(impl), "open": open_,
                          "missing": missing, "reqs": reqs, "state": state})
    return {"spec_id": spec.get("spec_id"), "title": spec.get("title"), "version": str(spec.get("version")),
            "status": spec.get("status"), "direction": spec.get("direction"), "total": len(rows),
            "by_status": dict(by_status), "by_level": dict(by_level), "by_area": by_area,
            "open": open_reqs, "checklist": checklist}


def src_cat01(ctx: Ctx) -> dict:
    d = ctx.root / "research/experiments/EXP-0015a-catalyst-accuracy"
    readme = safeio.read_text(d / "README.md", 2_000_000)
    report = safeio.read_text(d / "sample2_report_v3.md", 2_000_000)
    acc = re.search(r"Decision-level accuracy[^\n]*?\*\*(\d+(?:\.\d+)?)%\*\*", report)
    tgt = re.search(r"Target\s*(?:≥|>=)\s*(\d+)%", report)
    pend = re.search(r"verdicts (?:pending|in) \((\d+)/(\d+)\)", readme)
    url = re.search(r"https://claude\.ai/artifact/[A-Za-z0-9_-]+", readme)
    flips = []
    for line in readme.splitlines():
        if "change the decision" in line or "change the result" in line:
            flips = re.findall(r"S2H\d{3}", line)
            break
    total = int(pend.group(2)) if pend else None
    recorded_repo = set()
    for name in ("owner_review.csv", "sample2_owner_review.csv"):
        p = d / name
        if p.exists():
            for row in csv.DictReader(io.StringIO(safeio.read_text(p, 2_000_000))):
                if (row.get("owner_verdict") or "").strip():
                    recorded_repo.add(row.get("item_id"))
    # Verdicts recorded on the review page, mirrored into inputs/ by the refresh loop (optional).
    page_dir = ctx.out / "inputs/review_labels/labels"
    recorded_page, page_seen = set(), False
    if page_dir.is_dir():
        page_seen = True
        for p in page_dir.glob("*.json"):
            try:
                doc = json.loads(p.read_text(encoding="utf-8", errors="replace"))
            except (OSError, json.JSONDecodeError):
                continue
            body = doc.get("data", doc) if isinstance(doc, dict) else {}
            if isinstance(body, dict) and body.get("part") not in (None, "blind"):
                recorded_page.add(str(body.get("item_id") or p.stem))
    done = max(len(recorded_repo), len(recorded_page), int(pend.group(1)) if pend else 0)
    accuracy = float(acc.group(1)) if acc else None
    target = float(tgt.group(1)) if tgt else 85.0
    return {"accuracy_pct": accuracy, "target_pct": target, "passed": accuracy is not None and accuracy >= target,
            "verdicts_done": done, "verdicts_total": total, "verdicts_in_repo": len(recorded_repo),
            "verdicts_on_page": len(recorded_page) if page_seen else None,
            "review_url": url.group(0) if url else None, "decisive_items": flips,
            "classifier": "v3", "sample": "sample 2 (50 dev-span headlines)"}


# ---------------------------------------------------------------- live operations (read only)


def _git(ctx: Ctx, repo: Path, *args: str) -> str:
    return ctx.run(["git", "--no-optional-locks", "-C", str(repo), *args], 15).strip()


def src_deployed(ctx: Ctx) -> dict:
    repo = ctx.deployed
    if not (repo / ".git").exists():
        raise SourceError("deployed checkout not found")
    head = _git(ctx, repo, "rev-parse", "HEAD")
    branch = _git(ctx, repo, "rev-parse", "--abbrev-ref", "HEAD")
    subject = _git(ctx, repo, "log", "-1", "--format=%s")
    committed = _git(ctx, repo, "log", "-1", "--format=%cI")
    porcelain = _git(ctx, repo, "status", "--porcelain", "--untracked-files=normal")
    lines = [x for x in porcelain.splitlines() if x.strip()]
    out = {"head": head[:7], "branch": branch, "subject": subject[:120], "committed": committed,
           "modified": sum(1 for x in lines if not x.startswith("??")),
           "untracked": sum(1 for x in lines if x.startswith("??")),
           "main": None, "behind": None, "missing": [], "compare_error": None}
    try:
        repo_name = ctx.cfg["repos"]["research"]
        cmp = ctx.gh_json(["api", f"repos/{repo_name}/compare/{head}...main"])
        commits = cmp.get("commits") or []
        out["behind"] = int(cmp.get("ahead_by") or 0)
        out["ahead"] = int(cmp.get("behind_by") or 0)
        out["missing"] = [{"sha": c["sha"][:7], "subject": c["commit"]["message"].splitlines()[0][:120]}
                          for c in commits][-20:]
        out["main"] = commits[-1]["sha"][:7] if commits else head[:7]
    except (SourceError, KeyError, TypeError, AttributeError) as e:
        out["compare_error"] = _short_error(e)
    return out


def _latest_date_dir(base: Path) -> Path | None:
    if not base.is_dir():
        return None
    dirs = sorted(p for p in base.iterdir() if p.is_dir() and re.fullmatch(r"20\d\d-\d\d-\d\d", p.name))
    return dirs[-1] if dirs else None


_ERR_RE = re.compile(r"(Traceback|Error|ERROR|Exception|CRITICAL|FATAL)")


def _log_digest(path: Path, keep: int = 12) -> dict:
    if not path.exists():
        return {"file": path.name, "exists": False, "last": [], "errors": []}
    text = safeio.tail(path)
    lines = [x.rstrip() for x in text.splitlines() if x.strip()]
    errors = [x[:240] for x in lines if _ERR_RE.search(x)]
    st = path.stat()
    return {"file": path.name, "exists": True, "bytes": st.st_size,
            "modified": iso(dt.datetime.fromtimestamp(st.st_mtime, UTC)),
            "last": [x[:240] for x in lines[-keep:]], "errors": errors[-keep:]}


def _state(ctx: Ctx, rel: str, legacy: str) -> Path:
    """A runtime path in the deployed checkout's var/ (ADR 0002), or its pre-migration location if var/ has none yet."""
    new = ctx.deployed / "var" / rel
    old = ctx.deployed / legacy
    return old if not new.exists() and old.exists() else new


NEAR_MAX = 20


def near_misses(reached: object) -> dict | None:
    """Names that failed exactly one hard filter in a stage's funnel record: ticker, price and the reason's code
    without its suffix (a catalyst category comes from a headline and is never published). At most NEAR_MAX rows,
    by reason then ticker; `total` says how many there were."""
    if not isinstance(reached, list):
        return None
    rows = []
    for r in reached:
        why = r.get("reasons") if isinstance(r, dict) else None
        if isinstance(r, dict) and r.get("reached") == "kept" and isinstance(why, list) and len(why) == 1 \
                and isinstance(r.get("symbol"), str):
            rows.append({"symbol": r["symbol"], "price": _num(r.get("price"), 2), "reason": str(why[0]).split(":")[0]})
    rows.sort(key=lambda x: (x["reason"], x["symbol"]))
    return {"total": len(rows), "rows": rows[:NEAR_MAX]}


def forward_funnel(doc: object) -> dict | None:
    """The newest funnel of record (Set F on the after-close pool), in counts: the scan's and each funnel step's."""
    part = ((doc.get("parts") or {}).get("set_F") if isinstance(doc, dict) else None) or {}
    if not isinstance(part, dict) or not isinstance(part.get("funnel"), dict):
        return None
    ints = lambda d: {k: v for k, v in (d or {}).items() if type(v) is int}      # noqa: E731
    return {"session": doc.get("session"), "pool": ints(part.get("pool")), "counts": ints(part["funnel"])}


def src_routine(ctx: Ctx) -> dict:
    base = _state(ctx, "routine", "research/forward/routine")
    day = _latest_date_dir(base)
    stages, near = [], None
    if day:
        for p in sorted(day.glob("*.json")):
            try:
                d = safeio.read_json(p, 10_000_000)
            except SourceError as e:
                stages.append({"file": p.name, "error": str(e)})
                continue
            if not isinstance(d, dict):
                continue
            stats = {k: v for k, v in (d.get("stats") or {}).items() if isinstance(v, int | float)}
            prim = d.get("primary")
            if "reached" in d:                       # the newest stage that holds a funnel record wins
                near = near_misses(d.get("reached"))
            stages.append({"file": p.name, "stage": d.get("stage"), "as_of_et": d.get("as_of_et"),
                           "feed": d.get("feed"), "stats": stats,
                           "counts": {k: len(v) for k, v in d.items() if isinstance(v, list)},
                           "tier1": [{"symbol": x.get("symbol"), "score": _num(x.get("score"), 3)}
                                     for x in (d.get("tier1") or [])[:20] if isinstance(x, dict)],
                           "tier2": [x.get("symbol") if isinstance(x, dict) else str(x) for x in (d.get("tier2") or [])][:10],
                           "primary": (prim.get("symbol") if isinstance(prim, dict) else prim),
                           "scan_failed": bool(d.get("scan_failed")) if "stats" in d else None,
                           "error": None})
    logs = sorted((ctx.deployed / "logs").glob("routine_*.log"))
    return {"date": day.name if day else None, "stages": stages, "near": near,
            "log": _log_digest(logs[-1]) if logs else None,
            "launchd_err": _log_digest(ctx.deployed / "logs/launchd_routine.err", 6)}


def src_paper(ctx: Ctx) -> dict:
    rows, bad = safeio.read_jsonl(ctx.deployed / "data/live/journal.jsonl")
    events = Counter(str(x.get("event")) for x in rows)
    closed = g2.trades(rows)                     # once per trade id; orphans excluded
    armed = sorted({str(x.get("day")) for x in rows if x.get("event") == "armed"})
    equity = None
    for x in reversed(rows):
        v = x.get("virtual")
        if isinstance(v, dict) and v.get("equity") is not None:
            equity = {"equity": _num(v.get("equity"), 2), "start": _num(v.get("start_equity"), 2),
                      "latched": bool(v.get("latched")), "latch_reason": v.get("latch_reason") or ""}
            break
    rs = [float(x["R"]) for x in closed if isinstance(x.get("R"), int | float)]
    recent = [{"ts": x.get("ts"), "event": x.get("event"),
               "detail": ", ".join(str(b) for b in x.get("blockers", []))[:160] if x.get("blockers") else
               (str(x.get("error"))[:160] if x.get("error") else (x.get("day") or "")),
               # the publisher reduces these to codes (wt.ops.publish._paper); the local page keeps the detail
               "raw": {k: x.get(k) for k in ("event", "blockers", "error", "reason", "day") if x.get(k) is not None}}
              for x in rows[-12:]]
    logs = sorted((ctx.deployed / "logs").glob("paper_b_*.log"))
    return {"events": dict(events), "bad_lines": bad, "armed_sessions": len(armed), "last_armed": armed[-1] if armed else None,
            "trades": len(closed), "total_r": round(sum(rs), 3) if rs else 0.0,
            "mean_r": round(sum(rs) / len(rs), 3) if rs else None, "virtual": equity, "recent": recent,
            "g2": g2.summary(rows),
            "log": _log_digest(logs[-1]) if logs else None}


def src_forward(ctx: Ctx) -> dict:
    ledger = _state(ctx, "forward/forward_trades.jsonl", "research/forward/forward_trades.jsonl")
    rows, bad = safeio.read_jsonl(ledger)
    sessions = sorted({str(x.get("session")) for x in rows if x.get("session_marker")})
    errors = [x for x in rows if "error" in x]
    by = defaultdict(list)
    for x in rows:
        if not x.get("session_marker") and isinstance(x.get("R"), int | float):
            by[str(x.get("strategy"))].append(float(x["R"]))
    strategies = [{"strategy": k, "n": len(v), "mean_r": round(sum(v) / len(v), 3), "total_r": round(sum(v), 3)}
                  for k, v in sorted(by.items())]
    cards = sorted([*(ctx.deployed / "var/scorecards").glob("scorecard_*.md"),
                    *(ctx.deployed / "research/forward").glob("scorecard_*.md")], key=lambda p: p.name)
    fl = sorted((ctx.deployed / "logs").glob("forward_*.log"))
    funnels = []
    for f in sorted((ledger.parent / "funnel").glob("*.json")):
        try:
            doc = safeio.read_json(f)
        except Exception:  # noqa: BLE001 — one unreadable record costs the books its counts for that day, nothing else
            continue
        if isinstance(doc, dict):
            funnels.append(doc)
    return {"exists": ledger.exists(), "sessions": len(sessions),
            "first": sessions[0] if sessions else None, "last": sessions[-1] if sessions else None,
            "errors": len(errors), "bad_lines": bad, "strategies": strategies,
            "books": forward_book.view([x for x in rows if isinstance(x, dict)], funnels),
            "funnel": next((f for f in (forward_funnel(d) for d in reversed(funnels)) if f), None),
            "latest_scorecard": cards[-1].name if cards else None,
            "log": _log_digest(fl[-1]) if fl else None}


_LAUNCH_RE = re.compile(r"^\s*(-|\d+)\s+(-?\d+)\s+(\S+)\s*$")


def parse_launchctl_list(text: str, labels: list[str]) -> dict[str, dict]:
    out = {}
    for line in text.splitlines():
        m = _LAUNCH_RE.match(line)
        if m and m.group(3) in labels:
            pid = None if m.group(1) == "-" else int(m.group(1))
            out[m.group(3)] = {"loaded": True, "pid": pid, "running": pid is not None, "last_exit": int(m.group(2))}
    for lab in labels:
        out.setdefault(lab, {"loaded": False, "pid": None, "running": False, "last_exit": None})
    return out


_WAKE_RE = re.compile(r"^\s*(wakepoweron|wake|poweron)\s+at\s+(\d{1,2}):(\d\d)\s*([AP]M)\s+(.+?)\s*$", re.I)


def parse_pmset_repeat(text: str) -> list[dict]:
    """Repeating wake events from ``pmset -g sched``."""
    wakes, in_repeat = [], False
    for line in text.splitlines():
        if line.lower().startswith("repeating power events"):
            in_repeat = True
            continue
        if line and not line.startswith(" ") and in_repeat:
            in_repeat = False
        if not in_repeat:
            continue
        m = _WAKE_RE.match(line)
        if m:
            h = int(m.group(2)) % 12 + (12 if m.group(4).upper() == "PM" else 0)
            wakes.append({"kind": m.group(1).lower(), "time": f"{h:02d}:{m.group(3)}", "days": m.group(5)})
    return wakes


def wake_coverage(wakes: list[dict], needed: list[str], slack_min: int = 15) -> list[dict]:
    out = []
    for n in needed:
        nt = _hm(n)
        n_min = nt.hour * 60 + nt.minute
        hit = None
        for w in wakes:
            wt = _hm(w["time"])
            w_min = wt.hour * 60 + wt.minute
            if 0 <= n_min - w_min <= slack_min:
                hit = w
        out.append({"needed": n, "covered": hit is not None, "by": hit})
    return out


_SWAP_RE = re.compile(r"total\s*=\s*([\d.]+)M\s+used\s*=\s*([\d.]+)M\s+free\s*=\s*([\d.]+)M")


def parse_swapusage(text: str) -> dict | None:
    m = _SWAP_RE.search(text)
    if not m:
        return None
    total, used, free = (float(x) / 1024 for x in m.groups())
    return {"total_gb": round(total, 2), "used_gb": round(used, 2), "free_gb": round(free, 2),
            "used_pct": round(100 * used / total, 1) if total else 0.0}


def _systemd_jobs(ctx: Ctx, jobs_cfg: list[dict]) -> dict[str, dict]:
    """launchctl-shaped job rows from systemd: loaded, running, last exit of wt-<job>.service."""
    out: dict[str, dict] = {}
    for j in jobs_cfg:
        name = j["label"].rsplit(".", 1)[-1]           # the job key (com.wt.paper-b -> wt-paper-b); `name` is for people
        text = ctx.run(["systemctl", "show", f"wt-{name}.service", "--property=LoadState,ActiveState,ExecMainStatus"],
                       10)
        kv = dict(line.split("=", 1) for line in text.splitlines() if "=" in line)
        status = kv.get("ExecMainStatus", "")
        out[j["label"]] = {"loaded": kv.get("LoadState") == "loaded", "pid": None,
                           "running": kv.get("ActiveState") in ("active", "activating"),
                           "last_exit": int(status) if status.lstrip("-").isdigit() else None}
    return out


def src_host(ctx: Ctx) -> dict:
    from wt.ops.host import current
    h = current()
    jobs_cfg = ctx.cfg.get("host", {}).get("jobs", [])
    labels = [j["label"] for j in jobs_cfg]
    wakes: list = []
    wake_error = None
    try:
        jobs = (_systemd_jobs(ctx, jobs_cfg) if h.kind == "systemd"
                else parse_launchctl_list(ctx.run(["launchctl", "list"], 10), labels))
        jobs_error = None
    except SourceError as e:
        jobs, jobs_error = {}, str(e)
    if h.kind == "launchd":                # pmset wakes only exist on the Mac; the VM never sleeps
        try:
            wakes = parse_pmset_repeat(ctx.run(["pmset", "-g", "sched"], 10))
        except SourceError as e:
            wakes, wake_error = [], str(e)
    if h.kind == "launchd":
        try:
            swap = parse_swapusage(ctx.run(["sysctl", "vm.swapusage"], 10))
        except SourceError:
            swap = None
    else:
        swap = h.swap()
    free_gb, total_gb = thresholds.disk_free_gb(ctx.deployed), thresholds.disk_total_gb(ctx.deployed)
    return {"kind": h.kind, "jobs": [{**j, **jobs.get(j["label"], {})} for j in jobs_cfg], "jobs_error": jobs_error,
            "wakes": wakes, "wake_error": wake_error,
            "wake_coverage": (wake_coverage(wakes, ctx.cfg.get("host", {}).get("wake_needed", []))
                              if h.kind == "launchd" else []),
            "disk_free_gb": round(free_gb, 2), "disk_total_gb": round(total_gb, 1),
            "disk_floor_gb": thresholds.DISK_FLOOR_GB, "disk_target_gb": thresholds.DISK_TARGET_GB,
            "old_root_exists": ctx.old.exists(), "swap": swap, "swap_warn_pct": thresholds.SWAP_WARN_PCT,
            "schedule": schedule_check(jobs_cfg, ctx.now, h.kind, 10),
            "dst": next_dst_changes(ctx.now, {"Sydney": SYD, "New York": ET})}


def src_account(ctx: Ctx) -> dict:
    if not ctx.with_account:
        raise SourceError("account snapshot not requested (--with-account)")
    from wt.brokers.alpaca_read import AccountReader     # read-only: no order methods exist on it
    try:
        d = AccountReader().snapshot()
    except Exception as e:  # noqa: BLE001 — any broker error is a source failure with a short, safe message
        raise SourceError(f"paper account unavailable ({e.__class__.__name__})") from e
    keep = ("equity", "last_equity", "cash", "buying_power", "daytrade_count", "pattern_day_trader",
            "status", "trading_blocked", "market_is_open", "next_open", "next_close", "paper")
    flat = {}
    for k, v in (d.items() if isinstance(d, dict) else []):
        if isinstance(v, dict):
            for k2, v2 in v.items():
                if k2 in keep:
                    flat[k2] = v2
        elif k in keep:
            flat[k] = v
    pos = d.get("positions") if isinstance(d, dict) else None
    from wt.risk.mandate import legacy_positions
    from wt.risk.pretrade import load_limits
    allow, legacy = load_limits("B").allowlist, legacy_positions()

    def qty_of(p: dict) -> int:
        try:
            return int(float(p.get("qty") or 0))
        except (TypeError, ValueError):
            return 0
    flat["positions"] = [{"symbol": p.get("symbol"), "qty": p.get("qty"), "market_value": p.get("market_value"),
                          "unrealized_pl": p.get("unrealized_pl"), "in_mandate": p.get("symbol") in allow,
                          "legacy": legacy.get(str(p.get("symbol")).upper()) == qty_of(p)}
                         for p in (pos or []) if isinstance(p, dict)][:20]
    return flat


# ---------------------------------------------------------------- org / GitHub


def _milestone_key(title: str) -> str:
    m = re.match(r"\s*(M\d)", title or "")
    return m.group(1) if m else (title or "?")


def src_org(ctx: Ctx) -> dict:
    repo = ctx.cfg["repos"]["org"]
    ms = ctx.gh_json(["api", f"repos/{repo}/milestones?state=all&per_page=100"]) or []
    milestones = sorted(({"key": _milestone_key(m["title"]), "title": m["title"], "state": m["state"],
                          "open": m["open_issues"], "closed": m["closed_issues"]} for m in ms), key=lambda x: x["key"])
    proj = ctx.cfg.get("project", {})
    try:
        items = (ctx.gh_json(["project", "item-list", str(proj.get("number", 2)), "--owner", proj.get("owner", ""),
                              "--format", "json", "--limit", "500"], 40) or {}).get("items", [])
    except SourceError:
        # The board needs its own token permission (organization Projects). Without it the milestones, CI runs
        # and releases below are still worth showing; they were all lost with it.
        items = []
    tab: dict[str, Counter] = defaultdict(Counter)
    prio = Counter()
    open_items = []
    for it in items:
        content = it.get("content") or {}
        title = it.get("title") or content.get("title") or ""
        mkey = _milestone_key(title)
        ms_field = it.get("milestone")
        if isinstance(ms_field, dict) and ms_field.get("title"):
            mkey = _milestone_key(ms_field["title"])
        status = it.get("status") or "No status"
        tab[mkey][status] += 1
        pr = it.get("priority") or "-"
        prio[(pr, "done" if status == "Done" else "open")] += 1
        if status != "Done":
            open_items.append({"milestone": mkey, "number": content.get("number"), "title": title.split("·", 1)[-1].strip()[:110],
                               "priority": pr, "size": it.get("size"), "area": it.get("area"), "status": status})
    for m in milestones:
        m["p0_open"] = sum(1 for x in open_items if x["milestone"] == m["key"] and x["priority"] == "P0")
        m["by_status"] = dict(tab.get(m["key"], {}))
    ci_repo = ctx.cfg["repos"].get("research", repo)        # the repo whose code runs: its CI, releases, rules
    rel = ctx.gh_json(["release", "list", "-R", ci_repo, "--json", "tagName,name,publishedAt,isLatest", "--limit", "5"]) or []
    runs = ctx.gh_json(["run", "list", "-R", ci_repo, "--limit", "12", "--json", "workflowName,conclusion,status,createdAt,headBranch"]) or []
    try:
        rules = ctx.gh_json(["api", f"repos/{ci_repo}/rules/branches/main"]) or []
        rule_types = sorted({r.get("type") for r in rules if isinstance(r, dict)})
    except SourceError:
        rule_types = []
    open_items.sort(key=lambda x: (x["milestone"], x["priority"], x["number"] or 0))
    return {"repo": repo, "ci_repo": ci_repo, "milestones": milestones, "items_total": len(items),
            "items_done": sum(1 for it in items if it.get("status") == "Done"),
            "priority": [{"priority": p, "state": s, "count": c} for (p, s), c in sorted(prio.items())],
            "open_items": open_items, "releases": rel,
            "runs": [{"workflow": r.get("workflowName"), "conclusion": r.get("conclusion") or r.get("status"),
                      "created": r.get("createdAt"), "branch": r.get("headBranch")} for r in runs],
            "required_checks": "required_status_checks" in rule_types, "rule_types": rule_types}


def src_repos(ctx: Ctx) -> dict:
    repos = []
    for key in ("org", "source", "research"):
        name = ctx.cfg["repos"][key]
        try:
            v = ctx.gh_json(["repo", "view", name, "--json", "name,visibility,pushedAt,defaultBranchRef,url"])
            prs = ctx.gh_json(["pr", "list", "-R", name, "--state", "open", "--json", "number,title", "--limit", "20"]) or []
            repos.append({"key": key, "repo": name, "visibility": (v.get("visibility") or "").lower(),
                          "pushed_at": v.get("pushedAt"), "url": v.get("url"),
                          "default_branch": (v.get("defaultBranchRef") or {}).get("name"),
                          "open_prs": [{"number": p["number"], "title": p["title"][:100]} for p in prs], "error": None})
        except (SourceError, AttributeError, KeyError, TypeError) as e:
            repos.append({"key": key, "repo": name, "error": _short_error(e)})
    reg = ctx.cfg["repos"].get("registration_pr") or {}
    registration = None
    if reg:
        try:
            pr = ctx.gh_json(["pr", "view", str(reg["number"]), "-R", reg["repo"], "--json", "state,title,mergedAt,url"])
            registration = {"repo": reg["repo"], "number": reg["number"], "state": pr.get("state"),
                            "title": pr.get("title"), "merged_at": pr.get("mergedAt"), "url": pr.get("url")}
        except (SourceError, AttributeError) as e:
            registration = {"repo": reg["repo"], "number": reg["number"], "state": None, "error": _short_error(e)}
    if all(r.get("error") for r in repos):
        raise SourceError(repos[0]["error"])
    return {"repos": repos, "registration_pr": registration}


_OUTCOME_RE = re.compile(r"\*\*outcome\*\*:\s*([^\n]+)", re.I)
_ORDER_RE = re.compile(r"\*\*order_id\*\*:\s*([^\s\n]+)", re.I)
_LEGACY_NAME = re.compile(r"(20\d\d-\d\d-\d\d)-(\d{6})-(.+)\.md$")


def classify_legacy(text: str) -> str:
    m = _OUTCOME_RE.search(text)
    raw = (m.group(1) if m else text[:4000]).lower()
    if "safety-abort" in raw or "safety abort" in raw:
        return "safety_abort"
    if "no-candidates" in raw or "no candidates" in raw:
        return "no_candidates"
    if "no-trade" in raw or "no trade" in raw or "skip" in raw:
        return "no_trade"
    if m and ("candidate" in raw or "watchlist" in raw):
        return "watchlist"
    return "other"


LEGACY_FROZEN = "config/legacy_history.json"


def src_legacy(ctx: Ctx) -> dict:
    """The old repo's run logs. They stopped in 2026-07 and live only on the Mac, so a host without the folder
    reads the frozen counts in config/legacy_history.json (made once from the same code; no free text)."""
    base = ctx.org / "decisions"
    if not base.is_dir():
        frozen = ctx.root / LEGACY_FROZEN
        if not frozen.is_file():
            raise SourceError("legacy decisions folder not found")
        return dict(safeio.read_json(frozen))
    runs = []
    for p in sorted(base.rglob("*.md")):
        m = _LEGACY_NAME.search(p.name)
        if not m:
            continue
        text = safeio.read_text(p, 2_000_000)
        om = _ORDER_RE.search(text)
        order = om.group(1).strip("`'\",") if om else None
        placed = bool(order) and order.lower() not in ("null", "none", "-", "n/a")
        outcome = classify_legacy(text)
        detail = _OUTCOME_RE.search(text)
        runs.append({"date": m.group(1), "tag": m.group(3), "outcome": outcome, "order_placed": placed,
                     "summary": (detail.group(1).strip() if detail else "")[:100]})
    by_month: dict[str, Counter] = defaultdict(Counter)
    for r in runs:
        by_month[r["date"][:7]][r["outcome"]] += 1
    return {"total": len(runs), "orders_placed": sum(r["order_placed"] for r in runs),
            "first": runs[0]["date"] if runs else None, "last": runs[-1]["date"] if runs else None,
            "by_month": [{"month": k, **dict(v)} for k, v in sorted(by_month.items())],
            "by_tag": dict(Counter(r["tag"] for r in runs)),
            "by_outcome": dict(Counter(r["outcome"] for r in runs)), "recent": runs[-8:][::-1]}


SOURCES: dict[str, Callable[[Ctx], Any]] = {
    "research": src_research, "spec": src_spec, "cat01": src_cat01,
    "deployed": src_deployed, "routine": src_routine, "paper": src_paper, "forward": src_forward,
    "host": src_host, "account": src_account,
    "org": src_org, "repos": src_repos, "legacy": src_legacy,
}
