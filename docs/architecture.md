# Architecture: the whole system on one page

Checked against the code at `9441a547` and the live services on 2026-11-25. Names are explained in the
[glossary](reference/glossary.md). This page is the map; each section links to the page that holds the detail.

## 1. The pieces and where they run

```
                    ┌──────────────────────── GCP VM trading-lab-host (us-east1-b) ────────────────────────┐
 GitHub             │ /home/wt/trading = live checkout of main (production), user wt, systemd timers       │
 feature PR         │   jobs (src/wt/ops/schedule.py) ── market data ──► Alpaca data API                    │
  ▼ squash          │                                                                                       │
 integration        │   paper-s (Gap Hunter), paper-o (options clone) ── paper orders ──► 3 Alpaca paper    │
  ▼ release PR      │                                                                       accounts        │
 main ──deploy─────►│                                                                                       │
  (wt-deploy /      │                                                                                       │
   deploy-auto)     │   publishers ── signed POST (HMAC) ──────────────────────────┐                        │
                    │   backups, lease, lab tape ──► Cloudflare R2                  │                        │
                    │   wt-webull-pull (user wt-webull) ──► Webull AU, read only    │                        │
                    │   alerts ──► ntfy (owner's phone) · healthchecks.io pings     │                        │
                    └───────────────────────────────────────────────────────────────│────────────────────────┘
                                                                                    ▼
 Vercel project "trading-lab-dashboard" (lab.algorythmos.com, behind Vercel Authentication)
   /api/ingest → private Blob store → pages (/, /operations, /options, /gap-hunter, /paper, /research, …)
   crons (dashboard/vercel.json): watchdog (pages if the host goes quiet), desk, feeds, feeds-report, flow-baseline
   CI: registry.yml ──signed──► /api/ingest (Reference Registry)

 Outside this repository, sending to the same ingest:
   cloud routines (Radar build, options edition, daily review)  ·  trading-options-funnel (private repo)
   focus-card-ledger (private repo)                             ·  see runbooks/cloud-routines.md
```

Only `main` reaches the host: `integration` goes to `main` through a release PR (ADR 0009), and a push to
`integration` deploys at most the staging dashboard. See [operations/deploy.md](operations/deploy.md).

| Piece | Canonical page |
|---|---|
| The VM: provisioning, secrets, resize, rebuild | [runbooks/gcp-host.md](runbooks/gcp-host.md), [operations/host.md](operations/host.md) |
| What runs when | [operations/jobs.md](operations/jobs.md) |
| How code reaches the VM | [operations/deploy.md](operations/deploy.md) |
| Paper-only lock, kill switches | [operations/safety.md](operations/safety.md) |
| The three paper accounts | [runbooks/paper-accounts.md](runbooks/paper-accounts.md) |
| The dashboard | [dashboard/README.md](../dashboard/README.md) |
| Cloud routines and the other repositories | [runbooks/cloud-routines.md](runbooks/cloud-routines.md) |
| Environment variables | [reference/env-vars.md](reference/env-vars.md) |
| CI | [reference/ci.md](reference/ci.md) |

The Mac's `~/trading` is a console checkout only. It runs no job and may be far behind `origin/main`.

## 2. Data flow to the dashboard

1. A job on the host builds its document. Examples: `wt.ops.publish` builds the status snapshot,
   `wt.options.live` the options positions, `wt.ops.gap_live` Gap Hunter's live state.
2. It drops every field not on its allowlist, signs the document with HMAC under its key id (`DASHBOARD_KEY_ID`), and
   POSTs it to `DASHBOARD_INGEST_URL` past Vercel Authentication (`VERCEL_AUTOMATION_BYPASS_SECRET`). The shared
   sender is `wt.ops.publish.send`.
3. The dashboard's `/api/ingest` checks the signature and the key's scope (`DASHBOARD_INGEST_KEYS`,
   `DASHBOARD_INGEST_SCOPES`), then writes the document to private Blob storage.
4. Pages read the Blob store. The watchdog cron pages the owner when the host's expected windows pass in silence.

What may be published is set by the data classes in [AGENTS.md](../AGENTS.md). The dashboard's own design and
security model are in [dashboard/README.md](../dashboard/README.md).

