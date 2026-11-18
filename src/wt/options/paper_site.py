"""The paper options history for the dashboard's Paper options page (DEC-0057): every closed paper option trade,
rebuilt from this host's own records on every run and sent whole.

Three sources, never added together:

- `clone`: the options clone's finished trades, from its journal's `trade_closed` rows (`data/live/
  options_journal.jsonl`), with each fill's own time, the quoted ask and the quote's age from the trade's plan file
  (`var/options/plans/`). A row counts when it is a closed trade with both fills and a result, as
  `wt.options.review.figures` counts it, so the page's totals and the clone's own document agree.
- `arms`: the research arms' closed virtual trades (DEC-0041), from `var/options/shadow/<date>.jsonl`, one list per
  hypothesis id. Simulated fills, never orders.
- `manual`: the hand-placed paper account's closed round trips, matched first in, first out from that account's
  activity list (`wt.options.paper_manual`). The list is read by the job that calls this module and handed in;
  without it the block is left out.

Read only. No broker call, no order path, no import of one. SAFE data only: ids, dates, times, contract symbols, trade
prices, results, counts and codes. A setup's name never leaves: a trade carries its hypothesis id, and a virtual
trade's id (which is built from its setup and level) is sent as a hash.

The document is validated against the dashboard's own schema before it is sent, and is sent only when the dashboard
says it takes it (/api/health), when something in it changed or half a day has passed, and never from a shadow host
without its own key. A fault here is this module's own: `run` never raises, so the job that calls it is unaffected.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import sys
from collections.abc import Iterable, Mapping, Sequence
from pathlib import Path
from typing import Any

import yaml

from wt.core.config import CONFIG_DIR, DATA_DIR, ROOT, STATE_DIR
from wt.ops import publish, safeio
from wt.options import arms_verdict, paper_manual, review

SCHEMA_ID = "stocksdelta/paper-options"
SCHEMA_VERSION = 1
SCHEMA_PATH = ROOT / "dashboard" / "src" / "lib" / "paper-options.schema.json"
JOURNAL = DATA_DIR / "live" / "options_journal.jsonl"
OPT = STATE_DIR / "options"
OUT = OPT / "paper_site"
HYP = {"retest": "HYP-0029", "rejection": "HYP-0030", review.NEAREST: "HYP-0031"}
MAX_TRADES = 2000                 # the schema's cap on the clone's list: the newest are kept
MAX_ARM_TRADES = 500
ACCEPTS_KEEP_S = 3600.0           # how long the dashboard's answer on what it takes is remembered
RESEND_S = 12 * 3600.0            # an unchanged document is sent again after this long, so the page can tell a
                                  # quiet week from a host that stopped
SEND_TRIES = 2
CLONE_KEYS = ("APCA_CLONE_KEY_ID", "APCA_CLONE_SECRET_KEY")
SHARED_KEYS = ("APCA_OPTIONS_KEY_ID", "APCA_OPTIONS_SECRET_KEY")

_CODE = re.compile(r"^[a-z0-9_-]{1,32}$")
_OCC = re.compile(r"^[A-Z]{1,6}\d{6}[CP]\d{8}$")
_TRADE_ID = re.compile(r"^\d{4}-\d{2}-\d{2}-O-\d{1,4}$")
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_HYP = re.compile(r"^HYP-\d{4}$")


# ---------------------------------------------------------------- small readers
def jsonl(path: Path) -> list[dict[str, Any]]:
    """Every line of `path` that is a JSON object; a torn or foreign line is skipped, a missing file is empty."""
    out: list[dict[str, Any]] = []
    try:
        with open(path) as fh:
            for line in fh:
                try:
                    rec = json.loads(line)
                except ValueError:
                    continue
                if isinstance(rec, dict):
                    out.append(rec)
    except OSError:
        pass
    return out


def read_plans(state: Path) -> dict[str, dict[str, Any]]:
    """The plan file of each trade, by trade id. A file that cannot be read is left out: its trade is timed from the
    journal instead."""
    out: dict[str, dict[str, Any]] = {}
    root = state / "plans"
    for f in sorted(root.glob("plan_*.json")) if root.exists() else []:
        try:
            raw = json.loads(f.read_text())
        except (OSError, ValueError):
            continue
        if isinstance(raw, dict) and isinstance(raw.get("trade_id"), str):
            out[raw["trade_id"]] = raw
    return out


def _num(v: Any, nd: int = 4) -> float | None:
    if isinstance(v, bool):
        return None
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return round(x, nd) if x == x and abs(x) != float("inf") else None


def _price(v: Any) -> float | None:
    x = _num(v)
    return x if x is not None and 0 <= x <= 100_000 else None


def _code(v: Any) -> str | None:
    """A code as it is, `other` for anything that is not one (free text never leaves), None for nothing."""
    s = str(v) if v not in (None, "") else None
    return s if s is None or _CODE.match(s) else "other"


def _stamp(v: Any) -> str | None:
    """An ISO time with its zone, or None. A plan file writes a datetime as `str()` does (a space, not a T), and a
    time with no zone is UTC, as every time this host writes is."""
    if isinstance(v, dt.datetime):
        t = v
    elif isinstance(v, str) and v.strip():
        try:
            t = dt.datetime.fromisoformat(v.strip())
        except ValueError:
            return None
    else:
        return None
    if t.tzinfo is None:
        t = t.replace(tzinfo=dt.UTC)
    return t.astimezone(dt.UTC).replace(microsecond=0).isoformat()


def window_of(session: str) -> str:
    """The rule window `session` falls in (wt.options.review.WINDOWS)."""
    for name, (since, until) in review.WINDOWS.items():
        if (since is None or session >= since) and (until is None or session <= until):
            return name
    return "other"


def windows() -> list[dict[str, Any]]:
    """The rule windows, oldest first: each a code and the first session it covers."""
    rows = [{"id": _code(name) or "other", "from": since} for name, (since, _until) in review.WINDOWS.items()]
    return sorted(rows, key=lambda w: w["from"] or "")


def own_account(env: Mapping[str, str]) -> bool | None:
    """True when the clone has a paper account of its own, False when it shares the manual one, None with no keys.
    The same rule as wt.brokers.alpaca_options_paper.keys, without importing an order path."""
    for pair, own in ((CLONE_KEYS, True), (SHARED_KEYS, False)):
        if env.get(pair[0], "").strip() and env.get(pair[1], "").strip():
            return own
    return None


# ---------------------------------------------------------------- the clone
def _order(trade_id: str) -> tuple[str, int]:
    return trade_id[:10], int(trade_id.rsplit("-", 1)[1])


def clone_block(rows: Sequence[Mapping[str, Any]], plans: Mapping[str, Mapping[str, Any]], fee: float,
                env: Mapping[str, str]) -> dict[str, Any]:
    """The clone's finished trades, oldest first. One row a trade id (the journal's last `trade_closed` wins)."""
    filled_at: dict[str, str] = {}
    sent: dict[str, Mapping[str, Any]] = {}
    closed: dict[str, Mapping[str, Any]] = {}
    for r in rows:
        tid = r.get("trade_id")
        if not isinstance(tid, str) or not _TRADE_ID.match(tid):
            continue
        ev = r.get("event")
        if ev == "filled" and (t := _stamp(r.get("ts"))):
            filled_at[tid] = t
        elif ev == "entry_sent":
            sent[tid] = r
        elif ev == "trade_closed":
            closed[tid] = r
    trades: list[dict[str, Any]] = []
    for tid in sorted(closed, key=_order):
        r, plan = closed[tid], plans.get(tid, {})
        contract = r.get("symbol")
        side = r.get("side")
        if not isinstance(contract, str) or not _OCC.match(contract) or side not in ("call", "put"):
            continue                                          # not a trade the page can name: left out
        session = review.session_of(r)
        fill, exit_fill = _price(r.get("fill")), _price(r.get("exit_fill"))
        pnl, rop = _num(r.get("pnl"), 2), _num(r.get("rop"))
        opened = _stamp(plan.get("filled_at")) if fill is not None else None
        ended = _stamp(plan.get("exit_at")) if exit_fill is not None else None
        timed_by = "plan"
        if fill is not None and opened is None:
            opened, timed_by = filled_at.get(tid), "journal"
        if exit_fill is not None and ended is None:
            ended, timed_by = _stamp(r.get("ts")), "journal"
        if opened and ended and ended < opened:               # a clock fault: never a negative hold
            ended, timed_by = opened, "journal"
        state = _code(r.get("state")) or "other"
        # As wt.options.review.figures counts: a closed trade with a result. And with both times, which the page's
        # days and holds are built from.
        counts = bool(r.get("counts")) and state == "closed" and None not in (fill, exit_fill, pnl, rop, opened, ended)
        entry = sent.get(tid, {})
        trades.append({
            "trade_id": tid, "session": session,
            "hyp": HYP.get(review.trial_of(str(r.get("setup")), contract, session), "other"),
            "window": window_of(session), "side": side, "contract": contract, "qty": 1,
            "opened_at": opened, "closed_at": ended, "timed_by": timed_by,
            "fill": fill, "exit_fill": exit_fill, "exit_reason": _code(r.get("exit_reason")),
            "pnl_usd": pnl, "rop": rop,
            "quoted_ask": _price(plan.get("quoted_ask", entry.get("quoted_ask"))),
            "quote_age_s": _age(plan.get("quote_age_s", entry.get("quote_age_s"))),
            "best_bid": _price(r.get("best_bid")), "worst_bid": _price(r.get("worst_bid")),
            "state": state, "counts": counts,
        })
    left_out = max(0, len(trades) - MAX_TRADES)
    return {"fee_per_contract": round(float(fee), 4), "own_account": own_account(env), "windows": windows(),
            "truncated": left_out, "trades": trades[left_out:]}


def _age(v: Any) -> float | None:
    x = _num(v, 1)
    return x if x is not None and 0 <= x <= 86_400 else None


# ---------------------------------------------------------------- the research arms
def arm_hyp(arm: Any, setup: Any) -> str | None:
    """The hypothesis a virtual trade counts toward (wt.options.arms_verdict.TRIALS): the runner by the control's
    setup, an own-setup arm by its own."""
    for t in arms_verdict.TRIALS:
        if (t.kind == "runner" and arm == "runner" and t.base == setup) or (t.kind == "own" and arm == t.base):
            return t.hyp if _HYP.match(t.hyp) else None
    return None


def arms_block(state: Path, fee: float) -> list[dict[str, Any]] | None:
    """Each arm's closed virtual trades, oldest first, by hypothesis id; None when no shadow file exists."""
    root = state / "shadow"
    files = sorted(root.glob("*.jsonl")) if root.exists() else []
    if not files:
        return None
    last: dict[str, Mapping[str, Any]] = {}
    for f in files:
        if not _DATE.match(f.stem):
            continue
        for r in jsonl(f):
            if isinstance(r.get("vid"), str) and r.get("event") == "closed":
                last[f"{f.stem}|{r['vid']}"] = {**r, "_session": f.stem}
    by_hyp: dict[str, list[dict[str, Any]]] = {}
    for key in sorted(last):
        r = last[key]
        hyp = arm_hyp(r.get("arm"), r.get("setup"))
        contract, side = r.get("symbol"), r.get("side")
        fill, exit_fill = _price(r.get("fill")), _price(r.get("exit_fill"))
        opened, ended = _stamp(r.get("filled_at")), _stamp(r.get("exit_at")) or _stamp(r.get("ts"))
        if hyp is None or not isinstance(contract, str) or not _OCC.match(contract) or side not in ("call", "put") \
                or fill is None or exit_fill is None or not fill or opened is None or ended is None:
            continue
        pnl = round((exit_fill - fill) * 100 - 2 * fee, 2)
        by_hyp.setdefault(hyp, []).append({
            # A virtual trade's own id names its setup and level: only a hash of it leaves.
            "vid": f"{r['_session']}-V{hyp[-2:]}-{hashlib.sha256(key.encode()).hexdigest()[:10]}",
            "session": str(r["_session"]), "side": side, "contract": contract,
            "opened_at": opened, "closed_at": max(opened, ended),
            "fill": fill, "exit_fill": exit_fill, "exit_reason": _code(r.get("exit_reason")),
            "pnl_usd": pnl, "rop": round(pnl / (fill * 100 + fee), 4),
        })
    out = []
    for hyp in sorted(by_hyp):
        rows = sorted(by_hyp[hyp], key=lambda t: (t["closed_at"], t["vid"]))
        left_out = max(0, len(rows) - MAX_ARM_TRADES)
        out.append({"hyp": hyp, "truncated": left_out, "trades": rows[left_out:]})
    return out


