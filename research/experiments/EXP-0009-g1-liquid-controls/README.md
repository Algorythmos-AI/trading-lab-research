# EXP-0009: random-entry controls for EXP-0007-g1-liquid-dev (reserved, never run)

- **Status:** never run. No results exist, and none will be produced under this id.
- **What it was for:** the G1 gate's random-entry control for the liquid large-cap families in `EXP-0007-g1-liquid-dev`. A family passes G1
  only if it also beats random entries at p < 0.05.
- **Why it was not run:** every family in `EXP-0007-g1-liquid-dev` failed G1 on expectancy before a control could matter (DEC-0007).
  A control can only fail a family that has passed the other tests, so running it would have spent compute and
  decided nothing.
- **Where this shows:** `scripts/g1_report_all.py` names this id and skips it because it has no `results.json`. The
  combined report (`research/experiments/G1-combined-report.md`) prints `random-control p = None` for these families.
- **Trials:** none counted. The global trial count (DEC-0009) does not include it.
