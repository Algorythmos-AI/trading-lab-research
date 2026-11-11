"""Push alerts to the owner's phone through ntfy (plan R13).

Rules:
  * Messages carry R and % only. Dollar amounts and account numbers are scrubbed before sending.
  * Alerts fire on state *transitions*. `fire(key)` sends only when `key` was not already firing, and
    `resolve(key)` sends a recovery notice only when it was. `once_per_day` covers refusals.
  * Delivery never raises. When ntfy is unreachable, the message goes to a spool that the next call flushes.
    Spooled priority 1-3 messages older than a day are dropped rather than delivered late; priority 4-5 messages
    are kept for a week. The spool holds at most 200 messages (oldest dropped first). A message delivered late says
    when it was raised. Without a topic nothing is spooled: alerts are simply off.
  * Pager wraps Alerts for the trading loop: a bounded queue drained by one background thread, so a slow or
    offline ntfy can never delay an exit.

Priorities: 5 trading-critical (not flat, unknown or short position, latch) · 4 job failed ·
3 refusal / disk / late · 2 daily summary.

What a page may carry. The ntfy topic is public: anyone who knows its name reads every page. So a title and a
message are fixed words from the code plus values that went through one of the guards below: counts, enum words
from a closed set, dates and times, short commit ids, R and %. Never a symbol, a price, an amount, an account value,
a host path or the text of an error (an exception's class name is fine). tests/unit/test_alert_allowlist.py drives
every alert the code can send with hostile inputs and holds the result to `PAGE_CHARS` and the rules there.
"""
from __future__ import annotations

import contextlib
import datetime as dt
import fcntl
import functools
import json
import math
import numbers
import os
import queue
import re
import sys
import threading
import time
import uuid
from collections.abc import Callable, Collection, Iterator
from decimal import Decimal
from pathlib import Path
from typing import Any, TypeVar

import requests

from wt.core.config import STATE_DIR

ALERT_DIR = STATE_DIR / "alerts"
SPOOL_MAX_AGE = dt.timedelta(days=1)             # priority 1-3
SPOOL_MAX_AGE_URGENT = dt.timedelta(days=7)      # priority 4-5: trading-critical, kept until delivered
SPOOL_MAX_FILES = 200
LATE_AFTER = dt.timedelta(minutes=2)
_MONEY = re.compile(r"(?:US|A|AU)?\$\s?-?[\d,]+(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s?(?:USD|AUD)\b", re.I)
# Alpaca paper account ids (PA + alphanumerics) and any bare number of 10+ digits; 8-digit dates survive.
_ACCOUNT = re.compile(r"\bPA[0-9A-Z]{6,}\b|\b\d{10,}\b")
_URL = re.compile(r"\b[a-z][a-z0-9+.-]*://\S+", re.I)
TITLE_MAX, MESSAGE_MAX = 120, 1000
# The characters a page may hold. No "$", "@", quotes, brackets, "=", "<" or a backslash: a scrubbed amount ("[$]")
# or URL ("[url]") fails it too, so a test sees the attempt instead of a quietly cleaned page.
PAGE_CHARS = re.compile(r"[A-Za-z0-9 .,:;()'+%/_>?*-]*")


def scrub(text: str) -> str:
    """Remove URLs, dollar amounts and long account-like numbers (R13: R and % only). The last line of defence:
    a page is built from guarded values (below) in the first place."""
    return _ACCOUNT.sub("[id]", _MONEY.sub("[$]", _URL.sub("[url]", text)))


def render(title: str, message: str) -> tuple[str, str]:
    """What is actually sent for a title and a message (and recorded in the spool and the history)."""
    return scrub(title)[:TITLE_MAX], scrub(message)[:MESSAGE_MAX]


# ---- guards: the only way a value that is not a fixed word gets into a page ----------------------------------------
_HEX = re.compile(r"[0-9a-f]{7,40}")
_DAY = re.compile(r"\d{4}-\d{2}-\d{2}")
_HHMM = re.compile(r"\d{2}:\d{2}")
_IDENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,60}")


RATIO_FORMATS = ("+.2f", "+.0%", "+.1f", ".1f", ".0f")
_RECORD = re.compile(r"(?:DEC|HYP|EXP|ADR)-\d{4}")
_TAG = re.compile(r"runtime-[A-Za-z0-9._-]{1,40}")


_COUNT_MAX = 10**9                       # a count larger than this is not a count (and would read as an account id)
_F = TypeVar("_F", bound=Callable[..., str])


