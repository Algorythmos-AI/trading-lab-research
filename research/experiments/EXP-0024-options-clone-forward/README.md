# EXP-0024: the options clone, forward on paper

- Decision: DEC-0030. Hypotheses: HYP-0029 (break and retest), HYP-0030 (rejection), family O.
- **Design only.** Nothing here is a result. The report is written once, by `scripts/options_clone_verdict.py`,
  when a setup reaches 30 trades and 20 sessions, and the script refuses to write over it.
- Run: job `paper-o` on the host, every session from its first, `config/options_clone.yaml` and `config/risk.yaml`
  key `O` as frozen by DEC-0030.
- Ledger: `data/live/options_journal.jsonl` on the host, append-only and hash-chained (kept out of git). Every
  decision on every 2-minute bar, every gate, every order, every fill, every exit, quote ages and slippage.
- Unit: return on premium from fills, after $0.03 a contract each way.
- Ranges: percentile bootstrap of the mean, by session (the verdict) and by trade, as
  `wt.backtest.stats.bootstrap_ci` computes it; both halves in order.
- Left out of the verdict and counted: trades booked `unresolved` (a lot taken by a hand trade in a shared account).
- A changed number after a result is seen is a new experiment and new trials.
