#!/usr/bin/env python
"""Build the Reference Registry's index from this checkout, and send it to the dashboard.

    python scripts/build_registry.py build --branch integration --sha <40 hex> --out "$RUNNER_TEMP/registry.json"
    python scripts/build_registry.py send --index "$RUNNER_TEMP/registry.json"

Run by .github/workflows/registry.yml on every push to integration and main, and when the owner presses Refresh on
the page (workflow_dispatch). The repository is public, so both commands print one line of counts and outcomes and
never a record's text, and the index is written only under the runner's temporary folder: never uploaded as an
artifact, never committed. See dashboard/README.md, "Reference Registry".

`send` reads, from the environment: REGISTRY_INGEST_URL (the dashboard's /api/ingest), REGISTRY_INGEST_SECRET (the
HMAC key of key id `registry`) and REGISTRY_VERCEL_BYPASS (Vercel's automation bypass).

Exit codes:
  0  built; or sent and stored (`stored`, `duplicate`, or `older`: a newer commit's index is already there); or the
     dashboard does not accept the registry yet (production not released): nothing sent
  1  the build was refused (see the code printed), or the dashboard refused the index or could not be reached
  3  a secret or the URL is missing: nothing sent, and the run fails so the page says "Sync failed" instead of
     waiting quietly (the owner sets them before the workflow is merged)
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import hmac
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from wt.research import registry  # noqa: E402

KEY_ID = "registry"
TIMEOUT_S = 20.0
OK_OUTCOMES = {"stored", "duplicate", "older"}


def sign(body: bytes, secret: str, ts: int) -> str:
    """The ingest's signature (dashboard/src/lib/hmac.ts; the same as wt.ops.publish.sign)."""
    return "sha256=" + hmac.new(secret.encode(), f"{ts}.".encode() + body, hashlib.sha256).hexdigest()


def _request(url: str, *, data: bytes | None = None, headers: dict[str, str] | None = None) -> tuple[int, Any]:
    req = urllib.request.Request(url, data=data, headers=headers or {}, method="POST" if data is not None else "GET")
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as r:  # noqa: S310 (the URL is the owner's variable)
            raw = r.read(1_000_000)
            status = r.status
    except urllib.error.HTTPError as e:
        raw = e.read(1_000_000)
        status = e.code
    try:
        return status, json.loads(raw.decode("utf-8"))
    except ValueError:
        return status, None


def accepts(health: Any) -> int | None:
    """What /api/health says the dashboard accepts for the registry, or None when it does not know the kind yet."""
    try:
        v = health["editions"]["registry"]["accepts"]
    except (KeyError, TypeError):
        return None
    return v if isinstance(v, int) and not isinstance(v, bool) else None


def outcome(status: int, body: Any) -> str:
    """The ingest's own word for what it did: `stored`, `duplicate`, `older`, or the refusal's code."""
    if isinstance(body, dict):
        word = body.get("status") or body.get("error")
        if isinstance(word, str) and word.replace("-", "").isalnum() and len(word) <= 40:
            return word
    return f"http-{status}"


def cmd_build(a: argparse.Namespace) -> int:
    try:
        as_of = registry.commit_time(ROOT, a.sha)
        index = registry.build(ROOT, branch=a.branch, sha=a.sha, as_of=as_of,
                               built_at=dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ"), repo=a.repo)
        body = registry.encode(index)
    except registry.RegistryError as e:
        print(f"registry build refused: {e}")
        return 1
    out = Path(a.out)
    out.write_bytes(body)
    print(registry.summary(index, body))
    return 0


def cmd_send(a: argparse.Namespace, env: dict[str, str] | None = None) -> int:
    env = dict(os.environ) if env is None else env
    url = env.get("REGISTRY_INGEST_URL", "").strip()
    if not url.startswith("https://") or not url.endswith("/api/ingest"):
        print("registry send: REGISTRY_INGEST_URL is not set to an https …/api/ingest address; nothing sent")
        return 3
    bypass = env.get("REGISTRY_VERCEL_BYPASS", "")
    secret = env.get("REGISTRY_INGEST_SECRET", "")
    if not secret or not bypass:
        # Checked before the health read: without the bypass even /api/health is behind Vercel Authentication.
        print("registry send: REGISTRY_INGEST_SECRET or REGISTRY_VERCEL_BYPASS is missing; nothing sent")
        return 3
    headers = {"x-vercel-protection-bypass": bypass}
    try:
        status, health = _request(url[: -len("/api/ingest")] + "/api/health", headers=headers)
    except (urllib.error.URLError, OSError, TimeoutError) as e:
        print(f"registry send: health unreachable ({e.__class__.__name__}); nothing sent")
        return 1
    version = accepts(health) if status == 200 else None
    if status != 200:
        print(f"registry send: health answered http-{status}; nothing sent")
        return 1
    if version is None:
        print("registry send: the dashboard does not accept the registry yet; nothing sent")
        return 0
    if version < registry.SCHEMA_VERSION:
        print(f"registry send: the dashboard accepts version {version}, this index is {registry.SCHEMA_VERSION}; "
              "nothing sent")
        return 1
    body = Path(a.index).read_bytes()
    last = "none"
    for attempt in range(3):
        ts = int(time.time())
        try:
            status, reply = _request(url, data=body, headers={
                "content-type": "application/json", "x-wt-timestamp": str(ts), "x-wt-signature": sign(body, secret, ts),
                "x-wt-key-id": KEY_ID, "x-vercel-protection-bypass": bypass})
        except (urllib.error.URLError, OSError, TimeoutError) as e:
            last = e.__class__.__name__
        else:
            last = outcome(status, reply)
            if last in OK_OUTCOMES:
                print(f"registry send: http-{status} {last}")
                return 0
            if status < 500 and status != 429:
                break
        if attempt < 2:
            time.sleep(2 ** (attempt + 1))
    print(f"registry send: refused or failed ({last})")
    return 1


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build")
    b.add_argument("--branch", required=True, choices=registry.BRANCHES)
    b.add_argument("--sha", required=True)
    b.add_argument("--repo", default="Algorythmos-AI/trading-lab-research")
    b.add_argument("--out", required=True)
    s = sub.add_parser("send")
    s.add_argument("--index", required=True)
    a = p.parse_args(argv)
    return cmd_build(a) if a.cmd == "build" else cmd_send(a)


if __name__ == "__main__":
    raise SystemExit(main())
