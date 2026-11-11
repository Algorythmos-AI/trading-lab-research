"""Weekly evidence PR: copy the week's forward evidence into git as NEW, immutable files, through a pull request.

    python -m wt.ops.evidence [--dry-run] [--week 2026-W41]

Every scorecard is archived under the ISO week of its own date, whichever run copies it; the ledger and the
watchlists are copied only by the current week's run, because they are "as of this run". `--week` is the
catch-up: it takes the scorecards of that week alone. A run refuses to start while an evidence/* pull request is
still open, so two weeks never race on the same files, and it stops when the open pull requests cannot be listed.

Runtime files in var/ keep changing. Git only ever receives dated copies that nothing rewrites afterwards:
  * research/forward/archive/<ISO-week>/forward_trades.jsonl   full ledger as of this run (append-only source)
  * research/forward/archive/<ISO-week>/scorecard_<date>.md    scorecards written since the last archive
  * watchlist/<date>.json                                      forward-mode watchlists git doesn't have yet

The PR is built in a throwaway worktree created from origin/integration (where work lands, ADR 0009), so the live
checkout is never switched, and `git pull --ff-only` on it can never collide (ADR 0002). Auth comes from GH_TOKEN (a fine-grained token for this
repo: contents and pull-requests write), so no keychain prompt can hang a launchd job. Without GH_TOKEN the run is
skipped with a log line. While the repository is not confirmed private (`wt.ops.visibility`: a fresh answer, never a
remembered one), nothing is pushed: the run lists what it would commit and stops (the scorecards name setups, which
are restricted). The visibility check pages once per change, never every week. Keys the dashboard refuses to
publish (headlines and the like, `DENIED_KEYS`) are stripped from every JSON copy before it is committed.

A step that fails while publishing (listing the open pull requests, an evidence pull request still open, the fetch,
the worktree, the commit, the push, opening the pull request, gh missing, or the run's time budget) stops the run
with one alert of its own, `evidence-pr:<step>`, whose text is the step, an outcome word, the week and a count: never
the remote's error text, a path or a token (those go to the job's log only, token redacted). It then exits 0, like
every failed check (wt.ops.preflight): only a crash exits non-zero, and the weekly job (wt.ops.jobs) pages for that.
The next run that publishes, or finds nothing new, resolves every `evidence-pr:*` alert. A dry run (`--dry-run`,
`make evidence`) sends nothing: a failed step there prints the step and exits 1.
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
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any, Protocol

from wt.core.clock import ET
from wt.core.config import FORWARD_LEDGER, FORWARD_WATCHLIST_DIR, ROOT, SCORECARD_DIR
from wt.ops import visibility
from wt.ops.alerts import count, word
from wt.ops.visibility import Probe, repo_visibility  # noqa: F401 — repo_visibility: the one answer, re-exported

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
# The run's own time budget, under the 600 s the weekly job gives it (wt.ops.jobs.publish_evidence): a step that
# would run past it stops the run with its own alert instead of the job killing it with none. Everything after the
# visibility probe draws from it, the final worktree removal included (at least REMOVE_MIN_S). What runs after the
# budget is spent is bounded too: one stop alert (wt.ops.alerts: a spool flush that stops at the first failed send
# and the send itself, 5 s each). Worst case: BUDGET_S + REMOVE_MIN_S + ALERT_WORST_S, about 420 s.
BUDGET_S = 400.0
STEP_TIMEOUT_S = 120.0
REMOVE_MIN_S = 5.0
ALERT_WORST_S = 10.0
PARENT_TIMEOUT_S = 600.0                 # wt.ops.jobs.publish_evidence
# The steps a publishing run can stop at, and the alert key of each (evidence-pr:<step>).
STEPS = ("pr-list", "pr-open", "fetch", "worktree", "commit", "push", "pr-create")
OUTCOMES = ("failed", "timed out", "gh missing", "still open")
ALERT_PREFIX = "evidence-pr:"
_WEEK = re.compile(r"\d{4}-W\d{2}")


class Sender(Protocol):
    def fire(self, key: str, title: str, message: str, priority: int = ...) -> bool: ...
    def resolve(self, key: str, title: str, message: str, priority: int = ...) -> bool: ...


class Stop(Exception):
    """A publishing step failed. `step` is one of STEPS and `outcome` one of OUTCOMES: the only words the alert
    carries. The cause's own text stays in `detail`, for the job's log."""

    def __init__(self, step: str, outcome: str, detail: str = "") -> None:
        super().__init__(f"{step} {outcome}")
        self.step, self.outcome, self.detail = step, outcome, detail
        self.files = 0                   # new files the stopped run had planned (the alert's count)


class Budget:
    """Seconds left for the run; each step's timeout is the smaller of its own and what is left."""

    def __init__(self, seconds: float = BUDGET_S, clock: Callable[[], float] = time.monotonic) -> None:
        self.clock, self.end = clock, clock() + seconds

    def left(self) -> float:
        return self.end - self.clock()

    def timeout(self, step: str, cap: float = STEP_TIMEOUT_S) -> float:
        left = self.left()
        if left < 5:
            raise Stop(step, "timed out", "the run's time budget is spent")
        return min(cap, left)


