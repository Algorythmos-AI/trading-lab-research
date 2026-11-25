# Trading Lab Research

The research and paper-trading engine behind Trading Lab. It holds:
- the `wt` package: data, scanner, signals, backtest, risk, OMS and a paper runner
- the research registry of hypotheses, experiments, decisions, strategies and lessons
- the specifications that the strategies are tested against
- the status dashboard (`dashboard/`) and the jobs that feed it

|                 |                                                                                                                                  |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **Status**      | Active research · paper only, no live trading · two desks trade on paper: Gap Hunter (stocks) and the options clone · the QQQ rule (strategy B) is retired (DEC-0069) |
| **Owner**       | [@Algorythmos-AI/maintainers](https://github.com/orgs/Algorythmos-AI/teams/maintainers)                                          |
| **Runs at**     | One Google Cloud VM, `trading-lab-host` (systemd timers), against three Alpaca **paper** accounts. The Mac runs nothing          |
| **Dashboard**   | [lab.algorythmos.com](https://lab.algorythmos.com) (Vercel login required)                                                        |
| **Run locally** | `make bootstrap && make ci`                                                                                                      |
| **Docs**        | **[Start here: docs/README.md](docs/README.md)** · [Glossary](docs/reference/glossary.md) · [Safety](docs/operations/safety.md) |
| **Context**     | [Research registry](research/README.md) · [G1 summary](research/G1_SUMMARY.md) · [ADRs](docs/adr/) · [Runbooks](docs/runbooks/) · [Security](SECURITY.md) · [Notice](NOTICE.md) · [Licence](LICENSE) |

---

> **Not financial advice.** This is a research tool that trades simulated (paper) money only. A paper-only lock
> (`wt.core.safety`) refuses to send any order that could reach a live account.

> **Restricted, and public for now.** This repository contains material derived from third-party courses
> ([NOTICE.md](NOTICE.md)). It is meant to be private, but it was public when checked on 2026-11-25; the owner
> decides its visibility ([SECURITY.md](SECURITY.md)). The dashboard publishes a sanitized snapshot only.

## Is everything OK?

1. **Look at the dashboard.** The banner is green, amber or red, with the reasons. The first sentence says what
   happened tonight in plain English.
2. **Your phone.** ntfy alerts arrive only when something changes:
   - **priority 5:** not flat at the close, unknown or short position, loss latch
   - **priority 4:** a job failed, or the dashboard went quiet during a trading night
   - **priority 3:** a job refused to run (disk, preflight)
   - **priority 2:** the daily summary after the forward test
3. **In a terminal:** `make status`. It shows the kill switch, each job's last run, firing alerts and preflight.

## How it runs

```
GCP VM trading-lab-host: systemd runs /home/wt/trading (a deployed main commit); runtime state in var/ and data/live/
 ├─ trading jobs (gated: no deploy while they run)
 │   ├─ wt-routine    Mon–Fri 07:30 NY  pre-market dry run (market data only)
 │   ├─ wt-paper-s    Mon–Fri 08:30 NY  Gap Hunter, the stock desk's paper session   ← places paper orders
 │   ├─ wt-paper-o    Mon–Fri 09:00 NY  the options clone's paper session            ← places paper orders
 │   ├─ wt-forward    Mon–Fri 12:40 NY  forward test of the frozen candidates, after the close
 │   └─ wt-weekly     Fri 20:00 NY      weekly scorecard and evidence
 ├─ publishers: wt-dashboard, wt-options-live, wt-gap-hunter-publish, wt-econ-calendar → signed POST to Vercel
 ├─ research and options pipeline: wt-options-select, wt-pipeline-check, wt-options-review, wt-exp0037,
 │                                 wt-lab-tape, wt-lab-archive-check
 ├─ deploy: wt-deploy-notify, wt-deploy-auto (hourly; dry run unless var/deploy/AUTO_ON exists)
 └─ host units: wt-secrets, wt-boot-reconcile, wt-backup, wt-restore-test, wt-tunnel, wt-webull-pull/-publish, wt-alert@
                                     │
Vercel (trading-lab-dashboard) ◄─────┘  private Blob storage; pages; crons: a watchdog that pages
                                         if the host goes quiet in a trading window, and feed checks
```

- The job list comes from `src/wt/ops/schedule.py` (`JOBS`), and the host units from `deploy/oci/systemd/`.
- Every job runs through `wt.ops.jobs`, which gives it a lock, preflight checks, deadlines, alerts and a heartbeat.
- Session times follow New York, so daylight-saving changes need no edits.
- See [ADR 0001](docs/adr/0001-vercel-dashboard.md), [ADR 0002](docs/adr/0002-runtime-state-and-deploy-gate.md) and
  [ADR 0010](docs/adr/0010-gcp-trading-host.md).

## Everyday commands

| Command | What it does |
|---|---|
| `make status` | What's going on right now |
| `make gate` | Is it safe to change the live checkout? (no job running, outside the trading night) |
| `make deploy` | Gate, tag, pull `main`, migrate state, sync the venv, smoke test. Rolls back by itself on failure |
| `make rollback TAG=runtime-YYYYMMDD-N` | Back to an earlier deploy |
| `make kill REASON="…"` / `make unkill` | Write or remove the root `KILL` file. Of the trading desks, only the options clone reads it (no new entries; exits keep being managed). **It does not stop Gap Hunter**, which reads only `var/smallcap/KILL` and has no `make` target: see [docs/operations/safety.md](docs/operations/safety.md) |
| `make reset-latch REASON="…"` | Clears the loss latch of the retired QQQ rule's virtual account (DEC-0069). Nothing trades that account now, so it has no everyday use |
| `make install-trading-agents` | (Re)install the launchd jobs on a Mac. Not used on the VM, whose units the owner installs with `sudo wt-install-units` |
| `make publish DRY_RUN=1` | Build the dashboard snapshot without sending it |
| `make ci` | Lint, type-check and test, as CI does |

## Layout

```
src/wt/          core · data · scanner · signals · backtest · risk · oms · brokers · live · options · lab · analytics ·
                 ops · research · specs · webull · owner · knowledge
scripts/         research drivers and nightly jobs
research/        hypotheses/ experiments/ decisions/ active_strategies/ lessons_learned/ specs/ forward/
config/          ranking, catalyst and risk limits, macro-event calendar, dashboard config
dashboard/       the Vercel dashboard (Next.js)
deploy/          host helpers, units and first-boot files (gcp/, oci/), and the jobs' entry scripts
docs/            start at docs/README.md: ADRs, runbooks, releases, operations, reference
tests/unit/      pytest suite
```

These folders are git-ignored:
- `knowledge/`: the K0 extraction outputs
- `data/`: bar caches and `data/live/`
- `var/`: runtime state
- `logs/`
- `.env`

## Rules

- **Paper only.** Real-money trading needs the owner's own switch, after the proof gates in the plan. It is never
  automated from here.
- **Pre-registration.** Every strategy change needs a hypothesis, an experiment and a decision record in
  `research/`, each written before any P&L is viewed.
- **Changes land through pull requests** with a green `test` check, following the org rules (decision D-016).
- **The live checkout changes only through `make deploy`.** See [AGENTS.md](AGENTS.md).
