"""Is the repository private? The one answer every job that publishes to GitHub acts on, and a record of it.

    python -m wt.ops.visibility status    # the line `make status` prints: the last answer and when it was confirmed
    python -m wt.ops.visibility check     # ask GitHub now, record the answer, alert on a change (the evidence job)

`probe` asks GitHub (`gh api repos/<repo> --jq .visibility`) and answers `private`, `public`, `internal` or `unknown`.
Only a fresh `private` lets a job publish (`wt.ops.evidence`). `unknown` (no network, a timeout, a token GitHub
refused, gh missing) is never taken for private, and on its own it is not an alarm either.

The record (`var/repo-visibility.json`) says what the owner sees and when to page. Pages go through `wt.ops.alerts`
(spool and ntfy, like every job) and carry only the answer word, a count and a cause word:
  * `not-private`: the first answer that is not `private`, after a `private` one or on the first check ever. While the
    answer stays not private nothing more is sent; each run still says it in its own log. A move between `public` and
    `internal` is not paged (both are not private; the log and `make status` show it).
  * `private-again`: the first `private` after a not-private answer (the not-private alert resolves).
  * `unknown`: the third `unknown` in a row (UNKNOWN_ALERT_AFTER), once; resolved by the next known answer.
  * `no-gh`: gh is not installed; once, until it is back. It does not count towards the unknown streak.
"""
from __future__ import annotations

import argparse
import dataclasses
import datetime as dt
import json
import os
import shutil
import subprocess
import sys
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from wt.core.config import STATE_DIR
from wt.ops.alerts import count

REPO = "Algorythmos-AI/trading-lab-research"
STATE = STATE_DIR / "repo-visibility.json"
KNOWN = ("private", "public", "internal")
ANSWERS = (*KNOWN, "unknown")
CAUSES = ("ok", "gh-missing", "timeout", "error")
UNKNOWN_ALERT_AFTER = 3
PROBE_TIMEOUT_S = 60.0
KEY_NOT_PRIVATE = "repo-visibility:not-private"
KEY_UNKNOWN = "repo-visibility:unknown"
KEY_NO_GH = "repo-visibility:no-gh"


class Sender(Protocol):
    def fire(self, key: str, title: str, message: str, priority: int = ...) -> bool: ...
    def resolve(self, key: str, title: str, message: str, priority: int = ...) -> bool: ...


@dataclass(frozen=True)
class Probe:
    answer: str          # one of ANSWERS
    cause: str           # one of CAUSES: why an answer is unknown ("ok" for a known answer)


@dataclass(frozen=True)
class State:
    last: str | None = None              # the latest answer, unknown included
    last_at: str | None = None
    last_cause: str | None = None
    confirmed: str | None = None         # the latest known answer (private, public or internal)
    confirmed_at: str | None = None
    unknown_streak: int = 0              # unknown answers in a row (gh missing not counted)
    unknown_alerted: bool = False


Runner = Callable[..., Any]


def probe(token: str | None, run: Runner = subprocess.run, which: Callable[[str], str | None] = shutil.which,
          timeout_s: float = PROBE_TIMEOUT_S) -> Probe:
    """Ask GitHub for the repository's visibility. Never raises."""
    if which("gh") is None:
        return Probe("unknown", "gh-missing")
    env = {**os.environ, "GH_PROMPT_DISABLED": "1", **({"GH_TOKEN": token} if token else {})}
    try:
        r = run(["gh", "api", f"repos/{REPO}", "--jq", ".visibility"], env=env, capture_output=True, text=True,
                timeout=timeout_s)
    except subprocess.TimeoutExpired:
        return Probe("unknown", "timeout")
    except FileNotFoundError:
        return Probe("unknown", "gh-missing")
    except (OSError, subprocess.SubprocessError):
        return Probe("unknown", "error")
    out = str(getattr(r, "stdout", "") or "").strip() if getattr(r, "returncode", 1) == 0 else ""
    return Probe(out, "ok") if out in KNOWN else Probe("unknown", "error")


def repo_visibility(token: str | None) -> str:
    """'private', 'public', 'internal' or 'unknown' (any failure). Only 'private' allows publishing."""
    return probe(token).answer


def load(path: Path | None = None) -> State:
    """The record; an empty one when it is missing or unreadable (the next check starts it again)."""
    try:
        raw = json.loads((path or STATE).read_text())
    except (OSError, ValueError):
        return State()
    if not isinstance(raw, dict):
        return State()
    fields = {f.name for f in dataclasses.fields(State)}
    try:
        st = State(**{k: v for k, v in raw.items() if k in fields})
    except TypeError:
        return State()
    texts = (st.last_at, st.confirmed_at, st.last_cause)
    ok = (all(t is None or type(t) is str for t in texts)
          and st.last in (*ANSWERS, None) and st.confirmed in (*KNOWN, None) and isinstance(st.unknown_streak, int)
          and not isinstance(st.unknown_streak, bool) and st.unknown_streak >= 0 and isinstance(st.unknown_alerted, bool))
    return st if ok else State()


