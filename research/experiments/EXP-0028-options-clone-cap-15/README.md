# EXP-0028: the options clone under the $15.00 contract cap, forward on paper

- Decision: DEC-0039. Trials: HYP-0029 (`retest`), HYP-0030 (`rejection`) and HYP-0031 (`nearest`), each run again
  under the new cap as a new trial, family O.
- **Design only.** Nothing here is a result, and no trade under the new cap existed when this was written. The report
  is written once, by `scripts/options_clone_verdict.py --rules cap15 --trials retest,rejection,nearest --out
  research/experiments/EXP-0028-options-clone-cap-15`, when a trial reaches 30 trades and 20 sessions. The script
  refuses to write over an existing report.
- Start: **2026-10-30**, the first session under the new cap (`wt.options.review.CAP15_START`). Only trades whose
  session is on or after that date count. Trades up to 2026-10-29 stay in EXP-0024 and EXP-0026.
- Run: job `paper-o` on the host, with `config/options_clone.yaml` and `config/risk.yaml` key `O` as frozen by
  DEC-0039: the contract nearest the money with an ask up to $15.00, premium at most $1,500, the 25% premium stop, latches $750 a day, $2,250 a week and
  $3,750 from the high-water mark. Every other rule is the frozen rule of DEC-0030 and DEC-0034.
- Trades: every `trade_closed` row on or after the start, split by `wt.options.review.trial_of` as before.
- Ledger: `data/live/options_journal.jsonl` on the host, the same append-only, hash-chained journal.
- Unit: return on premium from fills, after $0.03 a contract each way.
- Verdict: the same test as DEC-0030 section 6. With at least 30 trades and 20 sessions, a trial is falsified if the
  lower end of the bootstrap range of the mean, resampled by session, is at or below 0, or the mean is at or below 0
  in either half of the trades in order. Fewer is no verdict.
- Left out of the verdict and counted: trades booked `unresolved`.
- A number changed after a result is seen means a new experiment and new trials.
