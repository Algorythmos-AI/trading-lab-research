"""The session's focus names for the lab (DEC-0060 section 1): the same signed dashboard route the clone reads.

The clone's own reader (`wt.options.clone_site.read_focus`) imports the order path, so the lab carries this small
copy; `tests/unit/test_lab_probe.py` proves its signature equals `wt.ops.publish.sign`. Only symbols leave this module:
no rank, score or bias.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass

import requests

FOCUS_PATH = "/api/focus"
_SYMBOL = re.compile(r"^[A-Z][A-Z.]{0,9}$")
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


@dataclass(frozen=True)
class Focus:
    session: str
    names: tuple[str, ...]
    sha256: str              # of the answer, as canonical JSON


def focus_url(ingest_url: str) -> str | None:
    out = re.sub(r"/api/ingest/?$", FOCUS_PATH, ingest_url)
    return out if out != ingest_url else None


def signature(secret: str, ts: int) -> str:
    body = f"GET {FOCUS_PATH}".encode()
    return "sha256=" + hmac.new(secret.encode(), f"{ts}.".encode() + body, hashlib.sha256).hexdigest()


def read(env: Mapping[str, str] | None = None, get: Callable[..., requests.Response] | None = None,
         now: Callable[[], float] = time.time) -> Focus | None:
    """The dashboard's latest focus list, or None on any failure. The caller checks `session` against the day."""
    e = os.environ if env is None else env
    ingest, secret = e.get("DASHBOARD_INGEST_URL"), e.get("DASHBOARD_INGEST_SECRET")
    url = focus_url(ingest) if ingest else None
    if not url or not secret:
        return None
    ts = int(now())
    headers = {"x-wt-timestamp": str(ts), "x-wt-signature": signature(secret, ts)}
    if kid := e.get("DASHBOARD_KEY_ID"):
        headers["x-wt-key-id"] = kid
    if bypass := e.get("VERCEL_AUTOMATION_BYPASS_SECRET"):
        headers["x-vercel-protection-bypass"] = bypass
    try:
        r = (get or requests.get)(url, headers=headers, timeout=(5.0, 10.0), allow_redirects=False)
        if r.status_code != 200:
            return None
        body = r.json()
    except (requests.RequestException, ValueError):
        return None
    if not isinstance(body, dict):
        return None
    session, items = body.get("session"), body.get("items")
    if not isinstance(session, str) or not _DATE.match(session) or not isinstance(items, list):
        return None
    names = tuple(dict.fromkeys(str(i["symbol"]) for i in items
                                if isinstance(i, dict) and isinstance(i.get("symbol"), str) and _SYMBOL.match(i["symbol"])))
    digest = hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return Focus(session, names, digest)
