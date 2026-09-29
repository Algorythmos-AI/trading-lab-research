# Security

## Reporting

Report a suspected secret leak or vulnerability privately to info@algorythmos.com.au. Never open a public issue.
This repository is restricted (see NOTICE.md) and is meant to be private.

## Current exception: the repository is public (owner risk acceptance)

| | |
|---|---|
| Decided | 2026-09-29, by the owner (skalaliya) |
| Why | GitHub Actions for private repositories is blocked by an org billing issue; public repositories run CI free |
| Accepted risk | The restricted specs and research records in this repository are publicly readable and may be indexed |
| Exit criterion | The org's payment method or Actions spending limit is fixed, private CI is proven to run, then the repository goes private again |
| While it lasts | No new restricted material is added. No infrastructure identifiers (cloud OCIDs, tunnel or Access hostnames, health-check ids, tokens, tfvars, state) are committed; the only accepted ones are the Vercel team/project ids in `dashboard.yml` and the dashboard's public hostname. The weekly evidence job never pushes (`wt.ops.evidence` checks the visibility itself). Secrets are read only by jobs behind the `production` Environment, at step level (`tests/unit/test_workflows.py`). |

## Secrets

- **Where they live.** Secrets live only in `~/trading/.env` (mode 600, never committed), in the GitHub
  `production` Environment (main only), and in Vercel environment variables (Sensitive). Never in git, logs,
  alerts or the dashboard.
- **Blocking them.** gitleaks runs in pre-commit and in CI (`security.yml`). The pre-commit hook also blocks
  `.env*`, `knowledge/`, `data/`, `var/`, `logs/` and PDFs.
- **Scrubbing them.** The dashboard collector redacts `.env` values and token patterns. The publisher drops every
  field it doesn't explicitly allow.
- **Rotating them.** To rotate the dashboard secrets (ingest HMAC, cron secret, ntfy topic), re-run
  `dashboard/scripts/provision_secrets.sh` (see `docs/runbooks/secret-rotation.md`). Broker keys are rotated in
  the broker's console, then updated in `.env`.

## Trading safety

- **Paper only**, by construction. The broker adapter hard-codes the paper endpoint, and the paper-only lock
  (`wt.core.safety`) checks four things when the adapter is built and again before every order:
  - `MODE=paper`
  - `LIVE_TRADING_ENABLED` is not true
  - a paper endpoint
  - a `PA…` account number
- **Every order goes through the pre-trade guard** (`wt.risk.pretrade`), inside the OMS:
  - allowlist
  - hard quantity and notional caps
  - entries per day
  - kill switch
  - loss latch
  - market hours
  - no sell beyond the long position
- **Loss limits latch** and survive restarts and file deletion. Only `make reset-latch REASON=…` clears them, and
  the reset is recorded.
