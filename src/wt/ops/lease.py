"""The primary lease: at most one host may trade strategy B (ADR 0004, cutover).

The lease is one small JSON object in R2 (`wt-leases/paper-b`): {holder, acquired, expires}. A host acquires or
renews it when its runner arms, with a conditional write, so two hosts can never both believe they hold it:
  * no lease yet             -> PUT If-None-Match: *            (only one creator wins)
  * held by us, or expired   -> PUT If-Match: <etag we read>     (a concurrent writer makes ours fail)
  * held by another, valid   -> refused
Time is the store's (the response Date header), never this host's clock. Anything unexpected (store unreachable,
a lost race, a malformed lease) refuses: the runner turns entries off and keeps managing exits.
`make lease-break` (owner) expires the lease by writing it back with a past expiry; it never deletes it.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import socket
from dataclasses import dataclass

from wt.ops.r2 import R2, Response

BUCKET = os.environ.get("R2_LEASE_BUCKET", "wt-leases")
KEY = "paper-b"
TTL = dt.timedelta(hours=20)


@dataclass
class Result:
    ok: bool
    reason: str


def host_id() -> str:
    return os.environ.get("WT_HOST_ID") or socket.gethostname().split(".")[0]


def _parse(r: Response) -> dict[str, str] | None:
    try:
        data = json.loads(r.body)
        return data if isinstance(data, dict) and "holder" in data and "expires" in data else None
    except ValueError:
        return None


def acquire(client: R2 | None = None, holder: str | None = None) -> Result:
    c, me = client or R2(), holder or host_id()
    if not c.configured:
        return Result(False, "lease store not configured (R2_* missing)")
    try:
        cur = c.get(BUCKET, KEY)
        now = cur.server_time
        if now is None:
            return Result(False, f"lease store gave no server time (HTTP {cur.status})")
        body = json.dumps({"holder": me, "acquired": now.isoformat(), "expires": (now + TTL).isoformat()}).encode()
        if cur.status == 404:
            w = c.put(BUCKET, KEY, body, if_none_match="*")
        elif cur.status == 200:
            lease = _parse(cur)
            if lease is None:
                return Result(False, "the lease object is malformed: owner must run make lease-break")
            expires = dt.datetime.fromisoformat(lease["expires"])
            if lease["holder"] != me and expires > now:
                return Result(False, f"held by {lease['holder']} until {lease['expires']}")
            w = c.put(BUCKET, KEY, body, if_match=cur.etag)
        else:
            return Result(False, f"lease store answered HTTP {cur.status}")
    except Exception as e:  # noqa: BLE001 — any doubt refuses (entries off, exits managed)
        return Result(False, f"lease store unreachable ({e.__class__.__name__})")
    if w.status in (200, 201):
        return Result(True, f"held by {me} until {(now + TTL).isoformat()}")
    if w.status == 412:
        return Result(False, "lost a race for the lease (another host wrote it first)")
    return Result(False, f"lease write answered HTTP {w.status}")


def break_lease(client: R2 | None = None, by: str = "owner") -> Result:
    """Owner only: expire the lease so the next host to arm takes it (kept, never deleted, for the record)."""
    c = client or R2()
    cur = c.get(BUCKET, KEY)
    if cur.status == 404:
        return Result(True, "no lease to break")
    past = (cur.server_time or dt.datetime.now(dt.UTC)) - dt.timedelta(seconds=1)
    body = json.dumps({"holder": f"broken-by-{by}", "acquired": past.isoformat(), "expires": past.isoformat()})
    w = c.put(BUCKET, KEY, body.encode(), if_match=cur.etag)
    return Result(w.status in (200, 201), f"HTTP {w.status}")


if __name__ == "__main__":
    import sys
    r = break_lease() if sys.argv[1:] == ["break"] else acquire()
    print(("OK: " if r.ok else "REFUSED: ") + r.reason)
    sys.exit(0 if r.ok else 1)
