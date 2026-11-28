# Environment variables

Every environment variable the code reads: its name, who reads it, and where it is set. **Names only, never
values.** Checked against the code at `9441a547` on 2026-11-25.

`tests/unit/test_docs_truth.py` finds every name the code reads literally, through `os.environ[...]`, `os.getenv`,
`.get("…")` on an environment, or `process.env.X`. It fails if one is missing from the tables below. Names the code
reads through a variable (for example a key pair chosen per desk) are listed here by hand.

**Where values are set:**
- **Host secrets:** `/etc/wt/secrets.env` on the GCP host, typed by the owner with `sudo wt-set-secrets`. At boot
  `wt-fetch-secrets` copies **only the names in its `REQUIRED` and `OPTIONAL` lists** to `/run/wt-secrets/env`, which
  every unit loads (`deploy/oci/bin/wt-fetch-secrets`). A name outside those lists never reaches a job, even if
  it is in `secrets.env`. "Host secrets, required" marks the `REQUIRED` names: without one, the fetch fails. A test
  keeps this page and those lists in step.
- **Host, Webull:** `/etc/wt/webull.env`, set with `sudo wt-set-webull-secret`, read only by the `wt-webull` user
  (ADR 0011).
- **Unit:** set by the generated systemd unit or by `wt.ops.jobs` for each job.
- **Vercel:** the dashboard project's environment variables.
- **GitHub:** a secret or variable of a GitHub Environment (`production`, `staging`, `registry`) or of the repository.
- **Mac:** the console checkout's `~/trading/.env`, for hand-run tools only. `.env.example` lists its names.

## Trading and safety

| Name | Read by | Set in |
|---|---|---|
| `MODE` | `src/wt/core/safety.py`, the runners, `brokers/alpaca_read.py` | Unit (`wt.ops.jobs` sets it per job: `paper` for `paper-s` and `paper-o`, `backtest` otherwise) |
| `LIVE_TRADING_ENABLED` | `src/wt/core/safety.py` (must be unset or `0`/`false`/`no`/`off`; any other value refuses) | The owner alone. Never set on the host |
| `APCA_API_BASE_URL` | `src/wt/core/safety.py` (must be the paper endpoint if set) | Normally unset |
| `APCA_API_KEY_ID`, `APCA_API_SECRET_KEY` | Market-data jobs and tools (`brokers/alpaca_read.py`, `options/live.py`, `options/pipeline_check.py`, …): the "Robot B stocks" account, market data only | Host secrets, required; Mac |
| `APCA_CLONE_KEY_ID`, `APCA_CLONE_SECRET_KEY` | The options clone (`brokers/alpaca_options_paper.py`, `options/paper_site.py`), and the rollback's account check (`ops/deploy.py`); the lab's key prefix | Host secrets |
| `APCA_S_KEY_ID`, `APCA_S_SECRET_KEY` | Gap Hunter (`live/runner_s.py`); `paper-s` is refused without them (`ops/jobs.py`); the rollback checks its account with them (`ops/deploy.py`) | Host secrets (set, checked 2026-11-25); Mac |
| `APCA_OPTIONS_KEY_ID`, `APCA_OPTIONS_SECRET_KEY` | **Legacy.** Only `options/live.py`'s positions read, when set; the clone no longer falls back to it. [paper-accounts.md](../runbooks/paper-accounts.md) says the account was deleted | Host secrets (passed if present; not set, checked 2026-11-25) |
| `WT_ROLE` | `live/runner_s.py`, `live/runner_o.py`, `live/runner_b.py`, `ops/backup.py`, …: `shadow` makes Gap Hunter's and the options clone's brokers refuse orders; the clone refuses any other value ([safety.md](../operations/safety.md)) | Host secrets (`primary` on the host, checked 2026-11-25). `wt-set-secrets` offers `shadow` as its default, the code defaults to `primary` |
| `WT_EXITS_ONLY` | `live/runner_o.py`, `live/runner_b.py`. Read, but nothing sets it any more | — |

## Host identity and runtime

