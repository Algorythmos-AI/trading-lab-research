"""Dead-man's-switch pings to healthchecks.io, the second off-host monitor after the Vercel watchdog.

Each job pings its own check by slug (the ping key and slug URLs, so no check id ever lives in this repository):
    https://hc-ping.com/<HC_PING_KEY>/<slug>          success
    https://hc-ping.com/<HC_PING_KEY>/<slug>/fail     failure or refusal (a refusal exits 0 but is not success)
Slugs: wt-routine, wt-paper-b-armed, wt-paper-b, wt-forward, wt-weekly. The checks' cron schedules
(docs/runbooks/dead-man-switches.md) tick before the earliest possible ping and allow a long grace, so a normal
day, an early close and a no-session day (the job still runs, exits early and pings) never page falsely.

Never raises, never blocks longer than the timeout, and does nothing without HC_PING_KEY (unset in tests).
Bodies are short, scrubbed of $ amounts and account ids, and say which host sent them.

A shadow host pings no job check: the slugs are shared, so its successes would mask a run the primary missed.
Every host, shadow included, sends its own heartbeat (`wt-host-<WT_HOST_ID>`, from each dashboard publish), so a
host that is down pages at any hour.
"""
from __future__ import annotations

import os
import socket
import threading

import requests

from wt.ops.alerts import scrub

BASE = "https://hc-ping.com"


def host_id() -> str:
    return os.environ.get("WT_HOST_ID") or socket.gethostname().split(".")[0]


def _host_tag() -> str:
    return f"host={host_id()} role={os.environ.get('WT_ROLE', 'primary')}"


def heartbeat_slug() -> str:
    return f"wt-host-{host_id()}"


def ping(slug: str, signal: str = "", body: str = "", timeout: float = 5.0) -> bool:
    """signal: "" (success), "fail", "start" or "log". Returns True when healthchecks.io accepted it."""
    key = os.environ.get("HC_PING_KEY")
    if not key:
        return False
    if os.environ.get("WT_ROLE", "primary") == "shadow" and slug != heartbeat_slug():
        return False                               # a shadow's success would hide a missed primary run
    url = f"{os.environ.get('HC_PING_BASE', BASE).rstrip('/')}/{key}/{slug}" + (f"/{signal}" if signal else "")
    text = scrub(f"{_host_tag()} {body}".strip())[:2000]
    try:
        return requests.post(url, data=text.encode("utf-8"), timeout=timeout).ok
    except requests.RequestException:
        return False


def ping_async(slug: str, signal: str = "", body: str = "") -> None:
    """Fire and forget, for the trading loop: the ping can never delay it."""
    threading.Thread(target=ping, args=(slug, signal, body), name="hc-ping", daemon=True).start()


def heartbeat(body: str = "") -> bool:
    """This host is up and publishing (every host, shadow included)."""
    return ping(heartbeat_slug(), "", body)
