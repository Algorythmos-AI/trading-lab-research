"""Weekly evidence PR: copy the week's forward evidence into git as NEW, immutable files, through a pull request.

    python -m wt.ops.evidence [--dry-run] [--week 2026-W41]

Every scorecard is archived under the ISO week of its own date, whichever run copies it; the ledger and the
watchlists are copied only by the current week's run, because they are "as of this run". `--week` is the
catch-up: it takes the scorecards of that week alone. A run refuses to start while an evidence/* pull request is
still open, so two weeks never race on the same files, and it stops (exit 1, so the job alerts) when the open
pull requests cannot be listed at all.

Runtime files in var/ keep changing. Git only ever receives dated copies that nothing rewrites afterwards:
  * research/forward/archive/<ISO-week>/forward_trades.jsonl   full ledger as of this run (append-only source)
  * research/forward/archive/<ISO-week>/scorecard_<date>.md    scorecards written since the last archive
  * watchlist/<date>.json                                      forward-mode watchlists git doesn't have yet

The PR is built in a throwaway worktree created from origin/integration (where work lands, ADR 0009), so the live
checkout is never switched, and `git pull --ff-only` on it can never collide (ADR 0002). Auth comes from GH_TOKEN (a fine-grained token for this
repo: contents and pull-requests write), so no keychain prompt can hang a launchd job. Without GH_TOKEN the run is
skipped with a log line. While the repository is not confirmed private, nothing is pushed: the run lists what it
would commit and stops (the scorecards name setups, which are restricted). Keys the dashboard refuses to publish
(headlines and the like, `DENIED_KEYS`) are stripped from every JSON copy before it is committed.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

from wt.core.clock import ET
from wt.core.config import FORWARD_LEDGER, FORWARD_WATCHLIST_DIR, ROOT, SCORECARD_DIR

REPO = "Algorythmos-AI/trading-lab-research"
# The push goes to GitHub over HTTPS with GH_TOKEN (through gh's credential helper), never through `origin`: on the
# host `origin` is a read-only deploy key once the repository is private, and a read-only remote cannot take a push.
PUSH_URL = f"https://github.com/{REPO}.git"
BASE = "integration"
WT_ROOT = Path.home() / "trading-wt"
# The dashboard's deny list (dashboard/src/lib/validate.ts DENY_KEYS): prose that must not leave the host, at any depth.
DENIED_KEYS = frozenset({"headlines", "review_url", "subject", "statement", "setup", "catalyst_headline",
                         "catalyst_category", "catalyst_type"})
SCORECARD_DATE = re.compile(r"scorecard_(\d{4}-\d{2}-\d{2})\.md$")


def iso_week(d: dt.date) -> str:
    y, w, _ = d.isocalendar()
    return f"{y}-W{w:02d}"


def week_date(week: str) -> dt.date:
    """The Friday of an ISO week given as 2026-W41 (what `--week` names)."""
    m = re.fullmatch(r"(\d{4})-W(\d{2})", week)
    if not m:
        raise ValueError(f"not an ISO week: {week!r} (expected 2026-W41)")
    return dt.date.fromisocalendar(int(m.group(1)), int(m.group(2)), 5)


def strip_denied(obj: object) -> tuple[object, int]:
    """A copy of a JSON document without the denied keys, and how many were dropped."""
    if isinstance(obj, dict):
        out: dict[str, object] = {}
        dropped = 0
        for k, v in obj.items():
            if k in DENIED_KEYS:
                dropped += 1
                continue
            v2, d = strip_denied(v)
            out[k] = v2
            dropped += d
        return out, dropped
    if isinstance(obj, list):
        items = [strip_denied(v) for v in obj]
        return [v for v, _ in items], sum(d for _, d in items)
    return obj, 0


def copy_clean(src: Path, dst: Path) -> int:
    """Copy one evidence file; a JSON file is rewritten without denied keys. Returns the number of keys dropped."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    if src.suffix != ".json":
        shutil.copy2(src, dst)
        return 0
    doc, dropped = strip_denied(json.loads(src.read_text()))
    dst.write_text(json.dumps(doc, indent=2, sort_keys=False) + "\n")
    return dropped


def _redact(text: str) -> str:
    """A token must never reach a log line, whatever git puts in its error text."""
    for name in ("GH_TOKEN", "GITHUB_TOKEN"):
        tok = os.environ.get(name)
        if tok:
            text = text.replace(tok, "***")
    return text