# ---------------------------------------------------------------- the document
def build(now: dt.datetime, run_id: str, journal: Path = JOURNAL, state: Path = OPT,
          cfg: Mapping[str, Any] | None = None, env: Mapping[str, str] | None = None,
          manual: Sequence[Mapping[str, Any]] | None = None) -> dict[str, Any]:
    """`manual`: the manual paper account's activities (wt.options.paper_manual.clean), or None to leave them out."""
    cfg = cfg if cfg is not None else yaml.safe_load((CONFIG_DIR / "options_clone.yaml").read_text())
    fee = float(cfg["costs"]["fee_per_contract_each_way"])
    e = os.environ if env is None else env
    plans, rows = read_plans(state), jsonl(journal)
    doc: dict[str, Any] = {
        "schema": SCHEMA_ID, "schema_version": SCHEMA_VERSION, "run_id": run_id,
        "as_of": now.astimezone(dt.UTC).replace(microsecond=0).isoformat(), "paper": True,
        "clone": clone_block(rows, plans, fee, e),
    }
    if manual is not None:
        # The clone's fills are left out whatever its keys say today: it shared this account before it had its own.
        doc["manual"] = paper_manual.block(manual, plans, rows)
    arms = arms_block(state, fee)
    if arms is not None:
        doc["arms"] = arms
    return doc


