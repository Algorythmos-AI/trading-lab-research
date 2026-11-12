# EXP-0032: whether the two-stage selection picks better names, forward from the switch

- Decision: DEC-0047 (accepted 2026-11-12). Trials: HYP-0051 to HYP-0055, family F (new, total 5).
- **Design only.** Nothing here is a result. No session of the two-stage selection has been picked, scored or read
  when this was written, and no ledger outcome, scorecard, report or backtest was used to write it.
- **Disclosure.** The first author of DEC-0047 opened three ledger files that hold results of the previous picker
  (DEC-0047's opening lines list exactly what was seen). On 2026-11-12, after a blind review, an editor who had seen
  no result revised this experiment, its hypotheses and DEC-0047. "What the plan left open" in DEC-0047 lists every
  choice and who made it.
- Every frozen value is in `config.yaml`: the sessions counted, the unit, the outcome (the ledger's rule at
  focus-card-ledger commit `8130c7c460ffa08cb2d54af49d1c05ab89c215b3`, copied in DEC-0047 section 3), the bars, the
  groups, the statistics, the generator and its test vectors, the seeds, the minimums, the Holm step and the read.
- Start: the first regular session on which the edition's focus names are the Stage 1 picks under DEC-0048's switch
  (precondition 4), once preconditions 1 to 3 (DEC-0047 section 10) are met. Never backfilled.
- Read: once, at the 120th counted session or the end of the session of 2027-09-30, whichever comes first. If fewer
  than 60 sessions are counted by then, every trial is inconclusive. The coordinator session runs the read on the
  console Mac, from an up-to-date `origin/main` worktree, with the analysis code at the commit recorded below.
- Early ends and breaches give no verdict. Each counts as inconclusive for DEC-0047 section 9, so the scoring is then
  replaced by the fixed rule.

## Trials

Every difference is a minus b. R is per triggered side: an entered name's card-policy R, 0 for a triggered name
without an entry.

| Trial | Hypothesis | Unit of the statistic | Compared (a minus b) | Decided by |
|---|---|---|---|---|
| SEL-PICKED | HYP-0051 | session | picked minus the eligible names not picked | 95% session bootstrap above 0, both halves above 0 |
| SEL-RANDOM | HYP-0052 | session | picked minus 1,000 random draws of as many eligible names | Holm (of three) p ≤ 0.025, both halves |
| SEL-FIXED | HYP-0053 | session | picked minus SPY, QQQ and the two highest ATR% eligible names | p ≤ 0.025 unadjusted (co-primary for the pre-set action), both halves |
| SEL-RANK | HYP-0054 | session | mean of minus Spearman's rho of final rank and R, eligible names | Holm (of three) p ≤ 0.025, both halves |
| SEL-PASSB | HYP-0055 | names, pooled | Pass B `confirmed` minus `no_longer_qualifies`, eligible names | Holm (of three) p ≤ 0.025, both halves |

## Dates (each written by the pull request or note that records it)

- Ledger change merged (precondition 1): not yet.
- Card fields of every data-valid name in Stage 1's output (precondition 2): not yet (waits on the card-field code,
  DEC-0046 section 6, which waits on a file the owner has not yet supplied).
- Analysis code frozen (precondition 3), its commit: not yet.
- Blind tests in place (`tests/test_blind_until_read.py` in the ledger, `dashboard/test/ledger-blind.test.ts` here):
  not yet.
- Stage 2 thresholds frozen by the amendment to DEC-0046 (before it, Pass B is `unclassified` for HYP-0055): not yet.
- Switch session (DEC-0048, precondition 4): not yet.
- `params_sha` in force at the first counted session: not yet (DEC-0046's is
  `08617613bced71e4c7b7b022ca1cc34070d885d5eae17c438f39e80284e88e23`).
- Switch reverts (each by a dated note before 09:30 New York): none.
- Early end or breach: none.

## Results

Not read. The frozen verdict script (precondition 3) makes the read once, writes its report into this folder and
refuses to write over an existing one.
