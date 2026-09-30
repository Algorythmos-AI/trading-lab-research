"""Watchdog drill: prove, end to end, that the off-host dead-man's switch can page the owner.

    python -m wt.ops.drill            # make watchdog-drill

Calls POST /api/cron/watchdog-drill on the live dashboard. That route runs the real watchdog code (evaluate,
fail-open paging, ntfy delivery) twice against a synthetic snapshot and an in-memory state: first 60 minutes
stale inside a synthetic trading window (a "late" page, priority 4), then fresh (a "recovered" page, priority 2).
Both page titles start with "DRILL:". It never reads or writes the stored alert state or the snapshot history.

Auth: the cron bearer (CRON_SECRET) plus the Vercel Authentication bypass header, both from .env. Neither is
printed. Success means both pages were handed to ntfy; the owner confirms they arrived on the phone.
"""
from __future__ import annotations

import os
import re
import sys

import requests

import wt.core.config  # noqa: F401  (loads .env)


def drill_url(ingest_url: str) -> str:
    return re.sub(r"/api/ingest/?$", "/api/cron/watchdog-drill", ingest_url)


def main() -> int:
    url, cron = os.environ.get("DASHBOARD_INGEST_URL"), os.environ.get("CRON_SECRET")
    if not url or not cron:
        print("DASHBOARD_INGEST_URL / CRON_SECRET not set (run dashboard/scripts/provision_secrets.sh)")
        return 2
    headers = {"authorization": f"Bearer {cron}"}
    if bypass := os.environ.get("VERCEL_AUTOMATION_BYPASS_SECRET"):
        headers["x-vercel-protection-bypass"] = bypass
    try:
        r = requests.post(drill_url(url), headers=headers, timeout=60)
        body = r.json()
    except (requests.RequestException, ValueError) as e:
        print(f"drill request failed: {e.__class__.__name__}")
        return 1
    pages = body.get("pages") or []
    kinds = [(p.get("kind"), p.get("priority"), p.get("result")) for p in pages]
    print(f"HTTP {r.status_code}; pages: {kinds}")
    ok = r.ok and [k[:2] for k in kinds] == [("late", 4), ("recovered", 2)] and all(k[2] == "sent" for k in kinds)
    print("drill OK: check the phone for two DRILL pages" if ok else "drill FAILED: see the pages above")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