def _total(fallback: str) -> Callable[[_F], _F]:
    """A guard never raises: whatever it is given (a numpy scalar, a Decimal, an object whose __str__ or
    __format__ raises, 10**400), it answers its value or `fallback`."""
    def wrap(fn: _F) -> _F:
        @functools.wraps(fn)
        def inner(*args: Any, **kw: Any) -> str:
            try:
                out = fn(*args, **kw)
            except Exception:  # noqa: BLE001 — a page must never be the thing that crashes a job
                return fallback
            return out if type(out) is str else fallback
        return inner  # type: ignore[return-value]
    return wrap


def _whole(x: object) -> int | None:
    """`x` as a whole number when it is one (int, numpy integer, a whole float or Decimal), else None. A string is
    never a number here: a caller that read digits converts them itself."""
    if isinstance(x, bool) or x is None:
        return None
    if isinstance(x, numbers.Integral):
        n = int(x)
    elif isinstance(x, Decimal):
        if not x.is_finite() or x != x.to_integral_value():
            return None
        n = int(x)
    elif isinstance(x, numbers.Real):
        f = float(x)
        if not math.isfinite(f) or not f.is_integer():
            return None
        n = int(f)
    else:
        return None
    return n if abs(n) < _COUNT_MAX else None


@_total("?")
def count(x: object) -> str:
    """A whole number (a count, a quantity, an exit code; numpy and whole Decimal values too), or "?"."""
    n = _whole(x)
    return "?" if n is None else str(n)


@_total("other")
def word(x: object, allowed: Collection[str], other: str = "other") -> str:
    """`x` when it is one of the closed set `allowed` (enum words the code itself defines), else `other`."""
    return x if type(x) is str and x in allowed else other


@_total("unknown")
def sha(x: object) -> str:
    """A short commit id (8 hex digits), or "unknown"."""
    return x[:8] if type(x) is str and _HEX.fullmatch(x) else "unknown"


@_total("unknown date")
def day(x: object) -> str:
    """A date as YYYY-MM-DD, or "unknown date"."""
    if isinstance(x, dt.datetime):
        return x.date().isoformat()
    if isinstance(x, dt.date):
        return x.isoformat()
    return x if type(x) is str and _DAY.fullmatch(x) else "unknown date"


@_total("?")
def hhmm(x: object) -> str:
    """A time of day as HH:MM, or "?"."""
    if isinstance(x, dt.datetime | dt.time):
        out = f"{x.hour:02d}:{x.minute:02d}"
        return out if _HHMM.fullmatch(out) else "?"
    return x if type(x) is str and _HHMM.fullmatch(x) else "?"


@_total("a decision record")
def record(x: object) -> str:
    """A research record id (DEC-0041, HYP-0032, EXP-0027, ADR-0008), or "a decision record"."""
    return x if type(x) is str and _RECORD.fullmatch(x) else "a decision record"


@_total("the last good tag")
def tag(x: object) -> str:
    """A deploy's runtime tag (runtime-20261112-1), or "the last good tag"."""
    return x if type(x) is str and _TAG.fullmatch(x) else "the last good tag"


@_total("an error")
def exc_name(e: object) -> str:
    """An exception's class name, never its text (which can hold a path, a URL or a remote's answer)."""
    name = type(e).__name__ if isinstance(e, BaseException) else ""
    return name if _IDENT.fullmatch(name) else "an error"


@_total("?")
def ratio(x: object, fmt: str) -> str:
    """A finite number in one of the formats a page may show: "+.2f" (with an R after it), "+.0%", "+.1f", ".1f",
    ".0f". Never a price: a page has no amount and no level (R13, DEC-0044 section 3)."""
    if fmt not in RATIO_FORMATS or isinstance(x, bool) or not isinstance(x, numbers.Real | Decimal):
        return "?"
    f = float(x)                                        # 10**400 raises OverflowError: "?"
    if not math.isfinite(f) or abs(f) >= 1e9:
        return "?"
    out = format(f, fmt)
    if not any(ch in "123456789" for ch in out):        # -0.0, or a tiny negative: never a negative zero
        out = format(0.0, fmt)
    return out


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


HISTORY_MAX_BYTES = 2_000_000


