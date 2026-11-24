"""Gap Hunter's own document, every minute in session (DEC-0078): `stocksdelta/gap-hunter-live` v1.

The stocks snapshot (wt.ops.publish) carries the `gap_hunter` block every 5 minutes. This job sends the same block,
built by the same function and cleaned by the same allow-list, on its own, so the page can show what the robot is
doing within a minute. The site stores it as its own document (it has no partial merge of a snapshot) and the page
reads whichever of the two is newer.

When: the timer fires every minute from 08:30 to 16:15 New York on weekdays and every 15 minutes at any hour (the
cadence check holds the job to its slowest rhythm). The job sends on a minute only from 08:30 to the day's close
plus 15 minutes, by the market calendar (a 13:00 half day ends at 13:15). Outside that it sends on the 15-minute
rhythm only, so the page still knows the robot's state overnight. The day's session is read once a day and kept.

Read only: journal and plan files. No broker call, no order path. PRIVATE data behind the owner's login
(DEC-0078): symbols and prices, never a setup name, a headline or a free-text field. Never raises: 0 sent or rightly
not sent, 1 not sent, 2 a fault in the document.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import sys
import time
from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import Any

from wt.core.clock import ET
from wt.core.config import ROOT, STATE_DIR
from wt.ops import publish, safeio
from wt.ops.publish import ALLOW, B, I, S

SCHEMA_ID = "stocksdelta/gap-hunter-live"
SCHEMA_VERSION = 1
SCHEMA_PATH = ROOT / "dashboard" / "src" / "lib" / "gap-hunter-live.schema.json"
OUT = STATE_DIR / "gap_hunter_live"
OPEN_FROM = dt.time(8, 30)            # New York: the minute rhythm starts here on a session day ...
AFTER_CLOSE = dt.timedelta(minutes=15)   # ... and ends this long after the day's close
SLOW_EVERY_MIN = 15                   # outside the window: the minutes the 15-minute timer fires on (:05, :20, ...)
SLOW_AT = 5
ACCEPTS_KEEP_S = 3600.0
SEND_TRIES = 2                        # 2 s back-off at most: well inside the minute
SEND_BUDGET_S = 40.0
FAIL_AFTER = 3                        # sends failed in a row before the job fails (and pages): one blip a minute is not
REQUIRED = ("schema", "schema_version", "run_id", "as_of", "paper", "gap_hunter")
LIVE_ALLOW: dict[str, Any] = {"schema": S, "schema_version": I, "run_id": S, "as_of": S, "paper": B,
                              "gap_hunter": ALLOW["gap_hunter"]}


def to_schema() -> dict[str, Any]:
    """The document's JSON Schema, from the same allow-list as the snapshot's block: the two cannot drift."""
    body = publish.to_schema(LIVE_ALLOW, top=False)
    body["type"] = "object"
    body["properties"]["gap_hunter"]["type"] = "object"
    body["properties"]["paper"] = {"const": True}
    body["properties"]["schema"] = {"const": SCHEMA_ID}
    body["properties"]["schema_version"] = {"const": SCHEMA_VERSION}
    return {"$schema": "http://json-schema.org/draft-07/schema#", "$id": SCHEMA_ID,
            "title": "Gap Hunter live state (generated from wt.ops.gap_live.LIVE_ALLOW)",
            **body, "required": list(REQUIRED)}


def session_today(now: dt.datetime, cache: Path) -> tuple[dt.datetime, dt.datetime] | None:
    """(open, close) of today's New York session, or None on a day with none. Read from the market calendar once a
    day and kept; when the calendar cannot be read, the weekday fallback is used and not kept."""
    from wt.ops.window import load_sessions
    today = now.astimezone(ET).date().isoformat()
    try:
        kept = json.loads(cache.read_text())
        if isinstance(kept, dict) and kept.get("day") == today:
            if kept.get("open") is None:
                return None
            return dt.datetime.fromisoformat(kept["open"]), dt.datetime.fromisoformat(kept["close"])
    except (OSError, ValueError, KeyError, TypeError):
        pass
    sessions, exact = load_sessions(now, back=0, ahead=0)
    s = sessions.get(now.astimezone(ET).date())
    if exact:
        try:
            safeio.atomic_write(cache, json.dumps({"day": today, "open": s.open.isoformat() if s else None,
                                                   "close": s.close.isoformat() if s else None}), cache.parent)
        except OSError:
            pass
    return (s.open, s.close) if s else None


def due(now: dt.datetime, session: tuple[dt.datetime, dt.datetime] | None) -> bool:
    """True on every minute from 08:30 New York to close + 15 on a session day, and on the 15-minute rhythm
    otherwise. A quiet journal is still sent each minute: the page's freshness reads the document's own as_of."""
    n = now.astimezone(ET)
    if session is not None:
        start = dt.datetime.combine(n.date(), OPEN_FROM, tzinfo=ET)
        if start <= n <= session[1] + AFTER_CLOSE:
            return True
    return n.minute % SLOW_EVERY_MIN == SLOW_AT


def build(now: dt.datetime, run_id: str, san: publish.Sanitizer, view: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """The document: the snapshot's own `gap_hunter` block, cleaned by the same allow-list."""
    raw = {"gap_hunter": dict(view) if view is not None else publish.gap_hunter_view()}
    clean: dict[str, Any] = san.apply(LIVE_ALLOW, raw)
    clean.update(schema=SCHEMA_ID, schema_version=SCHEMA_VERSION, run_id=run_id,
                 as_of=now.isoformat(timespec="seconds"), paper=True)
    return clean


