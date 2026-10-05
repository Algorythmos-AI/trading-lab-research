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
from wt.core.desk import DESKS, Desk, installed
from wt.ops import hc
from wt.ops.alerts import Alerts
from wt.ops.r2 import R2

JOURNAL = DATA_DIR / "live" / "journal.jsonl"
CHAIN_FLAG = STATE_DIR / "evidence" / "chain-broken"      # present = entries off (wt.live.runner_b)
DIGEST = STATE_DIR / "dashboard" / "evidence_digest.json"
ANCHOR_BUCKET = os.environ.get("R2_ANCHOR_BUCKET", "wt-anchors")
NIGHTLY = ["var", "data/live", "logs"]
WEEKLY = ["data"]                                          # the market-data caches: RTO, not evidence
WEEKLY_DAY = 4                                             # Friday (the backup timer fires every day)
KEEP_WITHIN = "45d"


def host() -> str:
    return os.environ.get("WT_HOST_ID") or socket.gethostname().split(".")[0]


def role() -> str:
    return os.environ.get("WT_ROLE", "primary")


def anchor_key(day: dt.date, desk: Desk | None = None) -> str:
    """Each desk anchors its own ledgers (ADR 0005). The stocks desk keeps the original key."""
    sub = "" if desk is None or desk.name == "stocks" else f"{desk.name}/"
    key = f"anchors/{sub}{day.isoformat()}.json"
    return key if role() != "shadow" else f"shadow/{host()}/{key}"


def restic(*args: str, timeout: float = 3600) -> subprocess.CompletedProcess[str]:
    env = {**os.environ, "AWS_ACCESS_KEY_ID": os.environ.get("R2_ACCESS_KEY_ID", ""),
           "AWS_SECRET_ACCESS_KEY": os.environ.get("R2_SECRET_ACCESS_KEY", ""), "AWS_DEFAULT_REGION": "auto"}
    return subprocess.run(["restic", *args], cwd=ROOT, env=env, capture_output=True, text=True, timeout=timeout)


def desk_ledgers() -> list[tuple[Desk, str, Path]]:
    """Every hash-chained ledger of every desk this host runs (ADR 0005), stocks first."""
    out = [(DESKS["stocks"], "forward", FORWARD_LEDGER), (DESKS["stocks"], "paper", JOURNAL)]
    return out + [(d, name, path) for d in DESKS.values() if d.name != "stocks" and installed(d)
                  for name, path in d.ledgers]


def chains() -> dict[str, dict[str, Any]]:
    out = {}
    for _, name, path in desk_ledgers():
        n, head = ledger.head(path)
        out[name] = {"lines": n, "head": head, "problems": ledger.verify_chain(path)[:5]}
    return out


def flag_chain(problems: list[str], alerts: Alerts, desk: Desk = DESKS["stocks"]) -> None:
    """A broken chain switches off entries on the desk that owns the ledger, and on no other."""
    flag = CHAIN_FLAG if desk.name == "stocks" else desk.chain_flag
    flag.parent.mkdir(parents=True, exist_ok=True)
    flag.write_text("\n".join(problems) + "\n")
    if desk.name == "stocks":
        key, title = "evidence:chain", "Evidence chain broken: paper-B entries off"
    else:
        key, title = f"{desk.alert_prefix}evidence-chain", f"Evidence chain broken: {desk.name} entries off"
    alerts.fire(key, title,
                f"{len(problems)} problem(s) in the ledger hash chain; exits are still managed. First: {problems[0]}", 4)


def extends(anchored: Any, paths: dict[str, Path]) -> bool:
    """True when every anchored (lines, head) is still line `lines` of its ledger and the ledger's chain is
    intact: the file only grew since. The head line alone is not enough: an earlier line can be rewritten without
    touching it, and only the chain shows that."""
    if not isinstance(anchored, dict) or not anchored:
        return False
    for name, a in anchored.items():
        if not isinstance(a, dict) or name not in paths or ledger.verify_chain(paths[name]):
            return False
        n, head = a.get("lines"), a.get("head")
        if n == 0 and head is None:
            continue                                        # anchored empty: anything since is an append
        if not isinstance(n, int) or ledger.head_at(paths[name], n) != head:
            return False
    return True