def _history(root: Path, key: str, event: str, title: str, priority: int | None = None) -> None:
    """Append a fired/resolved transition to history.jsonl (the dashboard's alert log). Never raises: a full disk
    or an odd path must not turn an alert into a crash. The file is cut to its newer half past 2 MB."""
    try:
        path = root / "history.jsonl"
        with open(path, "a") as fh:
            fh.write(json.dumps({"at": _now().isoformat(timespec="seconds"), "key": key[:80], "event": event,
                                 "title": scrub(title)[:120], "priority": priority}) + "\n")
        if path.stat().st_size > HISTORY_MAX_BYTES:
            lines = path.read_text().splitlines(keepends=True)
            tmp = root / f".history.{uuid.uuid4().hex}.tmp"
            try:
                tmp.write_text("".join(lines[len(lines) // 2:]))
                os.replace(tmp, path)
            finally:
                tmp.unlink(missing_ok=True)                 # never leave a temp file behind (a full disk)
    except Exception:  # noqa: BLE001, S110 — history is best effort by design
        pass


def _write_state(root: Path, state: dict[str, Any]) -> None:
    state = _prune(state)
    tmp = root / f".state.{uuid.uuid4().hex}.tmp"
    tmp.write_text(json.dumps(state, indent=1, sort_keys=True))
    os.replace(tmp, root / "state.json")


_SECRET = re.compile(r"gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|x-access-token:[^@\s]+@|"
                     r"(?i:bearer)\s+\S+")
SECRET_ENV = ("GH_TOKEN", "GITHUB_TOKEN")


def redact(text: str) -> str:
    """No token reaches a log line: the environment's own token values, and anything shaped like a GitHub token,
    an `x-access-token:` URL credential or a bearer header. One function for every job that logs a child's output."""
    try:
        for name in SECRET_ENV:
            tok = os.environ.get(name)
            if tok:
                text = text.replace(tok, "***")
        return _SECRET.sub(lambda m: "x-access-token:***@" if m.group(0).startswith("x-access-token:") else "***",
                           text)
    except Exception:  # noqa: BLE001 — never raise from a log path
        return "[unloggable text]"


def say(text: str, err: bool = False) -> None:
    """print() that never raises: a closed stdout or stderr, or EPIPE, must not cost a page or a runner's loop."""
    try:
        print(text, file=sys.stderr if err else sys.stdout, flush=True)
    except (OSError, ValueError):
        pass


OFF_ALLOWLIST = {"count": 0}             # pages sent whose text was outside PAGE_CHARS (this process)


def _check_page(msg: dict[str, Any]) -> None:
    """A page whose text is outside the allowlist is still sent (a page must never be lost), but the job's log says
    so and the counter grows, so a future leak is visible. The text itself is not logged here."""
    try:
        ok = all(isinstance(msg.get(k), str) and PAGE_CHARS.fullmatch(msg[k]) for k in ("title", "message"))
    except Exception:  # noqa: BLE001
        ok = False
    if not ok:
        OFF_ALLOWLIST["count"] += 1
        say(f"alerts: a page outside the allowlist was sent ({OFF_ALLOWLIST['count']} in this run); see "
            "docs/runbooks/public-repo-guards.md", err=True)


def _send(msg: dict[str, Any], topic: str | None, server: str, timeout: float = 5.0) -> bool:
    if not topic:
        return False
    _check_page(msg)
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

    def __init__(self, root: Path | None = None, topic: str | None = None, server: str | None = None,
                 send_until: float | None = None, clock: Callable[[], float] = time.monotonic) -> None:
        """`send_until`: a `clock()` time after which nothing more goes on the network (a job with a hard limit,
        such as the evidence run, uses it): a page is spooled instead, for the next job's flush, and a flush stops.
        Each send's timeout is cut to what is left."""
        self.root = root or ALERT_DIR
        self.topic = topic if topic is not None else os.environ.get("NTFY_TOPIC") or None
        self.server = server or os.environ.get("NTFY_SERVER") or "https://ntfy.sh"
        self.send_until, self.clock = send_until, clock

    def _left(self) -> float | None:
        """Seconds of network time left (None: no limit)."""
        return None if self.send_until is None else self.send_until - self.clock()

    def _post(self, msg: dict[str, Any]) -> bool:
        left = self._left()
        if left is not None and left < 1.0:
            return False
        return _send(msg, self.topic, self.server, 5.0 if left is None else min(5.0, left))

    # ---- delivery -------------------------------------------------------------------------------
    def notify(self, title: str, message: str, priority: int = 3, tags: tuple[str, ...] = ()) -> bool:
        """Send now (after flushing older spooled messages). Returns True when delivered."""
        title, message = render(title, message)
        msg: dict[str, Any] = {"id": uuid.uuid4().hex, "at": _now().isoformat(), "title": title,
               "message": message, "priority": max(1, min(5, int(priority))), "tags": list(tags)}
        if not self.topic:
            return False                     # alerts are off; spooling would only grow without bound
        self.flush()
        if self._post(msg):
            return True
        spool = self.root / "spool"
        try:
            spool.mkdir(parents=True, exist_ok=True)
            # nanosecond prefix keeps the flush order equal to the send order, even within one second
            (spool / f"{time.time_ns():020d}-{msg['id']}.json").write_text(json.dumps(msg))
            for old in sorted(spool.glob("*.json"))[:-SPOOL_MAX_FILES]:
                old.unlink(missing_ok=True)
        except OSError:
            pass                             # a full disk must not turn an alert into a crash
        return False

    def flush(self) -> int:
        """Deliver spooled messages oldest first, dropping expired ones. Returns the number delivered."""
        spool = self.root / "spool"
        if not spool.exists() or not self.topic:
            return 0
        sent = 0
        for f in sorted(spool.glob("*.json")):
            left = self._left()
            if left is not None and left < 1.0:
                break                       # out of network time: the next job's flush sends the rest
            try:
                msg = json.loads(f.read_text())
                raised = dt.datetime.fromisoformat(msg["at"])
                age = _now() - raised
                urgent = int(msg.get("priority", 3)) >= 4
            except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError):
                f.unlink(missing_ok=True)
                continue
            if age > (SPOOL_MAX_AGE_URGENT if urgent else SPOOL_MAX_AGE):
                f.unlink(missing_ok=True)
                continue
            if age > LATE_AFTER:
                msg = {**msg, "message": f"(delayed: raised {raised:%Y-%m-%d %H:%M} UTC) {msg['message']}"[:MESSAGE_MAX]}
            if not self._post(msg):
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
            _history(self.root, key, "fired", title, priority)
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
            _history(self.root, key, "resolved", title, priority)
        self.notify(title, message, priority, ("white_check_mark",))
        return True

    def once_per_day(self, key: str, title: str, message: str, priority: int = 3, day: str | None = None) -> bool:
        """At most one alert per ``key`` per calendar day (Sydney date by default)."""
        day = day or dt.datetime.now(dt.UTC).astimezone().date().isoformat()
        return self.fire(f"{key}:{day}", title, message, priority)

    def firing(self) -> dict[str, Any]:
        """Keys currently firing (for the dashboard). A once-per-day key is an event of its day, and nothing ever
        resolves it, so it stops counting after the day that follows: without this, two weeks of daily summaries
        and refusals (and, after a host move, the old host's) all show as firing."""
        cutoff = (_now() - dt.timedelta(days=1)).date().isoformat()
        out = {}
        for k, v in _read_state(self.root).items():
            m = _DAY_KEY.search(k)
            if isinstance(v, dict) and v.get("firing") and not (m and m.group(1) < cutoff):
                out[k] = v
        return out


class Pager:
    """Alerts for a trading loop that must never wait on the network (audit L4).

    Calls return at once: they go on a bounded queue that one daemon thread delivers through ``Alerts`` (which
    takes the state lock, flushes the spool and posts to ntfy). If the queue is full the alert is dropped and
    counted; the job runner's end-of-session check still raises the same keys. ``alerts=None`` makes a silent
    pager (tests and dry runs)."""

    def __init__(self, alerts: Any = None, maxsize: int = 64) -> None:
        self.alerts = alerts
        self.dropped = 0
        self._q: queue.Queue[tuple[str, tuple[Any, ...]] | None] = queue.Queue(maxsize=maxsize)
        self._t: threading.Thread | None = None
        if alerts is not None:
            self._t = threading.Thread(target=self._drain, name="pager", daemon=True)
            self._t.start()

    def fire(self, key: str, title: str, message: str, priority: int = 4) -> None:
        self._put("fire", (key, title, message, priority))

    def resolve(self, key: str, title: str, message: str) -> None:
        self._put("resolve", (key, title, message))

    def once_per_day(self, key: str, title: str, message: str, priority: int = 3) -> None:
        self._put("once_per_day", (key, title, message, priority))

    def _put(self, method: str, args: tuple[Any, ...]) -> None:
        if self._t is None:
            return
        try:
            self._q.put_nowait((method, args))
        except queue.Full:
            self.dropped += 1

    def _drain(self) -> None:
        while True:
            item = self._q.get()
            if item is None:
                return
            method, args = item
            try:
                getattr(self.alerts, method)(*args)
            except Exception:  # noqa: BLE001 — delivery must never take the pager thread down
                pass

    def close(self, timeout_s: float = 15.0) -> None:
        """Deliver what is queued, waiting at most ``timeout_s`` (called once, after the session)."""
        if self._t is None:
            return
        try:
            self._q.put(None, timeout=timeout_s)
        except queue.Full:
            return
        self._t.join(timeout_s)
