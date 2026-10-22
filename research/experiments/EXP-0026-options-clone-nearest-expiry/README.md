# EXP-0026: the options clone on the nearest expiry, forward on paper

- Decision: DEC-0034. Hypothesis: HYP-0031 (`OC-NEAREST`), family O.
- **Design only.** Nothing here is a result, and no trade of HYP-0031 existed when this was written. The report is
  written once, by `scripts/options_clone_verdict.py --trials nearest --out
  research/experiments/EXP-0026-options-clone-nearest-expiry`, when the trial reaches 30 trades and 20 sessions.
  The script refuses to write over an existing report.
- Run: job `paper-o` on the host, the same run as EXP-0024, with `config/options_clone.yaml` (`names.expiry:
  nearest`) and `config/risk.yaml` key `O`. It starts at the first session that runs a release containing DEC-0034.
- Trades: every `trade_closed` row whose contract expires after its own session (`wt.options.review.trial_of`).
  Both setups are pooled. Same-day trades stay in EXP-0024, and no trade counts in both.
- Ledger: `data/live/options_journal.jsonl` on the host, the same append-only, hash-chained journal as EXP-0024.
  The `names` event records each name's expiry and the policy.
- Unit: return on premium from fills, after $0.03 a contract each way.
- Ranges: percentile bootstrap of the mean, by session (the verdict) and by trade, as
  `wt.backtest.stats.bootstrap_ci` computes it, and both halves in order.
- Left out of the verdict and counted: trades booked `unresolved`.
- A number changed after a result is seen means a new experiment and new trials.
