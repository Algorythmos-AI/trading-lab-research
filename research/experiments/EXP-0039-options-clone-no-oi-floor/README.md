# EXP-0039: the options clone without the open-interest floor, forward on paper

- Decision: DEC-0056. Trials: HYP-0029 (`retest`), HYP-0030 (`rejection`) and HYP-0031 (`nearest`), each run again
  under the new rule as a new trial, family O (41 -> 44).
- **Design only.** Nothing here is a result, and no trade under the new rule existed when this was written. The
  report is written once, by `scripts/options_clone_verdict.py --rules no_oi --trials retest,rejection,nearest --out
  research/experiments/EXP-0039-options-clone-no-oi-floor`, when a trial reaches 30 trades and 20 sessions. The
  script refuses to write over an existing report. Until then the nightly review shows trade and session counts
  only.
- Start: **2026-11-18** (`wt.options.review.NO_OI_START`). Trades up to 2026-11-17 stay in EXP-0029 and earlier.
- Run: job `paper-o` on the host, with `config/options_clone.yaml` and `config/risk.yaml` key `O` as frozen by
  DEC-0039, DEC-0040 and DEC-0056: the contract nearest the money with an ask up to $15.00, a spread of at most 8% of
  mid, the delta floors and the volume floors (500; 5000 for SPY and QQQ), and no open-interest floor. Every other
  rule is unchanged.
- Trades, ledger, unit, verdict and exclusions: as EXP-0028.
- A number changed after a result is seen means a new experiment and new trials.

## Closed by DEC-0058 (appended 2026-11-17, before its first session)

- The last session is **2026-11-18** (`wt.options.review.NO_OI_END`). That is one session.
- From 2026-11-19 the clone trades QQQ every session beside the focus names, and its trades count toward EXP-0040.
- This experiment cannot reach 20 sessions, so it gives no verdict. It is kept as a record, as EXP-0029 was.

## Amended by DEC-0058 (appended 2026-11-18, before any trade of that session was viewed)

- **No session ran under this experiment.** DEC-0056's rule and DEC-0058's reached the host before the same session,
  2026-11-18, which counts toward EXP-0040. `wt.options.review.NO_OI_END` is now 2026-11-17, before `NO_OI_START`.
- It gives no verdict and holds no trade. It is kept as a record.