| Name | Read by | Set in |
|---|---|---|
| `WT_HOST` | `ops/host.py` and others: `systemd` on the host | Unit; `wt-deploy` |
| `WT_ENV_FILE` | `core/config.py` and others: the secrets file to load (`/run/wt-secrets/env`) | Unit |
| `WT_STATE` | `core/config.py`: the runtime-state directory, default `var/`. Not set on the host | — |
| `WT_HOST_ID` | `ops/lease.py`, `ops/backup.py`, `ops/hostsync.py` | Host secrets |
| `PRIMARY_HOST` | The dashboard's ingest (`lib/ingest.ts`, `lib/ingest-scope.ts`): whose snapshot is live | Vercel |
| `CREDENTIALS_DIRECTORY`, `STATE_DIRECTORY` | `webull/pull.py` (systemd `LoadCredential` / `StateDirectory`) | Unit (Webull pull) |
| `WT_DEBUG` | `scanner/features.py` | By hand |
| `WT_DAILY_FULL` | `scripts/forward_test.py` | By hand |

## Deploy and CI on the host

| Name | Read by | Set in |
|---|---|---|
| `GH_TOKEN` | `ops/ci.py` (reads the checks), `ops/alerts.py` | Host secrets |
| `GITHUB_TOKEN` | `ops/ci.py`, `ops/alerts.py`, as a fallback name | GitHub Actions; not passed on the host |
| `WT_REQUIRED_CHECKS` | `ops/ci.py`: the checks an owner's deploy requires, default `test,dashboard-gate` | By hand, owner |
| `WT_DEPLOY_CI_OVERRIDE` | `ops/deploy.py`: the owner deploys a commit whose checks can't be read, giving a reason | By hand, owner, one deploy |
| `WT_DASHBOARD_GUARD_OVERRIDE` | `ops/dashguard.py`: the owner passes the dashboard guard, giving a reason | By hand, owner, one deploy |

## Alerts and dead-man's switches

| Name | Read by | Set in |
|---|---|---|
| `NTFY_TOPIC`, `NTFY_SERVER` | `ops/alerts.py`, `deploy/oci/bin/wt-alert` (through `/etc/wt/paging`), the dashboard's watchdog (`lib/ntfy.ts`) | Host secrets (`NTFY_TOPIC` required); Vercel |
| `HC_PING_KEY` | `ops/hc.py` (healthchecks.io) | Host secrets (required on a primary host) |
| `HC_PING_BASE` | `ops/hc.py` | Not passed to the jobs, so the code's default applies |

## Dashboard publishing (host → Vercel)

| Name | Read by | Set in |
|---|---|---|
| `DASHBOARD_INGEST_URL`, `DASHBOARD_INGEST_SECRET` | Every publisher (`ops/publish.py`, `options/live.py`, `options/clone_site.py`, …) | Host secrets, required |
| `DASHBOARD_KEY_ID` | The publishers: which ingest key signs | Host secrets |
| `DASHBOARD_INGEST_KEYS`, `DASHBOARD_INGEST_SCOPES` | The dashboard's ingest (`lib/ingest.ts`, `lib/ingest-scope.ts`); `ops/publish.py` | Vercel |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | The publishers (past Vercel Authentication); `dashboard.yml` | Host secrets, required; GitHub |
| `RADAR_INGEST_SECRET` | `scripts/options_edition.py` (signs with key id `radar`); the dashboard's ingest | Vercel; wherever the edition is sent from (a cloud routine, [cloud-routines.md](../runbooks/cloud-routines.md); unverified) |
| `REGISTRY_INGEST_SECRET`, `REGISTRY_INGEST_URL`, `REGISTRY_VERCEL_BYPASS` | `scripts/build_registry.py` in `registry.yml`; the dashboard's ingest | GitHub `registry` Environment; Vercel (the secret) |
| `GITHUB_REGISTRY_TOKEN` | The dashboard (`lib/registry-github.ts`) | Vercel |

## Market data and calendars

