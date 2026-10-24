# EXP-0015-r3-dev: round 3's fixed-rule out-of-sample run, registered and not run

- Decision: DEC-0010 (in effect from 2026-09-29). Hypotheses: HYP-0010 to HYP-0019, the ten round-3 trials
  (Set F GG-1 to GG-4, Set P GG-1 to GG-4, MP-1, REV-1). Specification SPEC-0001 v1.0.1.
- **Status: registered, not run.** DEC-0010 names this folder as the home of the dev-span evaluation
  (`scripts/r3_run.py`, then `scripts/r3_eval.py EXP-0015-r3-dev`, fixed-rule OOS 2020-01-01 to 2025-09-25).
  As of 2026-10-24 neither script has been run against that span: there is no `result.json` here, on the host
  or in any branch, and the status page's round-3 "run" flag has been reading the folder's absence. This file
  exists so that the registry has a record where the decision points, and so that nobody mistakes a forward
  count for the registered run. The holdout (2025-09-26 to 2026-09-25) is untouched and runs once, only for a
  trial whose dev CI95 lower bound is above zero (DEC-0005, DEC-0010).
- **What has run instead:** the nightly forward test (`scripts/forward_test.py`) has evaluated the ten trials
  on each session since the approval date and logs their trades in the forward ledger. The weekly scorecard of
  2026-10-23 reports, over the forward sessions to date: nine trials with 0 trades ("waiting for trades"),
  and REV-1 with 3 trades (forward record only; no baseline, by design: the dev run that would give one has
  not happened). Forward counts are not the registered test and settle nothing in DEC-0010.
- **What closes this record:** a run of the two scripts on the registered span, writing `result.json` and
  `report.md` here, counts-first (`--counts-only`) as DEC-0010 asks, with the trial-count guard (60 dev trades
  for Set P) applied as written. Anything else is a new decision record.
