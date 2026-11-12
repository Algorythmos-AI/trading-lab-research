# EXP-0032: whether the two-stage selection picks better names, forward from the switch

- Decision: DEC-0047 (proposed). Trials: HYP-0051 to HYP-0055, family F (new, total 5).
- **Design only.** Nothing here is a result. No session of the two-stage selection has been picked, scored or read
  when this was written; no ledger outcome, scorecard, report or backtest was used to write it (DEC-0047's opening
  lines say exactly what the author opened and stopped reading).
- Every frozen value is in `config.yaml`: the sessions counted, the unit, the outcome (the ledger's rule at
  focus-card-ledger commit `8130c7c460ffa08cb2d54af49d1c05ab89c215b3`, copied in DEC-0047 section 3), the bars, the
  groups, the statistics, the generator, the seeds, the minimums, the Holm step and the read.
- Start: the first regular session on which the edition's focus names are the Stage 1 picks under DEC-0048's switch,
  once the ledger change (DEC-0047 section 10, precondition 1) is merged. Never backfilled.
- Read: once, at the 120th counted session or the end of the session of 2027-09-30, whichever comes first. Fewer than
  60 counted sessions then: every trial inconclusive.

## Trials

Every difference is a minus b.

| Trial | Hypothesis | Unit of the statistic | Compared (a minus b) | Decided by |
|---|---|---|---|---|
| SEL-PICKED | HYP-0051 | session | picked minus the rest | 95% session bootstrap above 0, both halves above 0 |
| SEL-RANDOM | HYP-0052 | session | picked minus 1,000 random draws of as many eligible names | Holm p ≤ 0.025, both halves |
| SEL-FIXED | HYP-0053 | session | picked minus SPY, QQQ and the two highest ATR% eligible names | Holm p ≤ 0.025, both halves |
| SEL-RANK | HYP-0054 | session | mean of minus Spearman's rho of final rank and R | Holm p ≤ 0.025, both halves |
| SEL-PASSB | HYP-0055 | names, pooled | Pass B `confirmed` minus `no_longer_qualifies` | Holm p ≤ 0.025, both halves |

## Dates (each written by the pull request or note that records it)

- Ledger change merged (precondition 1): not yet.
- Blind tests in place (`tests/test_blind_until_read.py` in the ledger, `tests/unit/test_select_gate.py` here): not
  yet.
- Stage 2 thresholds frozen by the amendment to DEC-0046 (before it, Pass B is `unclassified` for HYP-0055): not yet.
- Switch session (DEC-0048, precondition 2): not yet.
- `params_sha` in force at the first counted session: not yet (DEC-0046's is
  `08617613bced71e4c7b7b022ca1cc34070d885d5eae17c438f39e80284e88e23`).
- Early end or breach: none.

## Results

Not read. The read is made once, by the verdict script added with the code, which writes its report into this folder
and refuses to write over an existing one.
