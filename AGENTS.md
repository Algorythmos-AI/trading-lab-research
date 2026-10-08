# AGENTS.md: rules for automated contributors in trading-lab-research

Read the org rules first (`Algorythmos-AI/.github-private` AGENTS.md and `catalog.yaml`). This file adds the rules
specific to this repository. Where the two conflict, the org file's "Never" sections win.

## Hard rules

1. **Paper only.** Real-money trading is never enabled from this repo.
   - The broker adapter hard-codes paper access.
   - `MODE`, `LIVE_TRADING_ENABLED` and any live keys belong to the owner alone.
   - Never submit orders outside `wt.live` / `wt.oms`.
   - The crypto desk (`wt.crypto`, ADR 0005) books simulated fills on public market data only. It has no venue
     credentials, no private endpoint and no order route, and none may be added.
2. **Pre-registration.** Every strategy or evaluation change needs a hypothesis, an experiment and a decision
   record in `research/`, written before any affected P&L is viewed.
   - Experiments are append-only: a re-run gets a new EXP id.
   - A holdout is run once per frozen config.
3. **The live checkout is production.**
   - Since 2026-10 the jobs run on the cloud host (`docs/runbooks/gcp-host.md`): systemd runs the working tree
     of `/home/wt/trading` there. It changes only through the gated deploy (`wt-deploy`), never by hand.
   - The Mac's `~/trading` is no longer what runs. It is a console checkout and may be far behind
     `origin/main`: read the state of the code from `origin/main`, never from it.
   - Develop in a worktree (`git worktree add ~/trading-wt/<branch> origin/main`). Remove it when its pull
     request is merged; share a `.venv` between worktrees if the disk is short.
   - Never edit, switch branches in, or reinstall the venv of a checkout that runs jobs while any `wt-*` or
     `com.wt.*` job is running.
   - Session times follow America/New_York, so Sydney clock rules break at every DST change.
   - Several agent sessions may work here at once. Before numbering a record or touching a shared file, read
     `origin/main` and the open pull requests, and say which ids and files you are taking.
4. **Units and agents.** Never load, unload, enable, disable or kickstart the `wt-*` systemd units or the
   `com.wt.*` launchd agents. Hand the owner the command (`sudo wt-install-units`, or the `make` target).
5. **Commits and PRs.**
   - Branch, open a PR, and let the `test` check pass, then squash-merge.
   - No `Co-Authored-By` trailer and no AI-tool mention anywhere (org decision D-016).
   - Author: `skalaliya <skalaliya@gmail.com>`.

## Data classes

The repo is **restricted**: it holds specifications and research notes derived from third-party course material
(see `NOTICE.md`).

| Class | Examples | May be published (dashboard, issues, logs) |
|---|---|---|
| RESTRICTED | `research/specs/**`, decision and hypothesis prose, report.md files, spec requirement text, setup names, news headlines, `knowledge/` | Never |
| PRIVATE | account balances, host details, log lines, commit subjects, owner notes | Only behind the owner's login, redacted |
| SAFE | counts, IDs, statuses, dates, R-multiples and statistics | Yes, behind the owner's login |

## Layout

```
src/wt/        data · scanner · signals · backtest · risk · oms · brokers · live · crypto · ops · knowledge · specs
scripts/       research drivers and nightly jobs (forward_test, premarket_routine, status_dashboard, ...)
research/      hypotheses/ experiments/ decisions/ active_strategies/ lessons_learned/ specs/ forward/
config/        ranking and catalyst configs, macro-event calendar, dashboard config
deploy/        launchd agents and their run scripts
tests/unit/    pytest suite (CI-safe: fixtures and tmp_path only, no network)
```

Git-ignored: `data/` (market caches and `data/live/`), `knowledge/`, `logs/`, `var/` (runtime state), `.env`, `KILL`.

## Everyday commands

```
make bootstrap     # .venv from requirements.lock.txt
make ci            # ruff + mypy (typed modules) + pytest; the same as the required CI check
make hooks         # pre-commit: gitleaks, restricted-path guard, ruff
```

The kill switch is the file `~/trading/KILL`. While it exists, the paper runner makes no new entries; it keeps
managing exits.
