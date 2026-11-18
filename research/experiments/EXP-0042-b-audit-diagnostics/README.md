# EXP-0042: Robot B audit diagnostics

- Decision: DEC-0061 (proposed with the first results). Descriptive: no hypothesis, no trial, no family.
- Frozen: `config.yaml`, committed before `scripts/b_audit.py` first ran. A changed value is a new experiment.
- Evidence label: **pre-correction.** Every input predates the DEC-0011 R-C1 re-runs, none of which has been run.
  Nothing here is evidence for or against B's edge on corrected data; it describes the record as it stands and sizes
  what the owed re-runs and the paper record can and cannot show.
- Reads committed files only, no market data and no network. No paper or forward per-trade R is read; the paper
  record enters only as the aggregate already published in the 2026-11-13 scorecard.

## Questions

1. Do the recorded figures (+0.117R over 415 walk-forward trades, DSR 0.707 at 65 trials, holdout 57 trades
   +0.091R) reproduce from the committed results, and what exactly do they measure?
2. What does the frozen rule's development record look like as a whole distribution: concentration, drawdown, losing
   runs, years, entry marks, exits?
3. How much of it can the runner actually trade (the 15:30 mark)?
4. What do the DSR at today's trial count and the probability of backtest overfitting (CSCV over the development
   configurations) say?
5. How many trades would it take for the paper record to tell B's claimed edge from zero, and how long is that at
   the paper desk's trade rate? What can G2b's 50 trades detect?
6. What would a sequential (SPRT) kill test on paper R look like, next to the -6.0R stop line?

## Dates

- Registered: 2026-11-18
- First run: 2026-11-18, after the registering commit 9d5f393; results committed with the driver amendment noted in report.md