def anchor(day: dt.date, state: dict[str, dict[str, Any]], client: R2 | None = None, desk: Desk | None = None,
           paths: dict[str, Path] | None = None) -> tuple[bool, str]:
    """Write-once anchor of today's chain heads. A second write with the same heads is fine; different heads for
    an anchored day mean history was rewritten.

    A desk that writes around the clock (`always_open`) has a newer head every few minutes, so a second backup
    on the same day would always differ. For such a desk the test is the one that matters for an append-only
    file: the anchored head must still be line `lines` of the ledger (`paths`)."""
    c = client or R2()
    if not c.configured:
        return False, "R2 not configured"
    body = json.dumps({k: {"lines": v["lines"], "head": v["head"]} for k, v in state.items()}, sort_keys=True)
    key = anchor_key(day, desk)
    w = c.put(ANCHOR_BUCKET, key, body.encode(), if_none_match="*")
    if w.status in (200, 201):
        return True, f"anchored {key}"
    if w.status in (409, 412):
        # 412: the object exists (If-None-Match). 409: the locked bucket refuses to overwrite an object under
        # retention, which is the same fact told another way (seen on the first second backup of a day,
        # 2026-10-04). Either way the answer is in what is stored: read it back and compare.
        existing = c.get(ANCHOR_BUCKET, key)
        if existing.status != 200:
            return False, f"anchor write answered HTTP {w.status} and {key} could not be read back (HTTP {existing.status})"
        try:
            was = json.loads(existing.body) if existing.status == 200 else None
        except ValueError:
            was = None
        if was is not None and was == json.loads(body):
            return True, f"{key} already anchored"
        if was is not None and desk is not None and desk.session == "always_open" and extends(was, paths or {}):
            return True, f"{key} already anchored; the ledger has only grown since"
        return False, f"{key} already anchored with DIFFERENT heads"
    return False, f"anchor write answered HTTP {w.status}"


def anchor_desks(day: dt.date, state: dict[str, dict[str, Any]], client: R2 | None = None) -> tuple[bool, str]:
    """One anchor per desk, each over its own ledgers. All must hold; the reasons are joined."""
    by_desk: dict[str, tuple[Desk, dict[str, Path]]] = {}
    for d, name, path in desk_ledgers():
        by_desk.setdefault(d.name, (d, {}))[1][name] = path
    oks, whys = [], []
    for d, paths in by_desk.values():
        ok, why = anchor(day, {n: state[n] for n in paths if n in state}, client, d, paths)
        oks.append(ok)
        whys.append(why)
    return all(oks), "; ".join(whys)


def nightly(alerts: Alerts | None = None, weekly: bool | None = None, client: R2 | None = None,
            today: dt.date | None = None) -> int:
    alerts = alerts or Alerts()
    today = today or dt.datetime.now(ET).date()
    state = chains()
    problems = [f"{k}: {p}" for k, v in state.items() for p in v["problems"]]
    owner = {name: d for d, name, _ in desk_ledgers()}
    for desk in DESKS.values():
        mine = [f"{n}: {p}" for n, v in state.items() if owner[n] is desk for p in v["problems"]]
        if mine:
            flag_chain(mine, alerts, desk)
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
    ok, why = anchor_desks(today, state, client)
    print(f"anchor: {why}")
    if not ok:
        alerts.fire("anchor", "Daily evidence anchor failed", why, 4 if "DIFFERENT" in why else 3)
        code = code or 1
    DIGEST.parent.mkdir(parents=True, exist_ok=True)
    DIGEST.write_text(json.dumps({"day": today.isoformat(), "verified": not problems, "anchored": ok,
                                  **{k: {"lines": v["lines"], "head": v["head"]} for k, v in state.items()}},
                                 indent=1))
    if ok:
        alerts.resolve("anchor", "Daily evidence anchor: ok", why)       # nothing else ever cleared this one
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
        names = [a for _, _, path in desk_ledgers() for a in ("--include", path.name)]
        r = restic("restore", "latest", "--host", host(), "--target", str(tmp), *names)   # this host's own latest
        if r.returncode != 0:
            print((r.stderr or r.stdout)[-800:], file=sys.stderr)
            return 1
        restored = {p.name: p for p in tmp.rglob("*.jsonl")}
        bad = {n: ledger.verify_chain(p)[:3] for n, p in restored.items() if ledger.verify_chain(p)}
        # every ledger that had lines when it was backed up must come back: a missing one is not "intact"
        missing = sorted(path.name for _, _, path in desk_ledgers() if path.exists() and path.name not in restored)
        print(f"restore-test: {len(restored)} ledger(s) restored; " + (f"BROKEN {bad}" if bad else "chains intact")
              + (f"; MISSING {missing}" if missing else ""))
        return 1 if bad or missing or not restored else 0
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
