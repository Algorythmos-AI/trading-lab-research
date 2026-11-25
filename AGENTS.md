# AGENTS.md: rules for automated contributors in trading-lab-research

Read the org rules first (`Algorythmos-AI/algorythmos-handbook` AGENTS.md and `catalog.yaml`). This file adds the rules
specific to this repository. Where the two conflict, the org file's "Never" sections win.

## Hard rules

1. **Paper only.** Real-money trading is never enabled from this repo.
   - The broker adapter hard-codes paper access.
   - `MODE`, `LIVE_TRADING_ENABLED` and any live keys belong to the owner alone.
   - Never submit orders outside `wt.live` / `wt.oms`.
   - The crypto desk is closed (DEC-0036) and its code (`wt.crypto`) was deleted (ADR 0005, addendum). If it ever
     returns, it books simulated fills on public market data only: no venue credentials, no private endpoint and no
     order route, and none may be added.
   - **Three paper accounts, no more** (`docs/runbooks/paper-accounts.md`): "Robot B stocks (host)" (`APCA_API_*`,
     market data, places no order), "Clone options (host)" (`APCA_CLONE_*`, the options clone) and "Gap Hunter"
     (`APCA_S_*`, the stock desk). There is no "QQQ account": QQQ is a ticker. Never create, delete, rename or reset
     an account, or generate a key pair; check which account a pair reaches, read-only, before relying on it.
2. **Pre-registration.** Every strategy or evaluation change needs a hypothesis, an experiment and a decision
   record in `research/`, written before any affected P&L is viewed.
   - Experiments are append-only: a re-run gets a new EXP id.
   - A holdout is run once per frozen config.
3. **The live checkout is production.**
   - Since 2026-10 the jobs run on the cloud host (`docs/runbooks/gcp-host.md`): systemd runs the working tree
     of `/home/wt/trading` there. It changes only through the gated deploy (`wt-deploy`), never by hand.
   - Where the owner has switched it on, the host runs that same gated deploy itself once an hour (ADR 0008):
     merging to `main` is then deploying, a few hours later, so work lands on `integration` first (rule 5). A
     release that changes units, host helpers or the deploy's own code waits for the owner. Automated contributors never start a deploy, and never create or
     remove `var/deploy/AUTO_ON`.
   - The Mac's `~/trading` is no longer what runs. It is a console checkout and may be far behind
     `origin/main`: read the state of the code from `origin/main`, never from it.
   - Develop in a worktree (`git worktree add ~/trading-wt/<branch> origin/integration`). Remove it when its pull
     request is merged; share a `.venv` between worktrees if the disk is short.
   - Never edit, switch branches in, or reinstall the venv of a checkout that runs jobs while any `wt-*` or
     `com.wt.*` job is running.
   - Session times follow America/New_York, so Sydney clock rules break at every DST change.
   - Several agent sessions may work here at once. Before numbering a record or touching a shared file, read
     `origin/integration` and the open pull requests, and say which ids and files you are taking.
4. **Units and agents.** Never load, unload, enable, disable or kickstart the `wt-*` systemd units or the
   `com.wt.*` launchd agents. Hand the owner the command (`sudo wt-install-units`, or the `make` target).
5. **Branches, commits and PRs** (ADR 0009).
   - `integration` is the default branch. Branch from `origin/integration`, open the PR into `integration`, let
     the `test` and `dashboard-gate` checks pass, then squash-merge. A push to `integration` deploys the staging
     dashboard (synthetic data); it never reaches the host or production.
   - `main` is production. It takes only a Release PR from `integration` and `hotfix/*` PRs (the `release-source`
     check), merged with a merge commit, never squashed. The owner merges them. Release PRs go in after the US
     close.
   - A hotfix branches from `origin/main` as `hotfix/<what>`. Once it is merged, open a PR from `main` into
     `integration` and merge it with a merge commit, so the next release carries it.
   - No `Co-Authored-By` trailer and no AI-tool mention anywhere (org decision D-016).
   - Author: `skalaliya <skalaliya@gmail.com>`.

## Data classes

The repo is **restricted**: it holds specifications and research notes derived from third-party course material
(see `NOTICE.md`).