## 3. Runtime state on the host

| Where | What | Notes |
|---|---|---|
| `var/` (`STATE_DIR`, or `WT_STATE` if set) | Job state, plans, kill files, latches, deploy records, locks, heartbeats, units rendered for diff | Git-ignored. Never in git ([ADR 0002](adr/0002-runtime-state-and-deploy-gate.md)) |
| `data/live/` (`DATA_DIR`) | The desks' journals (`smallcap_journal.jsonl`, `options_journal.jsonl`, the retired `journal.jsonl`) and the retired rule's virtual account | Git-ignored. **Not** moved by `WT_STATE`, unlike `var/` |
| `logs/` | One log per job per day (`<log>_<YYYYMMDD>.log`, Sydney date; see [jobs.md](operations/jobs.md)) | Git-ignored |
| `/run/wt-secrets/env` | The secrets, in tmpfs | See [env-vars.md](reference/env-vars.md) |
| R2 buckets | Backups and anchors, the primary-host lease, the lab's tape | See [backups-and-lease.md](runbooks/backups-and-lease.md) |

## 4. The Python package `src/wt`

<!-- packages:begin (checked against src/wt by tests/unit/test_docs_truth.py) -->
| Package | What it is | Imports (top level, other `wt` packages) |
|---|---|---|
| `core` | Shared types, the New York clock, config and `.env` loading, the paper-only lock (`safety.py`), client order ids, hash-chained ledgers, the desks list | nothing |
| `data` | Alpaca market data and its parquet cache, corporate actions, EDGAR, the universe, the feed guard (`feeds.py`) | core |
| `signals` | Causal indicators, bar alignment, patterns, the frozen research setups | core, backtest, scanner |
| `scanner` | Pre-market features, the pool, frozen ranking, Gap Hunter's selection | core, data, ops, signals |
| `backtest` | The one-minute simulator, management policies, portfolio, stats and the deflated Sharpe ratio | core, data, ops, signals |
| `risk` | The pre-trade guard (`pretrade.py`), the options guard, virtual accounts and latches, stop rules | core, analytics, backtest |
| `brokers` | The broker interface; Alpaca paper adapters (`paper=True`), a read-only reader, sim, shadow and cancel-only brokers | core |
| `oms` | Order managers: the single-position OMS, the multi-leg one Gap Hunter uses, the options OMS | core, brokers, risk |
| `live` | The paper runners: `runner_s` (Gap Hunter), `runner_o` (the clone), `runner_b` (retired); live setups; replay | most packages |
| `options` | The options desk: pricing, levels, the clone's setups, selection stages, Radar selection, editions, the pages' documents | core, data, backtest, oms, ops, risk |
| `lab` | The options lab's tape recorder, archive and reads (DEC-0060) | core, data, options |
| `analytics` | The numbers the dashboard renders (G2, performance, risk and operations views) | core, ops, scanner, signals |
| `ops` | Schedule, units, jobs, the deploy and its gate, publish, alerts, R2, lease, backup, status | core, analytics |
| `research` | Trial registry, run manifests, method presets, the Reference Registry builder, experiment readers | core, backtest, specs |
| `specs` | Loader for `research/specs/*/spec.yaml` | core |
| `webull` | The owner's Webull account, read only (ADR 0011) | — |
| `owner` | The owner's own trades grouped into positions | — |
| `knowledge` | The K0 knowledge-extraction pipeline. Reads the git-ignored `knowledge/`; nothing in the package imports it | — |
<!-- packages:end -->

The "Imports" column lists **top-level** imports only. Many modules also import inside functions to avoid
cycles; `ops`, for example, reaches `live`, `webull` and `research` that way. Known structural debts:

- `signals`, `backtest` and `scanner` import one another at top level.
- `analytics` and `ops` import each other.
- `ops` is imported by lower layers.

## 5. The research side

Research records (`research/`) are append-only and pre-registered. They are the reason any rule or threshold has
its value. See [research/README.md](../research/README.md). Frozen research configuration lives in `config/` (see
[config/README.md](../config/README.md)); changing it is a strategy change and needs records first.