def stop_page(stop: Stop, week: str, files: int) -> tuple[str, str]:
    """The alert for a stopped run: fixed words, the step, the outcome, the ISO week and a count."""
    step, outcome = word(stop.step, STEPS, "a step"), word(stop.outcome, OUTCOMES, "failed")
    wk = week if _WEEK.fullmatch(week) else "this week"
    if step == "pr-open":
        msg = (f"Week {wk}: an earlier evidence pull request is still open and needs your merge; nothing new was "
               "pushed. The next weekly run tries again.")
    else:
        pushed = ("The branch was pushed; the pull request was not opened." if step == "pr-create" else
                  "Nothing was pushed.")
        waiting = f" {count(files)} new file(s) wait for the next run." if isinstance(files, int) and files > 0 else ""
        msg = f"Week {wk}: the {step} step {outcome}. {pushed}{waiting} The scorecard log has the detail."
    return "Weekly evidence not published", msg


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


def _git(*args: str, cwd: Path, env: dict[str, str] | None = None, check: bool = True,
         timeout: float = STEP_TIMEOUT_S) -> str:
    r = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, timeout=timeout,
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


def open_evidence_prs(token: str | None, timeout: float = 60.0) -> list[str] | None:
    """Head branches of the evidence/* pull requests still open; None when they cannot be listed (gh missing, a
    token without pull-request read, a rate limit), which the caller treats as a stop, never as "none open"."""
    env = {**os.environ, "GH_PROMPT_DISABLED": "1", **({"GH_TOKEN": token} if token else {})}
    try:
        r = subprocess.run(["gh", "pr", "list", "-R", REPO, "--state", "open", "--limit", "200", "--json",
                            "headRefName", "--jq", ".[].headRefName"], env=env, capture_output=True, text=True,
                           timeout=timeout)
    except subprocess.TimeoutExpired as e:
        raise Stop("pr-list", "timed out", "gh pr list did not answer") from e
    except (OSError, subprocess.SubprocessError):
        return None
    if r.returncode != 0:
        return None
    return [b for b in r.stdout.split() if b.startswith("evidence/")]


def probe(token: str | None, timeout_s: float = visibility.PROBE_TIMEOUT_S) -> Probe:
    """The visibility answer this run acts on (wt.ops.visibility.probe; a test replaces it)."""
    return visibility.probe(token, timeout_s=timeout_s)


def parked_listing(week: str, catch_up: bool, vis: str) -> int:
    """While the repository is not private: what would be copied, judged against the local checkout only. No fetch,
    no token, no worktree, no network: nothing in it can fail the weekly job. Always 0."""
    try:
        pairs = plan_copies(ROOT, week, catch_up=catch_up)
        rels = [str(d.relative_to(ROOT)) for _, d in pairs]
        print(f"evidence {week}: {len(rels)} new file(s) against the local checkout")
        print("\n".join(f"  {r}" for r in rels))
    except (OSError, ValueError) as e:
        print(f"evidence {week}: the local listing could not be made ({e.__class__.__name__})")
    # the last line, so the weekly job's log always carries it
    print(f"evidence {week}: outcome parked, the repository is {vis}, not private; nothing pushed")
    return 0


