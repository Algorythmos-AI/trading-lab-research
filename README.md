# Trading Lab Research

The research and paper-trading engine behind Trading Lab. It holds:
- the `wt` package: data, scanner, signals, backtest, risk, OMS and a paper runner
- the research registry of hypotheses, experiments, decisions, strategies and lessons
- the specifications that the strategies are tested against
- the status dashboard (`dashboard/`) and the jobs that feed it

|                 |                                                                                                                                  |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **Status**      | Active research · G1 closed with one candidate (strategy B, under re-evaluation per DEC-0011) · paper only · no live trading      |
| **Owner**       | [@Algorythmos-AI/maintainers](https://github.com/orgs/Algorythmos-AI/teams/maintainers)                                          |
| **Runs at**     | One Google Cloud VM, `trading-lab-host` (systemd timers), against an Alpaca **paper** account. The Mac runs nothing              |
| **Dashboard**   | [lab.algorythmos.com](https://lab.algorythmos.com) (Vercel login required)                                                        |
| **Run locally** | `make bootstrap && make ci`                                                                                                      |
| **Context**     | [Research registry](research/README.md) · [G1 summary](research/G1_SUMMARY.md) · [ADRs](docs/adr/) · [Runbooks](docs/runbooks/) · [Security](SECURITY.md) · [Notice](NOTICE.md) · [Licence](LICENSE) |

---

> **Not financial advice.** This is a research tool that trades simulated (paper) money only. A paper-only lock
> (`wt.core.safety`) refuses to send any order that could reach a live account.

> **Restricted.** This repository contains material derived from third-party courses. See [NOTICE.md](NOTICE.md).
> Keep it private. The dashboard publishes a sanitized snapshot only.

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
systemd timers on the VM (/home/wt/trading at a deployed main commit; runtime state in var/)
 ├─ wt-routine    07:30 New York: SPEC-0001 pre-market dry run (stages 08:00 to 09:15, signals check 11:31)
 ├─ wt-paper-b    08:30 New York: strategy B paper session (OMS + pre-trade guard)
 ├─ wt-forward    12:40 New York → waits until close + 20 min: forward test of the frozen candidates
 ├─ wt-weekly     Friday 20:00 New York: weekly scorecard
 └─ wt-dashboard  every 5 min in the US session, every 15 otherwise → collect → sanitize → sign → POST
                                     │
Vercel (trading-lab-dashboard) ◄─────┘  private Blob storage; pages; a watchdog cron that alerts
                                         if the host goes quiet during a trading window
```

- Every job runs through `wt.ops.jobs`. That gives it a lock, preflight checks, deadlines, alerts and a heartbeat.
- Session times follow New York, so daylight-saving changes need no edits.
- See [ADR 0001](docs/adr/0001-vercel-dashboard.md) and [ADR 0002](docs/adr/0002-runtime-state-and-deploy-gate.md).

## Everyday commands

| Command | What it does |
|---|---|
| `make status` | What's going on right now |
| `make gate` | Is it safe to change the live checkout? (no job running, outside the trading night) |
| `make deploy` | Gate, tag, pull `main`, migrate state, sync the venv, smoke test. Rolls back by itself on failure |
| `make rollback TAG=runtime-YYYYMMDD-N` | Back to an earlier deploy |
| `make kill REASON="…"` / `make unkill` | Stop or allow new paper-B entries. Exits keep being managed. `unkill` is refused while paper B is running |
| `make reset-latch REASON="…"` | Clear the virtual account's loss latch. Owner only; refused while paper B is running; the reset is recorded |
| `make install-trading-agents` | (Re)install the launchd jobs on a Mac. Not used on the VM, whose units the owner installs with `sudo wt-install-units` |
| `make publish DRY_RUN=1` | Build the dashboard snapshot without sending it |
| `make ci` | Lint, type-check and test, as CI does |

## Layout

```
src/wt/          data · scanner · signals · backtest · risk · oms · brokers · live · ops · knowledge · specs
scripts/         research drivers and nightly jobs
research/        hypotheses/ experiments/ decisions/ active_strategies/ lessons_learned/ specs/ forward/
config/          ranking, catalyst and risk limits, macro-event calendar, dashboard config
dashboard/       the Vercel dashboard (Next.js)
deploy/          host helpers, units and first-boot files (gcp/, oci/), and the jobs' entry scripts
docs/            ADRs and runbooks
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
