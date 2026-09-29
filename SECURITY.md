# Security

## Reporting

Report a suspected secret leak or vulnerability privately to info@algorythmos.com.au. Never open a public issue.
This repository is private and restricted (see NOTICE.md).

## Secrets

- **Where they live.** Secrets live only in `~/trading/.env` (mode 600, never committed), in GitHub Actions
  secrets, and in Vercel environment variables. Never in git, logs, alerts or the dashboard.
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