def validate(doc: Mapping[str, Any], schema_path: Path = SCHEMA_PATH) -> list[str]:
    import jsonschema
    schema = json.loads(schema_path.read_text()) if schema_path.exists() else to_schema()
    v = jsonschema.Draft7Validator(schema)
    return [f"{'/'.join(map(str, e.absolute_path))}: {e.message[:160]}" for e in v.iter_errors(doc)][:20]


def body(doc: Mapping[str, Any]) -> bytes:
    return json.dumps(doc, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")


def site_accepts(url: str, bypass: str | None, now: dt.datetime, cache: Path) -> int:
    """The newest gap-hunter-live version the dashboard validates (/api/health), remembered for an hour; 0 when it
    cannot be read or the site does not know the document yet, so a host deployed before the site sends nothing."""
    try:
        kept = json.loads(cache.read_text())
        if isinstance(kept, dict) and 0 <= (now - dt.datetime.fromisoformat(str(kept["at"]))).total_seconds() < ACCEPTS_KEEP_S:
            return int(kept["accepts"])
    except (OSError, ValueError, KeyError, TypeError):
        pass
    health, _ = publish.read_health(url, bypass)
    editions = health.get("editions") if isinstance(health, dict) else None
    mine = editions.get("gap_hunter_live") if isinstance(editions, dict) else None
    accepts = mine.get("accepts") if isinstance(mine, dict) else None
    if not isinstance(accepts, int) or isinstance(accepts, bool):
        return 0
    try:
        safeio.atomic_write(cache, json.dumps({"at": now.isoformat(), "accepts": accepts}), cache.parent)
    except OSError:
        pass
    return accepts


def sanitizer() -> publish.Sanitizer:
    """The snapshot's own cleaning: the secrets redactor, and the leak check when its corpus is there (strict when
    it is not). Fail closed when the secrets file is named but unreadable."""
    env_file = os.environ.get("WT_ENV_FILE")
    if env_file and not publish._nonempty_readable(Path(env_file)):
        raise RuntimeError("secrets file unreadable")
    secrets = safeio.env_secret_values([Path(env_file)] if env_file else [ROOT / ".env"])
    redact = safeio.Redactor(secrets | safeio.secret_env_values())
    leak = publish.LeakIndex(publish.corpus_files(), cache=publish.OUT / "cache")
    return publish.Sanitizer(redact, leak if leak.available else None, strict=not leak.available)


def _run(now: dt.datetime, dry_run: bool, env: Mapping[str, str], out: Path,
         view: Mapping[str, Any] | None = None, san: publish.Sanitizer | None = None) -> tuple[int, str]:
    if not dry_run and not due(now, session_today(now, out / "session.json")):
        return 0, "outside the minute window and off the 15-minute rhythm, not sent"
    run_id = now.strftime("%Y%m%dT%H%M%SZ") + "-" + hashlib.sha1(os.urandom(8)).hexdigest()[:6]
    doc = build(now, run_id, san or sanitizer(), view)
    if bad := validate(doc):
        return 2, "failed schema validation: " + "; ".join(bad)
    data = body(doc)
    out.mkdir(parents=True, exist_ok=True)
    safeio.atomic_write(out / "document.json", data.decode(), out)
    g = doc["gap_hunter"]
    said = f"{len(g.get('timeline') or [])} timeline rows, position {'open' if g.get('position') else 'none'}, {len(data)} bytes"
    if dry_run:
        return 0, f"{said}; dry run, not sent"
    if publish.shadow_key_problem(dict(env)) is not None:
        return 0, f"{said}; a shadow host without its own key, not sent"
    url, secret = env.get("DASHBOARD_INGEST_URL"), env.get("DASHBOARD_INGEST_SECRET")
    if not url or not secret:
        return 0, f"{said}; DASHBOARD_INGEST_URL / DASHBOARD_INGEST_SECRET not set, not sent"
    bypass = env.get("VERCEL_AUTOMATION_BYPASS_SECRET")
    if site_accepts(url, bypass, now, out / "site_accepts.json") < SCHEMA_VERSION:
        return 0, f"{said}; the dashboard does not take the document yet, not sent"
    ok, detail = publish.send(data, url, secret, bypass, tries=SEND_TRIES,
                              deadline=time.monotonic() + SEND_BUDGET_S, key_id=env.get("DASHBOARD_KEY_ID"))
    failed = misses(out / "failures.json", not ok)
    if not ok:
        rc = 1 if failed >= FAIL_AFTER else 0
        return rc, f"{said}; sent: False ({publish.error_code(detail)}), {failed} in a row"
    return 0, f"{said}; sent: True ({detail})"


def misses(path: Path, failed: bool) -> int:
    """Failed sends in a row, this one included: kept across runs, reset by a send that worked."""
    try:
        n = int(json.loads(path.read_text()).get("in_a_row", 0)) if failed else 0
    except (OSError, ValueError, TypeError, AttributeError):
        n = 0
    n = n + 1 if failed else 0
    try:
        safeio.atomic_write(path, json.dumps({"in_a_row": n}), path.parent)
    except OSError:
        pass
    return n


def run(now: dt.datetime | None = None, dry_run: bool = False, env: Mapping[str, str] | None = None,
        out: Path = OUT, view: Mapping[str, Any] | None = None, san: publish.Sanitizer | None = None) -> int:
    """Build, check and send. Never raises."""
    try:
        rc, said = _run((now or dt.datetime.now(dt.UTC)).replace(microsecond=0), dry_run,
                        os.environ if env is None else env, out, view, san)
    except Exception as e:  # noqa: BLE001 — a fault here must never reach the job runner as a traceback
        rc, said = 2, f"fault ({e.__class__.__name__})"
    print(f"gap hunter live: {said}", file=sys.stderr if rc else sys.stdout)
    return rc


def main(argv: Iterable[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m wt.ops.gap_live")
    ap.add_argument("--dry-run", action="store_true", help="build and check the document, write it to the outbox, send nothing")
    a = ap.parse_args(None if argv is None else list(argv))
    return run(dry_run=a.dry_run)


if __name__ == "__main__":
    sys.exit(main())