def body(doc: Mapping[str, Any]) -> bytes:
    return json.dumps(doc, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")


def validate(doc: Mapping[str, Any], schema_path: Path = SCHEMA_PATH) -> list[str]:
    """The site's own contract, read from the checkout: what fails here would be refused there."""
    import jsonschema
    v = jsonschema.Draft7Validator(json.loads(schema_path.read_text()))
    return [f"{'/'.join(map(str, e.absolute_path))}: {e.validator}" for e in v.iter_errors(doc)][:20]


def digest(doc: Mapping[str, Any]) -> str:
    """What the document says, apart from when it was built: unchanged trades give an unchanged digest."""
    rest = {k: v for k, v in doc.items() if k not in ("run_id", "as_of")}
    return hashlib.sha256(json.dumps(rest, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def due(doc: Mapping[str, Any], now: dt.datetime, state_path: Path) -> bool:
    """True when the document differs from the last one sent, or that one is older than RESEND_S."""
    try:
        kept = json.loads(state_path.read_text())
        at = dt.datetime.fromisoformat(str(kept["at"]))
        return kept["digest"] != digest(doc) or not 0 <= (now - at).total_seconds() < RESEND_S
    except (OSError, ValueError, KeyError, TypeError):
        return True


def site_accepts(url: str, bypass: str | None, now: dt.datetime, cache: Path) -> int:
    """The newest paper-options version the dashboard validates (/api/health), remembered for an hour; 0 when it
    cannot be read or the dashboard does not know the document yet, so nothing it would refuse is sent."""
    try:
        kept = json.loads(cache.read_text())
        if isinstance(kept, dict) and 0 <= (now - dt.datetime.fromisoformat(str(kept["at"]))).total_seconds() < ACCEPTS_KEEP_S:
            return int(kept["accepts"])
    except (OSError, ValueError, KeyError, TypeError):
        pass
    health, _ = publish.read_health(url, bypass)
    editions = health.get("editions") if isinstance(health, dict) else None
    mine = editions.get("paper_options") if isinstance(editions, dict) else None
    accepts = mine.get("accepts") if isinstance(mine, dict) else None
    if not isinstance(accepts, int) or isinstance(accepts, bool):
        return 0                                             # not remembered: asked again on the next run
    try:
        safeio.atomic_write(cache, json.dumps({"at": now.isoformat(), "accepts": accepts}), cache.parent)
    except OSError:
        pass
    return accepts


def _run(now: dt.datetime, dry_run: bool, env: Mapping[str, str], journal: Path, state: Path, out: Path,
         cfg: Mapping[str, Any] | None, manual: Sequence[Mapping[str, Any]] | None = None) -> tuple[int, str]:
    run_id = now.strftime("%Y%m%dT%H%M%SZ") + "-" + hashlib.sha1(os.urandom(8)).hexdigest()[:6]
    doc = build(now, run_id, journal, state, cfg, env, manual)
    if bad := validate(doc):
        return 2, "failed schema validation: " + "; ".join(bad)
    data = body(doc)
    out.mkdir(parents=True, exist_ok=True)
    safeio.atomic_write(out / "document.json", data.decode(), out)
    counted = sum(1 for t in doc["clone"]["trades"] if t["counts"])
    hand = f"{len(doc['manual']['trades'])} hand-placed" if "manual" in doc else "no hand-placed history"
    said = f"{len(doc['clone']['trades'])} clone trades ({counted} counted), {len(doc.get('arms') or [])} arms, {hand}, {len(data)} bytes"
    if dry_run:
        return 0, f"{said}; dry run, not sent"
    if publish.shadow_key_problem(dict(env)) is not None:
        return 0, f"{said}; a shadow host without its own key, not sent"
    url, secret = env.get("DASHBOARD_INGEST_URL"), env.get("DASHBOARD_INGEST_SECRET")
    if not url or not secret:
        return 0, f"{said}; DASHBOARD_INGEST_URL / DASHBOARD_INGEST_SECRET not set, not sent"
    if not due(doc, now, out / "sent.json"):
        return 0, f"{said}; unchanged, not sent"
    bypass = env.get("VERCEL_AUTOMATION_BYPASS_SECRET")
    if site_accepts(url, bypass, now, out / "site_accepts.json") < SCHEMA_VERSION:
        return 0, f"{said}; the dashboard does not take the document yet, not sent"
    ok, detail = publish.send(data, url, secret, bypass, tries=SEND_TRIES, key_id=env.get("DASHBOARD_KEY_ID"))
    if not ok:
        return 1, f"{said}; sent: False ({publish.error_code(detail)})"
    try:
        safeio.atomic_write(out / "sent.json", json.dumps({"at": now.isoformat(), "digest": digest(doc)}), out)
    except OSError:
        pass                                                 # the next run sends again: harmless
    return 0, f"{said}; sent: True ({detail})"


def run(now: dt.datetime | None = None, dry_run: bool = False, env: Mapping[str, str] | None = None,
        journal: Path = JOURNAL, state: Path = OPT, out: Path = OUT, cfg: Mapping[str, Any] | None = None,
        manual: Sequence[Mapping[str, Any]] | None = None) -> int:
    """Build, check and send. Never raises: 0 sent or rightly not sent, 1 not sent, 2 a fault in the document."""
    try:
        rc, said = _run(now or dt.datetime.now(dt.UTC), dry_run, os.environ if env is None else env, journal, state,
                        out, cfg, manual)
    except Exception as e:  # noqa: BLE001 — a fault in this history must never reach the job that calls it
        rc, said = 2, f"fault ({e.__class__.__name__})"
    print(f"paper options history: {said}", file=sys.stderr if rc else sys.stdout)
    return rc


def main(argv: Iterable[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m wt.options.paper_site")
    ap.add_argument("--dry-run", action="store_true", help="build and check the document, write it to the outbox, send nothing")
    a = ap.parse_args(None if argv is None else list(argv))
    return run(dry_run=a.dry_run)


if __name__ == "__main__":
    sys.exit(main())
