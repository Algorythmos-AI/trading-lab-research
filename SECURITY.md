# Security

## Reporting

Report a suspected secret leak or vulnerability privately to info@algorythmos.com.au. Never open a public issue.
This repository is restricted (see NOTICE.md) and is meant to be private.

## Current exception: the repository is public (owner risk acceptance)

| | |
|---|---|
| Decided | 2026-09-29, by the owner (skalaliya) |
| Status | Public when checked on 2026-11-25 (`gh api repos/Algorythmos-AI/trading-lab-research`). The visibility has changed more than once since 2026-09-29, and only the owner changes it. The guards act on the live visibility, not on this table ([public-repo-guards.md](docs/runbooks/public-repo-guards.md)) |
| Why | GitHub Actions for private repositories is blocked by an org billing issue; public repositories run CI free |
| Accepted risk | The restricted specs and research records in this repository are publicly readable and may be indexed |
| Exit criterion | The org's payment method or Actions spending limit is fixed, private CI is proven to run, then the repository goes private again |
| While it lasts | No new restricted material is added. No infrastructure identifiers (cloud OCIDs, tunnel or Access hostnames, health-check ids, tokens, tfvars, state) are committed; the only accepted ones are the Vercel team/project ids in `dashboard.yml` and the dashboard's public hostname. The weekly evidence job never pushes (`wt.ops.evidence` checks the visibility itself). Secrets are read only by jobs behind the `production` Environment, at step level (`tests/unit/test_workflows.py`). |

## Secrets

- **Where they live.** Secrets are never in git, logs, alerts or the dashboard. They live in:
  - **the host:** `/etc/wt/secrets.env` (root, 0600), typed by the owner with `sudo wt-set-secrets` and copied at
    boot to tmpfs `/run/wt-secrets/env`. The Webull key is separate, in `/etc/wt/webull.env` (ADR 0011). See
    [gcp-host.md](docs/runbooks/gcp-host.md);
  - **GitHub Environments:** `production` and `staging` (`dashboard.yml`) and `registry` (`registry.yml`);
  - **Vercel environment variables** (Sensitive);
  - **the Mac console checkout's `~/trading/.env`** (mode 600, never committed), for hand-run tools only.
- **Blocking them.** gitleaks runs in pre-commit and in CI (`security.yml`, through the org's reusable security workflow). The pre-commit hook also blocks
  `.env*`, `knowledge/`, `data/`, `var/`, `logs/` and PDFs.
- **Scrubbing them.** The dashboard collector redacts `.env` values and token patterns. The publisher drops every
  field it doesn't explicitly allow.
- **Rotating them.** To rotate the dashboard secrets (ingest HMAC, cron secret, ntfy topic), re-run
  `dashboard/scripts/provision_secrets.sh` (see `docs/runbooks/secret-rotation.md`). Broker keys are rotated in
  the broker's console, then updated in `.env`.

## Trading safety

- **Paper only**, by construction. The broker adapters hard-code the paper endpoint, and the paper-only lock
  (`wt.core.safety`) checks four things when an adapter is built (before each order it checks the environment
  part again). Details: [docs/operations/safety.md](docs/operations/safety.md).
  - `MODE=paper`
  - `LIVE_TRADING_ENABLED` is not true
  - a paper endpoint
  - a `PA…` account number
- **Every order goes through a pre-trade guard inside its OMS**: stock orders through `wt.risk.pretrade`
  (`wt.oms.manager`), option orders through `wt.risk.options_guard` (`wt.oms.options`). The stock guard checks:
  - allowlist
  - hard quantity and notional caps
  - entries per day
  - kill switch
  - loss latch
  - market hours
  - no sell beyond the long position
- **Loss limits latch** and survive restarts. Only the owner clears one, each desk with its own target:
  `make reset-latch-s` (Gap Hunter), `make reset-options-latch` (the options clone) and `make reset-latch` (the
  retired QQQ rule). See [docs/operations/safety.md](docs/operations/safety.md).
