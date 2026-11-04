# EXP-0029: the options clone under the $5.00 spread cap, forward on paper

- Decision: DEC-0040. Trials: HYP-0029 (`retest`), HYP-0030 (`rejection`) and HYP-0031 (`nearest`), each run again
  under the new spread cap as a new trial, family O.
- **Design only.** Nothing here is a result, and no trade under the new cap existed when this was written. The report
  is written once, by `scripts/options_clone_verdict.py --rules spread5 --trials retest,rejection,nearest --out
  research/experiments/EXP-0029-options-clone-spread-5`, when a trial reaches 30 trades and 20 sessions. The script
  refuses to write over an existing report.
- Start: **2026-11-05** (`wt.options.review.SPREAD5_START`). Trades up to 2026-11-04 stay in EXP-0028 and earlier.
- Run: job `paper-o` on the host, with `config/options_clone.yaml` and `config/risk.yaml` key `O` as frozen by
  DEC-0039 and DEC-0040: the contract nearest the money with an ask up to $15.00 and a spread of at most 8% of mid
  (the $5.00 absolute cap never binds first). Every other rule is unchanged.
- Trades, ledger, unit, verdict and exclusions: as EXP-0028.
- A number changed after a result is seen means a new experiment and new trials.