def _git(*args: str, cwd: Path, env: dict[str, str] | None = None, check: bool = True) -> str:
    r = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, timeout=120,
                       env={**os.environ, "GIT_TERMINAL_PROMPT": "0", **(env or {})})
    if check and r.returncode != 0:
        verbs = [a for i, a in enumerate(args) if not a.startswith("-") and (i == 0 or args[i - 1] != "-c")]
        raise RuntimeError(f"git {verbs[0] if verbs else args[0]} failed: "
                           f"{_redact((r.stderr or r.stdout).strip()[-300:])}")
    return r.stdout


def scorecard_week(name: str) -> str | None:
    """The ISO week a scorecard file belongs to, from its date; None for a name that is not one."""
    m = SCORECARD_DATE.search(name)
    if not m:
        return None
    try:
        return iso_week(dt.date.fromisoformat(m.group(1)))
    except ValueError:
        return None


def plan_copies(wt: Path, week: str, ledger: Path | None = None, watchlists: Path | None = None,
                scorecards: Path | None = None, catch_up: bool = False) -> list[tuple[Path, Path]]:
    """(source, destination inside the worktree) pairs for files git doesn't have yet. Never overwrites.

    A scorecard always lands under the ISO week of its own date, so a catch-up and a Friday run can never file the
    same card in two places. The current week's run takes the ledger and the watchlists as of now plus every
    scorecard git lacks; a catch-up (`catch_up`, from `--week`) takes the scorecards of that week alone."""
    ledger, watchlists, scorecards = ledger or FORWARD_LEDGER, watchlists or FORWARD_WATCHLIST_DIR, scorecards or SCORECARD_DIR
    pairs: list[tuple[Path, Path]] = []
    forward = wt / "research" / "forward"
    arch = forward / "archive" / week
    if not catch_up and ledger.exists() and ledger.stat().st_size and not (arch / "forward_trades.jsonl").exists():
        pairs.append((ledger, arch / "forward_trades.jsonl"))
    for s in sorted(scorecards.glob("scorecard_*.md")) if scorecards.exists() else []:
        own = scorecard_week(s.name)
        if own is None or (catch_up and own != week):
            continue
        dst = forward / "archive" / own / s.name
        if not dst.exists() and not any(forward.rglob(s.name)):       # scorecard_2026-09-28.md sits above archive/
            pairs.append((s, dst))
    if not catch_up:
        for w in sorted(watchlists.glob("*.json")) if watchlists.exists() else []:
            dst = wt / "watchlist" / w.name
            if not dst.exists():
                pairs.append((w, dst))
    return pairs


def open_evidence_prs(token: str | None) -> list[str] | None:
    """Head branches of the evidence/* pull requests still open; None when they cannot be listed (gh missing, a
    token without pull-request read, a rate limit), which the caller treats as a stop, never as "none open"."""
    env = {**os.environ, "GH_PROMPT_DISABLED": "1", **({"GH_TOKEN": token} if token else {})}
    try:
        r = subprocess.run(["gh", "pr", "list", "-R", REPO, "--state", "open", "--limit", "200", "--json",
                            "headRefName", "--jq", ".[].headRefName"], env=env, capture_output=True, text=True,
                           timeout=60)
    except (OSError, subprocess.SubprocessError):
        return None
    if r.returncode != 0:
        return None
    return [b for b in r.stdout.split() if b.startswith("evidence/")]


def repo_visibility(token: str | None) -> str:
    """'private', 'public', 'internal' or 'unknown' (any failure). Only 'private' allows publishing evidence."""
    env = {**os.environ, "GH_PROMPT_DISABLED": "1", **({"GH_TOKEN": token} if token else {})}
    try:
        r = subprocess.run(["gh", "api", f"repos/{REPO}", "--jq", ".visibility"], env=env, capture_output=True,
                           text=True, timeout=60)
    except (OSError, subprocess.SubprocessError):
        return "unknown"
    return r.stdout.strip() if r.returncode == 0 and r.stdout.strip() else "unknown"