def _step(step: str, fn: Any, *args: Any, **kw: Any) -> Any:
    """Run one publishing step; any failure becomes a Stop naming the step, with the cause kept for the log."""
    try:
        return fn(*args, **kw)
    except Stop:
        raise
    except subprocess.TimeoutExpired as e:
        raise Stop(step, "timed out", "") from e
    except FileNotFoundError as e:
        raise Stop(step, "gh missing" if step == "pr-create" else "failed", e.__class__.__name__) from e
    except (OSError, subprocess.SubprocessError, RuntimeError) as e:
        raise Stop(step, "failed", _redact(str(e))[-300:]) from e


def run(dry_run: bool = False, today: dt.date | None = None, week: str | None = None, alerts: Sender | None = None,
        vis_state: Path | None = None, budget: Budget | None = None) -> int:
    budget = budget or Budget()                # first: the probe and every step draw from it
    token = os.environ.get("GH_TOKEN")
    if not token and not dry_run:
        print("evidence PR skipped: GH_TOKEN is not set (fine-grained token, contents + pull-requests write)")
        return 0
    today = today or dt.datetime.now(ET).date()
    if week is not None and week_date(week) > today:
        print(f"evidence {week}: that week has not happened yet")
        return 1
    catch_up = week is not None and week != iso_week(today)
    week = week or iso_week(today)
    if not dry_run:
        if alerts is None:
            from wt.ops.alerts import Alerts
            alerts = Alerts()
        wait = max(5.0, min(visibility.PROBE_TIMEOUT_S, budget.left()))
        vis = visibility.check(token, alerts, path=vis_state, ask=lambda t: probe(t, wait)).answer
        if vis != "private":
            # The scorecards and watchlists name setups (restricted, NOTICE.md): never push them to a repository
            # that is, or might be, public. A parked run lists from the local checkout and stops there; the owner
            # was paged once when the answer changed (wt.ops.visibility), not every week.
            print(f"evidence PR parked: the repository is {vis}, not private; listing only")
            return parked_listing(week, catch_up, vis)
    try:
        _publish(token, week, today, catch_up, dry_run, budget)
    except Stop as e:
        print(f"evidence {week}: stopped at {e.step} ({e.outcome})" + (f": {e.detail}" if e.detail else ""))
        if dry_run:
            return 1                     # a manual --dry-run whose step failed: nothing is paged
        title, msg = stop_page(e, week, e.files)
        assert alerts is not None
        alerts.fire(ALERT_PREFIX + word(e.step, STEPS, "other"), title, msg, 3)
        print(f"evidence {week}: outcome stopped-{e.step}; the owner is alerted")
        return 0
    if not dry_run and alerts is not None:
        for step in STEPS:
            alerts.resolve(ALERT_PREFIX + step, "Weekly evidence published again",
                           f"Week {week if _WEEK.fullmatch(week) else 'this week'}: the run finished.", 2)
    return 0