| Class | Examples | May be published (dashboard, issues, logs) |
|---|---|---|
| RESTRICTED | `research/specs/**`, `research/external/**`, report.md files, spec requirement text, setup names, news headlines, `knowledge/`; decision and hypothesis prose anywhere but the Reference Registry (below) | Never |
| RECORD | the titles and prose of the records in `research/decisions/`, `research/hypotheses/`, `research/experiments/` (their `config.*` and `README.md`, never a `report.md`) and `research/lessons_learned/` | Only on the owner-only dashboard's Reference Registry, behind Vercel Authentication, sent by the registry job alone (below). Never in issues, logs, alerts or any other page |
| PRIVATE | account balances, host details, log lines, commit subjects, owner notes | Only behind the owner's login, redacted |
| SAFE | counts, IDs, statuses, dates, R-multiples and statistics | Yes, behind the owner's login |

The Reference Registry (`stocksdelta/registry`, key id `registry`, owner decision of 2026-11-25) is the dashboard's
index of the research records, built in CI from the repository and sent through the signed ingest. It may carry
RECORD text: each record's title and a capped summary of its own prose, never a whole file. It never carries anything
RESTRICTED: no file under `research/specs/` or `research/external/`, nothing from `knowledge/`, and no `report.md`.
Its CI job prints counts and hashes only and keeps no artifact. Until the pull request that turns its prose on is
merged (`dashboard/src/lib/registry-policy.json`, `"prose": true`), it carries SAFE fields only.

The dashboard's Radar page (`stocksdelta/radar`, key id `radar`) carries the owner's own pre-market research from
public sources, not material derived from this repo. It is PRIVATE: owner-only, behind the login. The denylist still
applies to it, and nothing from `research/`, `knowledge/` or the specs may be put into a radar edition. The Options page
(`stocksdelta/options`, the same key) is the same class under the same rules. So is the Trades page
(`stocksdelta/journal`, the same key): the owner's own closed trades, never committed here; its fixture is synthetic.
So is Card record (`/options/record`, `stocksdelta/ledger`, the same key): how the owner's focus card did, sent by the
private focus-card-ledger repo after each close; its fixture's prices are synthetic.
The selection funnel's health (`stocksdelta/funnel`, the same key) is sent by the private trading-options-funnel repo
after it seals a night's evidence: counts, statuses, dates and hashes only (no symbols, prices, scores or outcomes,
so the DEC-0046/DEC-0047 blind rule holds); it is shown on the Operations page.
The Radar desk file (`stocksdelta/radar-desk`, the same key) is PRIVATE, behind the owner's login only, under the same
rules: sent by trading-options-funnel each morning, it holds, per Options desk name, the Radar's list codes, grades and
levels beside the desk's, earnings dates and closed flag codes. Codes, numbers and dates only, no free text and no
outcomes; display only (it changes no pick, board state or checklist). The Options page shows the session's focus names
only, never set against the other names (DEC-0047 section 8); its feed is on the Operations page. Its fixture's prices
and dates are synthetic.

## Layout

```
src/wt/        core · data · scanner · signals · backtest · risk · oms · brokers · live · options · lab · analytics ·
               ops · research · specs · webull · owner · knowledge
scripts/       research drivers and nightly jobs (forward_test, premarket_routine, status_dashboard, ...)
research/      hypotheses/ experiments/ decisions/ active_strategies/ lessons_learned/ specs/ forward/
config/        ranking and catalyst configs, macro-event calendar, dashboard config
deploy/        host helpers, systemd units and first-boot files (gcp/, oci/), and the jobs' run scripts
docs/          adr/ · runbooks/ · incidents/ · releases/ (what is deployed where: read the newest record first)
               A cloud routine reviews the project each weekday after the close (docs/runbooks/cloud-routines.md,
               "The daily review"): when a fault was found only by hand, add its check there.
tests/unit/    pytest suite (CI-safe: fixtures and tmp_path only, no network)
```

Git-ignored: `data/` (market caches and `data/live/`), `knowledge/`, `logs/`, `var/` (runtime state), `.env`, `KILL`.

## Everyday commands

```
make bootstrap     # .venv from requirements.lock.txt
make ci            # ruff + mypy (typed modules) + restricted paths + pytest; most of the required `test` check, not all
                   #   (CI also runs actionlint, the ARM64 install, the schema diff and the per-commit restricted check)
make hooks         # pre-commit: gitleaks, restricted-path guard, ruff
```

Each desk has its own kill file; no single file stops every desk. On the host (`/home/wt/trading`), the options
clone reads the root `KILL` and `var/options/KILL`, and Gap Hunter reads only `var/smallcap/KILL`. While a desk's file
exists, it makes no new entries and keeps managing exits. See `docs/operations/safety.md`.