def run(dry_run: bool = False, today: dt.date | None = None, week: str | None = None) -> int:
    token = os.environ.get("GH_TOKEN")
    if not token and not dry_run:
        print("evidence PR skipped: GH_TOKEN is not set (fine-grained token, contents + pull-requests write)")
        return 0
    if not dry_run:
        vis = repo_visibility(token)
        if vis != "private":
            # The scorecards and watchlists name setups (restricted, NOTICE.md): never push them to a repository
            # that is, or might be, public. The run continues as a dry run so the week's list is still logged.
            print(f"evidence PR parked: the repository is {vis}, not private; listing only (dry run)")
            dry_run = True
    today = today or dt.datetime.now(ET).date()
    if week is not None and week_date(week) > today:
        print(f"evidence {week}: that week has not happened yet")
        return 1
    catch_up = week is not None and week != iso_week(today)
    week = week or iso_week(today)
    if not dry_run:
        busy = open_evidence_prs(token)
        if busy is None:
            print(f"evidence {week}: stopped, the open pull requests could not be listed (gh, GH_TOKEN or GitHub)")
            return 1
        if busy:
            print(f"evidence {week}: stopped, an evidence pull request is still open and needs the owner's merge "
                  f"({', '.join(busy)})")
            return 1
    branch = f"evidence/{week}"
    wt = WT_ROOT / f"evidence-{week}"
    cred = {"GH_TOKEN": token or ""}
    helper = ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"]
    # --prune with the evidence refspec: a tracking ref left by a merged-and-deleted branch would make the
    # --force-with-lease below refuse a second push in the same week with "stale info".
    _git(*helper, "fetch", "--quiet", "--prune", "origin", BASE, "+refs/heads/evidence/*:refs/remotes/origin/evidence/*",
         cwd=ROOT, env=cred)
    if wt.exists():
        _git("worktree", "remove", "--force", str(wt), cwd=ROOT, check=False)
    _git("worktree", "add", "--quiet", "-B", branch, str(wt), f"origin/{BASE}", cwd=ROOT)
    try:
        pairs = plan_copies(wt, week, catch_up=catch_up)
        if not pairs:
            print(f"evidence {week}: nothing new")
            return 0
        dropped = sum(copy_clean(src, dst) for src, dst in pairs)
        rels = [str(d.relative_to(wt)) for _, d in pairs]
        print(f"evidence {week}: {len(rels)} new file(s)" + (f", {dropped} denied key(s) stripped" if dropped else ""))
        if dry_run:
            print("\n".join(f"  {r}" for r in rels))
            return 0
        _git("add", "--", *rels, cwd=wt)
        what = (f"catch-up: the scorecards of {week}" if catch_up else
                f"the forward ledger, scorecards and forward watchlists as of {today}")
        _git("-c", "user.name=skalaliya", "-c", "user.email=skalaliya@gmail.com", "commit", "--quiet", "-m",
             f"data(forward): evidence for {week}\n\nImmutable copies of {what} (ADR 0002). Nothing existing is "
             "modified.", cwd=wt)
        # pushurl, not a bare URL: with a bare URL git has no tracking ref and --force-with-lease expects the branch
        # to be absent, so a second run in the same week is rejected. Fetches keep using origin's own URL.
        _git(*helper, "-c", f"remote.origin.pushurl={PUSH_URL}", "push", "--quiet", "--force-with-lease", "origin",
             f"{branch}:{branch}", cwd=wt, env=cred)
        gh = {**os.environ, "GH_TOKEN": token or "", "GH_PROMPT_DISABLED": "1"}
        body = ((f"Catch-up: the scorecards of {week}" if catch_up else f"Weekly forward evidence for {week}")
                + ", copied from `var/` into new, immutable files.\n\n" + "\n".join(f"- `{r}`" for r in rels))
        c = subprocess.run(["gh", "pr", "create", "-R", REPO, "--base", BASE, "--head", branch,
                            "--title", f"data(forward): evidence for {week}", "--body", body],
                           env=gh, capture_output=True, text=True, timeout=120)
        if c.returncode != 0 and "already exists" not in (c.stderr or ""):
            print(f"evidence PR could not be opened: {(c.stderr or c.stdout).strip()[-200:]}")
            return 1
        m = subprocess.run(["gh", "pr", "merge", branch, "-R", REPO, "--auto", "--squash", "--delete-branch"],
                           env=gh, capture_output=True, text=True, timeout=120)
        if m.returncode != 0:
            print(f"auto-merge not enabled for {branch} (repository setting \"Allow auto-merge\"; the owner merges "
                  f"by hand until it is on): {(m.stderr or m.stdout).strip()[-200:]}")
        return 0
    finally:
        _git("worktree", "remove", "--force", str(wt), cwd=ROOT, check=False)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m wt.ops.evidence")
    ap.add_argument("--dry-run", action="store_true", help="list what would be committed; push nothing")
    ap.add_argument("--week", help="catch up one ISO week (2026-W41): its scorecards only")
    a = ap.parse_args(argv)
    if a.week:
        week_date(a.week)                      # a bad week fails here, before any git command
    return run(dry_run=a.dry_run, week=a.week)


if __name__ == "__main__":
    sys.exit(main())