def _publish(token: str | None, week: str, today: dt.date, catch_up: bool, dry_run: bool, budget: Budget) -> int:
    """The run's steps. Returns the number of new files; raises Stop when a publishing step fails."""
    if not dry_run:
        busy = open_evidence_prs(token, timeout=budget.timeout("pr-list", 60.0))
        if busy is None:
            raise Stop("pr-list", "failed", "the open pull requests could not be listed (gh, GH_TOKEN or GitHub)")
        if busy:
            raise Stop("pr-open", "still open", f"needs the owner's merge ({', '.join(busy)})")
    branch = f"evidence/{week}"
    wt = WT_ROOT / f"evidence-{week}"
    cred = {"GH_TOKEN": token or ""}
    helper = ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"]
    # --prune with the evidence refspec: a tracking ref left by a merged-and-deleted branch would make the
    # --force-with-lease below refuse a second push in the same week with "stale info".
    _step("fetch", _git, *helper, "fetch", "--quiet", "--prune", "origin", BASE,
          "+refs/heads/evidence/*:refs/remotes/origin/evidence/*", cwd=ROOT, env=cred, timeout=budget.timeout("fetch"))
    if wt.exists():
        _step("worktree", _git, "worktree", "remove", "--force", str(wt), cwd=ROOT, check=False,
              timeout=budget.timeout("worktree"))
    _step("worktree", _git, "worktree", "add", "--quiet", "-B", branch, str(wt), f"origin/{BASE}", cwd=ROOT,
          timeout=budget.timeout("worktree"))
    files = 0
    try:
        pairs = plan_copies(wt, week, catch_up=catch_up)
        if not pairs:
            print(f"evidence {week}: nothing new")
            return 0
        files = len(pairs)
        dropped = sum(copy_clean(src, dst) for src, dst in pairs)
        rels = [str(d.relative_to(wt)) for _, d in pairs]
        print(f"evidence {week}: {len(rels)} new file(s)" + (f", {dropped} denied key(s) stripped" if dropped else ""))
        if dry_run:
            print("\n".join(f"  {r}" for r in rels))
            return files
        what = (f"catch-up: the scorecards of {week}" if catch_up else
                f"the forward ledger, scorecards and forward watchlists as of {today}")
        _step("commit", _git, "add", "--", *rels, cwd=wt, timeout=budget.timeout("commit"))
        _step("commit", _git, "-c", "user.name=skalaliya", "-c", "user.email=skalaliya@gmail.com", "commit", "--quiet",
              "-m", f"data(forward): evidence for {week}\n\nImmutable copies of {what} (ADR 0002). Nothing existing "
              "is modified.", cwd=wt, timeout=budget.timeout("commit"))
        # pushurl, not a bare URL: with a bare URL git has no tracking ref and --force-with-lease expects the branch
        # to be absent, so a second run in the same week is rejected. Fetches keep using origin's own URL.
        _step("push", _git, *helper, "-c", f"remote.origin.pushurl={PUSH_URL}", "push", "--quiet",
              "--force-with-lease", "origin", f"{branch}:{branch}", cwd=wt, env=cred, timeout=budget.timeout("push"))
        gh = {**os.environ, "GH_TOKEN": token or "", "GH_PROMPT_DISABLED": "1"}
        body = ((f"Catch-up: the scorecards of {week}" if catch_up else f"Weekly forward evidence for {week}")
                + ", copied from `var/` into new, immutable files.\n\n" + "\n".join(f"- `{r}`" for r in rels))
        c = _step("pr-create", subprocess.run, ["gh", "pr", "create", "-R", REPO, "--base", BASE, "--head", branch,
                                               "--title", f"data(forward): evidence for {week}", "--body", body],
                  env=gh, capture_output=True, text=True, timeout=budget.timeout("pr-create"))
        if c.returncode != 0 and "already exists" not in (c.stderr or ""):
            raise Stop("pr-create", "failed", _redact((c.stderr or c.stdout).strip())[-200:])
        try:
            m = subprocess.run(["gh", "pr", "merge", branch, "-R", REPO, "--auto", "--squash", "--delete-branch"],
                               env=gh, capture_output=True, text=True, timeout=budget.timeout("pr-create"))
            if m.returncode != 0:
                print(f"auto-merge not enabled for {branch} (repository setting \"Allow auto-merge\"; the owner "
                      f"merges by hand until it is on): {_redact((m.stderr or m.stdout).strip())[-200:]}")
        except (OSError, subprocess.SubprocessError, Stop) as e:     # the pull request is open: the week is done
            print(f"auto-merge not requested for {branch} ({e.__class__.__name__}); the owner merges by hand")
        print(f"evidence {week}: outcome published, {files} file(s)")
        return files
    except Stop as e:
        e.files = files
        raise
    finally:
        try:
            _git("worktree", "remove", "--force", str(wt), cwd=ROOT, check=False,
                 timeout=max(REMOVE_MIN_S, min(60.0, budget.left())))
        except (OSError, subprocess.SubprocessError):
            pass                         # a worktree left behind is removed by the next run


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
