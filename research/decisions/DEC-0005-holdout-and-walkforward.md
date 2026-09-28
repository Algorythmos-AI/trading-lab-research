# DEC-0005 — Holdout and walk-forward schedule (pre-registered before any strategy P&L is viewed)

- **Date:** 2026-09-27
- **Data span:** 2019-01-02 → 2026-09-25 (watchlists built 09:25 ET point-in-time).
- **HOLDOUT (untouched, run exactly once per frozen config):** 2025-09-26 → 2026-09-25.
  No strategy trade/P&L on these dates may be computed or viewed before the G1 holdout run.
  (EXP-0002/0003 on 2026-07-31→2026-09-25 used scanner outputs + next-day price ranges only to tune
  scanner recall; no strategy/management rule was evaluated there.)
- **Development / walk-forward span:** 2019-01-02 → 2025-09-25.
  - Walk-forward: fit (parameter-variant selection among pre-registered variants) on a rolling 12 months,
    test on the next 3 months, roll by 3 months → ~23 out-of-sample folds 2020-01 → 2025-09.
  - Plumbing/debug runs use 2019 only and are excluded from reported statistics.
- **Trial accounting:** every strategy×management×window×variant configuration evaluated on any
  development data counts toward the DSR trial count (global registry = research/experiments/).