def save(state: State, path: Path | None = None) -> None:
    path = path or STATE
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.parent / f".{path.name}.{uuid.uuid4().hex}.tmp"
    try:
        tmp.write_text(json.dumps(dataclasses.asdict(state), indent=1, sort_keys=True) + "\n")
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def decide(prev: State, p: Probe, now: dt.datetime) -> tuple[State, list[str]]:
    """The new record and the events to page, from the previous record and a fresh answer. Pure."""
    at = now.astimezone(dt.UTC).isoformat(timespec="seconds")
    answer = p.answer if p.answer in ANSWERS else "unknown"
    cause = p.cause if p.cause in CAUSES else "error"
    events: list[str] = []
    if prev.last_cause == "gh-missing" and cause != "gh-missing":
        events.append("gh-back")
    if answer in KNOWN:
        if answer != "private" and prev.confirmed in (None, "private"):
            events.append("not-private")
        elif answer == "private" and prev.confirmed not in (None, "private"):
            events.append("private-again")
        if prev.unknown_alerted:
            events.append("known-again")
        return State(last=answer, last_at=at, last_cause="ok", confirmed=answer, confirmed_at=at), events
    if cause == "gh-missing":
        if prev.last_cause != "gh-missing":
            events.append("gh-missing")
        streak, alerted = prev.unknown_streak, prev.unknown_alerted
    else:
        streak = prev.unknown_streak + 1
        alerted = prev.unknown_alerted
        if streak >= UNKNOWN_ALERT_AFTER and not alerted:
            events.append("unknown")
            alerted = True
    return dataclasses.replace(prev, last="unknown", last_at=at, last_cause=cause, unknown_streak=streak,
                               unknown_alerted=alerted), events


def page(event: str, state: State, alerts: Sender) -> None:
    """Send one event. Every text is fixed words plus an answer word, a cause word and a count."""
    answer = state.confirmed if state.confirmed in KNOWN else "unknown"
    if event == "not-private":
        alerts.fire(KEY_NOT_PRIVATE, "Repository is not private",
                    f"GitHub answers {answer}. Weekly evidence is not pushed while the repository is not private; "
                    "each run lists it in its own log. Sent once per change.", 3)
    elif event == "private-again":
        alerts.resolve(KEY_NOT_PRIVATE, "Repository is private again",
                       "GitHub answers private. Weekly evidence publishes on its next run.", 2)
    elif event == "unknown":
        cause = state.last_cause if state.last_cause in CAUSES else "error"
        alerts.fire(KEY_UNKNOWN, "Repository visibility unknown",
                    f"{count(state.unknown_streak)} checks in a row could not read it (last cause: {cause}). Nothing is "
                    "published until GitHub answers private. Sent once.", 3)
    elif event == "known-again":
        alerts.resolve(KEY_UNKNOWN, "Repository visibility readable again", f"GitHub answers {answer}.", 2)
    elif event == "gh-missing":
        alerts.fire(KEY_NO_GH, "gh is not installed on the host",
                    "The visibility check and the weekly evidence need gh. Nothing is published until it is back.", 3)
    elif event == "gh-back":
        alerts.resolve(KEY_NO_GH, "gh is installed again", "The visibility check can run.", 2)


def line(state: State) -> str:
    """`repo visibility: <answer> (...)`, for `make status` and the jobs' logs."""
    if state.last is None:
        return "repo visibility: unknown (never checked: the weekly evidence job checks it, or run make visibility)"
    answer = state.last if state.last in ANSWERS else "unknown"
    when = (f"last confirmed {state.confirmed} on {state.confirmed_at[:10]}"
            if state.confirmed in KNOWN and state.confirmed_at else "never confirmed")
    extra = ""
    if answer == "unknown":
        cause = state.last_cause if state.last_cause in CAUSES else "error"
        extra = f"; {state.unknown_streak} unknown answer(s) in a row, last cause {cause}"
    return f"repo visibility: {answer} ({when}{extra})"


def check(token: str | None, alerts: Sender | None = None, path: Path | None = None, now: dt.datetime | None = None,
          ask: Callable[[str | None], Probe] = probe) -> Probe:
    """Ask, record, page any change, print the line. A record that cannot be written still answers (and says so):
    a full disk must not make a public repository look private, and it cannot, since only `answer` decides."""
    p = ask(token)
    prev = load(path)
    state, events = decide(prev, p, now or dt.datetime.now(dt.UTC))
    try:
        save(state, path)
    except OSError as e:                  # paged anyway: the alert state (wt.ops.alerts) still sends each key once
        print(f"repo visibility record not written ({e.__class__.__name__})")
    if alerts is None and events:
        from wt.ops.alerts import Alerts
        alerts = Alerts()
    for ev in events:
        if alerts is not None:
            page(ev, state, alerts)
    print(line(state))
    return p


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m wt.ops.visibility")
    ap.add_argument("cmd", choices=("status", "check"))
    a = ap.parse_args(argv)
    if a.cmd == "status":
        print(line(load()))
        return 0
    check(os.environ.get("GH_TOKEN"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