| Name | Read by | Set in |
|---|---|---|
| `ALPACA_API_KEY_ID`, `ALPACA_API_SECRET_KEY` | The dashboard's quotes and feed checks (`lib/quote.ts`, …); `ops/keys_check.py` | Vercel |
| `ALPACA_DATA_URL` | The dashboard's data reads | Vercel |
| `ALPACA_FEED`, `ALPACA_OPTION_FEED` | The dashboard's board (`lib/alpaca-feed.ts`): stock feed `iex` or `sip`, option feed. Only the owner changes them ([board-feed.md](../runbooks/board-feed.md)) | Vercel |
| `FRED_API_KEY`, `WT_CONTACT_EMAIL` | `ops/econ_calendar.py`; the dashboard's calendar | Host secrets; Vercel |
| `NEWS_ARCHIVE_TOKEN` | `scripts/news_archive.py` (`data/news_archive.py`): clones and pushes the private news archive | Host secrets |
| `FEED_WATCH_ALERTS` | The dashboard's feed watch (`lib/feed-watch-run.ts`) | Vercel |

## Backups, lease and the options lab (Cloudflare R2)

| Name | Read by | Set in |
|---|---|---|
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | `ops/backup.py`, `ops/r2.py`, `ops/lease.py`, `lab/*` | Host secrets (required on a primary host) |
| `R2_BACKUP_ACCESS_KEY_ID` | `lab/archive.py` only compares against it: the lab refuses a key equal to the main or the backup R2 key | Not passed to the jobs, so the comparison never sees it |
| `R2_LEASE_BUCKET`, `R2_ANCHOR_BUCKET` | `ops/lease.py`, `ops/backup.py` | Optional: default `wt-leases` and `wt-anchors` |
| `R2_LAB_ACCESS_KEY_ID`, `R2_LAB_SECRET_ACCESS_KEY` | `lab/archive.py` | Host secrets |
| `RESTIC_REPOSITORY`, `RESTIC_PASSWORD` | `ops/backup.py`. `wt-install-units` enables the backup timers only when the repository is set | Host secrets (required on a primary host) |
| `WT_LAB_KEY_PREFIX`, `WT_LAB_RATE_LIMIT` | `lab/recorder.py` | Host secrets |
| `WT_LAB_TAPE`, `WT_LAB_BUCKET`, `WT_LAB_BUDGET_PER_MIN` | `lab/recorder.py`, `lab/archive.py`, `lab/probe.py`, `options/lab_tape_status.py` | Not passed to the jobs, so the code's defaults apply; set by hand for a manual run |

## Host access and tunnel

| Name | Read by | Set in |
|---|---|---|
| `CLOUDFLARED_TOKEN` | `wt-fetch-secrets` writes it at boot to `/etc/cloudflared/token` for `wt-tunnel`; it is not put in the jobs' environment | Host secrets |
| `VM_SSH_HOST`, `VM_DEPLOY_KEY`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`, `CLOUDFLARED` | `make vm-deploy` (`Makefile`), the old Cloudflare-Access route to a host | Mac |

## Webull (ADR 0011)

| Name | Read by | Set in |
|---|---|---|
| `WEBULL_APP_KEY`, `WEBULL_APP_SECRET` | `webull/client.py`, as user `wt-webull` only | Host, Webull (`/etc/wt/webull.env`) |

## The dashboard build and runtime

| Name | Read by | Set in |
|---|---|---|
| `CRON_SECRET` | The dashboard's cron routes; `ops/drill.py` (the watchdog drill, run by hand) | Vercel; Mac |
| `BLOB_READ_WRITE_TOKEN` | The `@vercel/blob` SDK (not named in our code) | Vercel |
| `DASHBOARD_FIXTURE` | The dashboard: `1` renders synthetic fixtures (staging, tests) | Vercel (staging); CI |
| `BUILD_SHA` | The dashboard's health and engineering pages | Build |
| `VERCEL_ENV`, `VERCEL_GIT_COMMIT_SHA`, `VERCEL_DEPLOYMENT_ID`, `NODE_ENV` | The dashboard | Set by Vercel / Node |
| `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`, `STAGING_ENABLED` | `.github/workflows/dashboard.yml` | GitHub (`VERCEL_TOKEN` a secret, the rest variables) |
