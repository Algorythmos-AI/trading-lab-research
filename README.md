# Trading Lab Research

The research and paper-trading engine behind Trading Lab. It holds:
- the `wt` package: data, scanner, signals, backtest, risk, OMS and a paper runner
- the research registry of hypotheses, experiments, decisions, strategies and lessons
- the specifications that the strategies are tested against

|                 |                                                                                                                              |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Status**      | Active research · G1 closed with one candidate (strategy B) · paper dress rehearsal only · no live trading                   |
| **Owner**       | [@Algorythmos-AI/maintainers](https://github.com/orgs/Algorythmos-AI/teams/maintainers)                                      |
| **Runs at**     | Locally on the maintainer's machine (launchd) against an Alpaca **paper** account. No deployed service.                     |
| **Run locally** | `uv venv --python 3.12 && uv pip install -r requirements.lock.txt`, then `PYTHONPATH=src .venv/bin/python -m pytest -q`         |
| **Context**     | [Research registry](research/README.md) · [G1 summary](research/G1_SUMMARY.md) · [Notice](NOTICE.md) · [Licence](LICENSE)   |

---

> **Not financial advice.** This is a research tool that trades simulated (paper) money only.
> Paper-only access is hard-coded in the broker adapter.

> **Restricted.** This repository contains material derived from third-party courses. See
> [NOTICE.md](NOTICE.md). Keep it private.

## Layout

```
src/wt/          data · scanner · signals · backtest · risk · oms · brokers · live · knowledge
scripts/         research drivers (g1_run, g1_eval, forward_test, weekly_scorecard, …)
research/        hypotheses/ experiments/ decisions/ active_strategies/ lessons_learned/ specs/ forward/
config/          ranking and catalyst configs, macro-event calendar
deploy/          launchd agents for the nightly paper and forward-test jobs
watchlist/       point-in-time 09:25 ET scanner outputs
tests/unit/      pytest suite
```

These folders are git-ignored:
- `knowledge/`: the K0 extraction outputs
- `data/`: bar caches
- `logs/`
- `.env`

## Rules

- **Paper only.** Real-money trading requires the owner's own switch after the proof gates in the plan. It is never automated from here.
- **Pre-registration.** Every strategy change needs a hypothesis, an experiment and a decision record in `research/`, each written before any P&L is viewed.
- **Commits.** Changes land through pull requests, following the org rules (no AI attribution, decision D-016).
