"""Weekly evidence PR: copy the week's forward evidence into git as NEW, immutable files, through a pull request.

    python -m wt.ops.evidence [--dry-run]

Runtime files in var/ keep changing. Git only ever receives dated copies that nothing rewrites afterwards:
  * research/forward/archive/<ISO-week>/forward_trades.jsonl   full ledger as of this run (append-only source)
  * research/forward/archive/<ISO-week>/scorecard_<date>.md    scorecards written since the last archive
  * watchlist/<date>.json                                      forward-mode watchlists git doesn't have yet

The PR is built in a throwaway worktree created from origin/main, so the live checkout is never switched, and
`git pull --ff-only` on it can never collide (ADR 0002). Auth comes from GH_TOKEN (a fine-grained token for this
repo: contents and pull-requests write), so no keychain prompt can hang a launchd job. Without GH_TOKEN the run is
skipped with a log line. While the repository is not confirmed private, nothing is pushed: the run lists what it
would commit and stops (the scorecards name setups, which are restricted).
"""
from __future__ import annotations

import argparse
import datetime as dt
import os
import shutil
import subprocess
import sys
from pathlib import Path

from wt.core.clock import ET
from wt.core.config import FORWARD_LEDGER, FORWARD_WATCHLIST_DIR, ROOT, SCORECARD_DIR

REPO = "Algorythmos-AI/trading-lab-research"
WT_ROOT = Path.home() / "trading-wt"


def iso_week(d: dt.date) -> str:
    y, w, _ = d.isocalendar()
    return f"{y}-W{w:02d}"


def _git(*args: str, cwd: Path, env: dict[str, str] | None = None, check: bool = True) -> str:
    r = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, timeout=120,
                       env={**os.environ, "GIT_TERMINAL_PROMPT": "0", **(env or {})})
    if check and r.returncode != 0:
        raise RuntimeError(f"git {' '.join(args[:2])} failed: {(r.stderr or r.stdout).strip()[-300:]}")
    return r.stdout


def plan_copies(wt: Path, week: str, ledger: Path = FORWARD_LEDGER, watchlists: Path = FORWARD_WATCHLIST_DIR,
                scorecards: Path = SCORECARD_DIR) -> list[tuple[Path, Path]]:
    """(source, destination inside the worktree) pairs for files git doesn't have yet. Never overwrites."""
    pairs: list[tuple[Path, Path]] = []
    arch = wt / "research" / "forward" / "archive" / week
    if ledger.exists() and ledger.stat().st_size and not (arch / "forward_trades.jsonl").exists():
        pairs.append((ledger, arch / "forward_trades.jsonl"))
    for s in sorted(scorecards.glob("scorecard_*.md")) if scorecards.exists() else []:
        dst = arch / s.name
        if not dst.exists() and not any((wt / "research" / "forward" / "archive").glob(f"*/{s.name}")):
            pairs.append((s, dst))
    for w in sorted(watchlists.glob("*.json")) if watchlists.exists() else []:
        dst = wt / "watchlist" / w.name
        if not dst.exists():
            pairs.append((w, dst))
    return pairs


def repo_visibility(token: str | None) -> str:
    """'private', 'public', 'internal' or 'unknown' (any failure). Only 'private' allows publishing evidence."""
    env = {**os.environ, "GH_PROMPT_DISABLED": "1", **({"GH_TOKEN": token} if token else {})}
    try:
        r = subprocess.run(["gh", "api", f"repos/{REPO}", "--jq", ".visibility"], env=env, capture_output=True,
                           text=True, timeout=60)
    except (OSError, subprocess.SubprocessError):
        return "unknown"
    return r.stdout.strip() if r.returncode == 0 and r.stdout.strip() else "unknown"


def run(dry_run: bool = False, today: dt.date | None = None) -> int:
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
    week = iso_week(today)
    branch = f"evidence/{week}"
    wt = WT_ROOT / f"evidence-{week}"
    cred = {"GH_TOKEN": token or ""}
    helper = ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"]
    _git(*helper, "fetch", "--quiet", "origin", "main", cwd=ROOT, env=cred)
    if wt.exists():
        _git("worktree", "remove", "--force", str(wt), cwd=ROOT, check=False)
    _git("worktree", "add", "--quiet", "-B", branch, str(wt), "origin/main", cwd=ROOT)
    try:
        pairs = plan_copies(wt, week)
        if not pairs:
            print(f"evidence {week}: nothing new")
            return 0
        for src, dst in pairs:
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
        rels = [str(d.relative_to(wt)) for _, d in pairs]
        print(f"evidence {week}: {len(rels)} new file(s)")
        if dry_run:
            print("\n".join(f"  {r}" for r in rels))
            return 0
        _git("add", "--", *rels, cwd=wt)
        _git("-c", "user.name=skalaliya", "-c", "user.email=skalaliya@gmail.com", "commit", "--quiet", "-m",
             f"data(forward): evidence for {week}\n\nImmutable copies of the forward ledger, scorecards and forward "
             f"watchlists as of {today} (ADR 0002). Nothing existing is modified.", cwd=wt)
        _git(*helper, "push", "--quiet", "--force-with-lease", "origin", f"{branch}:{branch}", cwd=wt, env=cred)
        gh = {**os.environ, "GH_TOKEN": token or "", "GH_PROMPT_DISABLED": "1"}
        body = (f"Weekly forward evidence for {week}, copied from `var/` into new, immutable files.\n\n"
                + "\n".join(f"- `{r}`" for r in rels))
        c = subprocess.run(["gh", "pr", "create", "-R", REPO, "--base", "main", "--head", branch,
                            "--title", f"data(forward): evidence for {week}", "--body", body],
                           env=gh, capture_output=True, text=True, timeout=120)
        if c.returncode != 0 and "already exists" not in (c.stderr or ""):
            print(f"evidence PR could not be opened: {(c.stderr or c.stdout).strip()[-200:]}")
            return 1
        m = subprocess.run(["gh", "pr", "merge", branch, "-R", REPO, "--auto", "--squash", "--delete-branch"],
                           env=gh, capture_output=True, text=True, timeout=120)
        if m.returncode != 0:
            print(f"auto-merge not enabled for {branch}: {(m.stderr or m.stdout).strip()[-200:]}")
        return 0
    finally:
        _git("worktree", "remove", "--force", str(wt), cwd=ROOT, check=False)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m wt.ops.evidence")
    ap.add_argument("--dry-run", action="store_true", help="list what would be committed; push nothing")
    return run(dry_run=ap.parse_args(argv).dry_run)


if __name__ == "__main__":
    sys.exit(main())
