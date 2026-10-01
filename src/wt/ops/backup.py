"""Off-host evidence protection for the OCI host (ADR 0004, plan O-3).

    python -m wt.ops.backup nightly         # verify chains -> restic backup to R2 -> write-once daily anchor
    python -m wt.ops.backup restore-test    # restore the latest snapshot into a temp dir and verify it
    python -m wt.ops.backup prune           # the Mac only: forget old snapshots and prune (see below)

Why each piece:
  * The forward ledger and the paper journal are the evidence G2 rests on, and live on one disk. restic keeps
    encrypted, deduplicated snapshots in Cloudflare R2, outside OCI (an Always Free account can vanish).
  * A hash chain can't show an edit to its last line, or a truncated tail. The daily anchor writes the line count
    and head hash to a bucket that is locked (write-once, If-None-Match: *), so tomorrow's chain must extend it.
  * A broken chain turns paper-B entries off (a flag file the runner checks) and pages; exits keep being managed.
  * The R2 bucket lock covers restic's data/ and snapshots/ prefixes for 30 days, so the VM can't delete them;
    `prune` runs from the Mac and treats "unable to remove" (still locked) as a warning.
  * Two hosts share one repository (the Mac seeds the VM through it, and a shadow runs next to the primary), so
    every snapshot carries `--host <WT_HOST_ID>` and a `role:` tag, and restore-test restores this host's own
    latest snapshot. A shadow's anchors go under shadow/<host>/: the write-once anchor of a day belongs to the
    primary, and a shadow claiming it first would make the primary's anchor look like rewritten history.
  * The market-data caches (data/) are backed up on Fridays; the timer fires Mon..Fri only.

Environment: RESTIC_REPOSITORY (s3:https://<account>.r2.cloudflarestorage.com/wt-backups), RESTIC_PASSWORD,
R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY (restic reads them as AWS_* credentials).
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

from wt.core import ledger
from wt.core.clock import ET
from wt.core.config import DATA_DIR, FORWARD_LEDGER, ROOT, STATE_DIR
from wt.ops import hc
from wt.ops.alerts import Alerts
from wt.ops.r2 import R2

JOURNAL = DATA_DIR / "live" / "journal.jsonl"
CHAIN_FLAG = STATE_DIR / "evidence" / "chain-broken"      # present = entries off (wt.live.runner_b)
DIGEST = STATE_DIR / "dashboard" / "evidence_digest.json"
ANCHOR_BUCKET = os.environ.get("R2_ANCHOR_BUCKET", "wt-anchors")
NIGHTLY = ["var", "data/live", "logs"]
WEEKLY = ["data"]                                          # the market-data caches: RTO, not evidence
WEEKLY_DAY = 4                                             # Friday: the backup timer fires Mon..Fri
KEEP_WITHIN = "45d"


def host() -> str:
    return os.environ.get("WT_HOST_ID") or socket.gethostname().split(".")[0]


def role() -> str:
    return os.environ.get("WT_ROLE", "primary")


def anchor_key(day: dt.date) -> str:
    key = f"anchors/{day.isoformat()}.json"
    return key if role() != "shadow" else f"shadow/{host()}/{key}"


def restic(*args: str, timeout: float = 3600) -> subprocess.CompletedProcess[str]:
    env = {**os.environ, "AWS_ACCESS_KEY_ID": os.environ.get("R2_ACCESS_KEY_ID", ""),
           "AWS_SECRET_ACCESS_KEY": os.environ.get("R2_SECRET_ACCESS_KEY", ""), "AWS_DEFAULT_REGION": "auto"}
    return subprocess.run(["restic", *args], cwd=ROOT, env=env, capture_output=True, text=True, timeout=timeout)


def chains() -> dict[str, dict[str, Any]]:
    out = {}
    for name, path in (("forward", FORWARD_LEDGER), ("paper", JOURNAL)):
        n, head = ledger.head(path)
        out[name] = {"lines": n, "head": head, "problems": ledger.verify_chain(path)[:5]}
    return out


def flag_chain(problems: list[str], alerts: Alerts) -> None:
    CHAIN_FLAG.parent.mkdir(parents=True, exist_ok=True)
    CHAIN_FLAG.write_text("\n".join(problems) + "\n")
    alerts.fire("evidence:chain", "Evidence chain broken: paper-B entries off",
                f"{len(problems)} problem(s) in the ledger hash chain; exits are still managed. First: {problems[0]}", 4)


def anchor(day: dt.date, state: dict[str, dict[str, Any]], client: R2 | None = None) -> tuple[bool, str]:
    """Write-once anchor of today's chain heads. A second write with the same heads is fine; different heads for
    an anchored day mean history was rewritten."""
    c = client or R2()
    if not c.configured:
        return False, "R2 not configured"
    body = json.dumps({k: {"lines": v["lines"], "head": v["head"]} for k, v in state.items()}, sort_keys=True)
    key = anchor_key(day)
    w = c.put(ANCHOR_BUCKET, key, body.encode(), if_none_match="*")
    if w.status in (200, 201):
        return True, f"anchored {key}"
    if w.status == 412:
        existing = c.get(ANCHOR_BUCKET, key)
        same = existing.status == 200 and json.loads(existing.body) == json.loads(body)
        return same, f"{key} already anchored" + ("" if same else " with DIFFERENT heads")
    return False, f"anchor write answered HTTP {w.status}"


def nightly(alerts: Alerts | None = None, weekly: bool | None = None, client: R2 | None = None,
            today: dt.date | None = None) -> int:
    alerts = alerts or Alerts()
    today = today or dt.datetime.now(ET).date()
    state = chains()
    problems = [f"{k}: {p}" for k, v in state.items() for p in v["problems"]]
    if problems:
        flag_chain(problems, alerts)
    code = 0
    paths = NIGHTLY + (WEEKLY if (weekly if weekly is not None else today.weekday() == WEEKLY_DAY) else [])
    r = restic("backup", "--host", host(), "--tag", "nightly", "--tag", f"role:{role()}", "--exclude-caches",
               *[p for p in paths if (ROOT / p).exists()])
    if r.returncode not in (0, 3):                       # 3 = snapshot made, some files unreadable
        alerts.fire("backup", "Nightly backup failed", f"restic exit {r.returncode}; see the backup log.", 4)
        print((r.stderr or r.stdout)[-800:], file=sys.stderr)
        code = 1
    elif r.returncode == 3:
        print("restic: snapshot saved; some files were unreadable (see above)", file=sys.stderr)
    ok, why = anchor(today, state, client)
    print(f"anchor: {why}")
    if not ok:
        alerts.fire("anchor", "Daily evidence anchor failed", why, 4 if "DIFFERENT" in why else 3)
        code = code or 1
    DIGEST.parent.mkdir(parents=True, exist_ok=True)
    DIGEST.write_text(json.dumps({"day": today.isoformat(), "verified": not problems, "anchored": ok,
                                  **{k: {"lines": v["lines"], "head": v["head"]} for k, v in state.items()}},
                                 indent=1))
    if code == 0 and not problems:
        alerts.resolve("backup", "Nightly backup: ok", "Backed up and anchored.")
    hc.ping("wt-backup", "" if code == 0 and not problems else "fail", f"anchor: {why}")
    return code


def restore_test() -> int:
    """Restore the latest snapshot's ledgers into a temp dir and check their chains (weekly)."""
    tmp = Path(tempfile.mkdtemp(prefix="wt-restore-"))
    try:
        # By file name: restic stores a snapshot's paths relative to the backed-up directories' common parent
        # ("/var/forward/..."), so the ledgers' absolute paths match nothing and the test restored no file.
        r = restic("restore", "latest", "--host", host(), "--target", str(tmp), "--include", FORWARD_LEDGER.name,
                   "--include", JOURNAL.name)                   # this host's own latest, never the other host's
        if r.returncode != 0:
            print((r.stderr or r.stdout)[-800:], file=sys.stderr)
            return 1
        restored = {p.name: p for p in tmp.rglob("*.jsonl")}
        bad = {n: ledger.verify_chain(p)[:3] for n, p in restored.items() if ledger.verify_chain(p)}
        print(f"restore-test: {len(restored)} ledger(s) restored; " + (f"BROKEN {bad}" if bad else "chains intact"))
        return 1 if bad or not restored else 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def prune() -> int:
    """The Mac only (the VM's credentials can't delete locked objects anyway)."""
    r = restic("forget", "--keep-within", KEEP_WITHIN, "--prune", "--max-unused", "unlimited", timeout=7200)
    out = (r.stdout + r.stderr)
    if r.returncode != 0 and "unable to remove" not in out:
        print(out[-800:], file=sys.stderr)
        return 1
    if "unable to remove" in out:
        print("prune: some objects are still under the 30-day bucket lock; they go next time")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m wt.ops.backup")
    ap.add_argument("cmd", choices=["nightly", "restore-test", "prune"])
    a = ap.parse_args(argv)
    if a.cmd == "nightly":
        return nightly()
    return restore_test() if a.cmd == "restore-test" else prune()


if __name__ == "__main__":
    sys.exit(main())
