"""Push alerts to the owner's phone through ntfy (plan R13).

Rules:
  * Messages carry R and % only. Dollar amounts and account numbers are scrubbed before sending.
  * Alerts fire on state *transitions*. `fire(key)` sends only when `key` was not already firing, and
    `resolve(key)` sends a recovery notice only when it was. `once_per_day` covers refusals.
  * Delivery never raises. Without a topic, or when ntfy is unreachable, the message goes to a spool that the next
    call flushes. Spooled messages older than a day are dropped rather than delivered late.

Priorities: 5 trading-critical (not flat, unknown or short position, latch) · 4 job failed ·
3 refusal / disk / late · 2 daily summary.
"""
from __future__ import annotations

import contextlib
import datetime as dt
import fcntl
import json
import os
import re
import time
import uuid
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import requests

from wt.core.config import STATE_DIR

ALERT_DIR = STATE_DIR / "alerts"
SPOOL_MAX_AGE = dt.timedelta(days=1)
_MONEY = re.compile(r"(?:US|A|AU)?\$\s?-?[\d,]+(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s?(?:USD|AUD)\b", re.I)
# Alpaca paper account ids (PA + alphanumerics) and any bare number of 10+ digits; 8-digit dates survive.
_ACCOUNT = re.compile(r"\bPA[0-9A-Z]{6,}\b|\b\d{10,}\b")


def scrub(text: str) -> str:
    """Remove dollar amounts and long account-like numbers (R13: R and % only)."""
    return _ACCOUNT.sub("[id]", _MONEY.sub("[$]", text))


def _now() -> dt.datetime:
    return dt.datetime.now(dt.UTC)


@contextlib.contextmanager
def _locked(root: Path) -> Iterator[None]:
    root.mkdir(parents=True, exist_ok=True)
    with open(root / ".lock", "w") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)


def _read_state(root: Path) -> dict[str, Any]:
    try:
        data = json.loads((root / "state.json").read_text())
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


_DAY_KEY = re.compile(r":(\d{4}-\d{2}-\d{2})$")
KEEP_DAYS = 14


def _prune(state: dict[str, Any]) -> dict[str, Any]:
    """Drop once-per-day keys older than two weeks so the state file stays small."""
    cutoff = (_now() - dt.timedelta(days=KEEP_DAYS)).date().isoformat()
    out = {}
    for k, v in state.items():
        m = _DAY_KEY.search(k)
        if m and m.group(1) < cutoff:
            continue
        out[k] = v
    return out


def _write_state(root: Path, state: dict[str, Any]) -> None:
    state = _prune(state)
    tmp = root / f".state.{uuid.uuid4().hex}.tmp"
    tmp.write_text(json.dumps(state, indent=1, sort_keys=True))
    os.replace(tmp, root / "state.json")


def _send(msg: dict[str, Any], topic: str | None, server: str, timeout: float = 5.0) -> bool:
    if not topic:
        return False
    headers = {"Title": msg["title"], "Priority": str(msg["priority"])}
    if msg.get("tags"):
        headers["Tags"] = ",".join(msg["tags"])
    try:
        r = requests.post(f"{server.rstrip('/')}/{topic}", data=msg["message"].encode("utf-8"), headers=headers,
                          timeout=timeout)
        return 200 <= r.status_code < 300
    except requests.RequestException:
        return False


class Alerts:
    """ntfy delivery with a spool and transition state under ``root`` (default ``var/alerts``)."""

    def __init__(self, root: Path | None = None, topic: str | None = None, server: str | None = None) -> None:
        self.root = root or ALERT_DIR
        self.topic = topic if topic is not None else os.environ.get("NTFY_TOPIC") or None
        self.server = server or os.environ.get("NTFY_SERVER") or "https://ntfy.sh"

    # ---- delivery -------------------------------------------------------------------------------
    def notify(self, title: str, message: str, priority: int = 3, tags: tuple[str, ...] = ()) -> bool:
        """Send now (after flushing older spooled messages). Returns True when delivered."""
        msg: dict[str, Any] = {"id": uuid.uuid4().hex, "at": _now().isoformat(), "title": scrub(title)[:120],
               "message": scrub(message)[:1000], "priority": max(1, min(5, int(priority))), "tags": list(tags)}
        self.flush()
        if _send(msg, self.topic, self.server):
            return True
        spool = self.root / "spool"
        spool.mkdir(parents=True, exist_ok=True)
        # nanosecond prefix keeps the flush order equal to the send order, even within one second
        (spool / f"{time.time_ns():020d}-{msg['id']}.json").write_text(json.dumps(msg))
        return False

    def flush(self) -> int:
        """Deliver spooled messages oldest first; drop those older than a day. Returns the number delivered."""
        spool = self.root / "spool"
        if not spool.exists():
            return 0
        sent = 0
        for f in sorted(spool.glob("*.json")):
            try:
                msg = json.loads(f.read_text())
                age = _now() - dt.datetime.fromisoformat(msg["at"])
            except (OSError, ValueError, KeyError, json.JSONDecodeError):
                f.unlink(missing_ok=True)
                continue
            if age > SPOOL_MAX_AGE:
                f.unlink(missing_ok=True)
                continue
            if not _send(msg, self.topic, self.server):
                break                       # still offline: keep order, try again next time
            f.unlink(missing_ok=True)
            sent += 1
        return sent

    # ---- transitions ----------------------------------------------------------------------------
    def fire(self, key: str, title: str, message: str, priority: int = 4, tags: tuple[str, ...] = ()) -> bool:
        """Alert when ``key`` starts firing. Repeats while it keeps firing are recorded but not sent."""
        with _locked(self.root):
            state = _read_state(self.root)
            cur = state.get(key) or {}
            if cur.get("firing"):
                cur["last_seen"] = _now().isoformat()
                state[key] = cur
                _write_state(self.root, state)
                return False
            state[key] = {"firing": True, "since": _now().isoformat(), "last_seen": _now().isoformat(),
                          "title": scrub(title)[:120]}
            _write_state(self.root, state)
        self.notify(title, message, priority, tags)
        return True

    def resolve(self, key: str, title: str, message: str, priority: int = 2) -> bool:
        """Send a recovery notice when ``key`` was firing; otherwise do nothing."""
        with _locked(self.root):
            state = _read_state(self.root)
            if not (state.get(key) or {}).get("firing"):
                return False
            state[key] = {"firing": False, "resolved": _now().isoformat()}
            _write_state(self.root, state)
        self.notify(title, message, priority, ("white_check_mark",))
        return True

    def once_per_day(self, key: str, title: str, message: str, priority: int = 3, day: str | None = None) -> bool:
        """At most one alert per ``key`` per calendar day (Sydney date by default)."""
        day = day or dt.datetime.now(dt.UTC).astimezone().date().isoformat()
        return self.fire(f"{key}:{day}", title, message, priority)

    def firing(self) -> dict[str, Any]:
        """Keys currently firing (for the dashboard)."""
        return {k: v for k, v in _read_state(self.root).items() if isinstance(v, dict) and v.get("firing")}
