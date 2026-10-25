# EXP-0027: the two re-specified bull flags, forward only

- Decision: DEC-0011 (accepted 2026-10-25), item 5 and finding H-LA. Hypotheses: HYP-0032
  (`watchlist_bull_flag_atr_M1_v2`) and HYP-0033 (`hod_bull_flag_atr_M1_v2`). Two trials, counted in the global 87.
- **Design only.** Nothing here is a result, and no trade of either strategy existed when this was written.
- **Run:** the nightly forward test (`scripts/forward_test.py`, job `forward`, 12:40 New York after the close) on
  delayed consolidated data, the same code path as every forward trial. No order is placed: the trades are
  hypothetical rows in the forward ledger.
- **Start:** the session `V2_FROM` names. It is set in a pull request merged after this record is merged and
  deployed, to a session not yet run, so that no row is written before the record existed and the catch-up never
  backfills (the forward test processes only sessions on or after `V2_FROM`).
- **Rules:** frozen in `scripts/forward_test.py` (`run_watchlist_flag`, `run_hod_flag`) and the modules they call,
  at the commit that sets `V2_FROM`. They are the v1 rules of EXP-0013 and EXP-0014 with the two look-ahead
  inputs replaced: the watchlist prefilters on the 09:25 pre-market gap, and the HOD flag qualifies on cumulative
  volume of at least 1,000,000 shares by the qualifying bar. Prior closes and ADV20 are split-adjusted.
- **Ledger:** `var/forward/forward_trades.jsonl` on the host, keys `watchlist_bull_flag_atr_M1_v2` and
  `hod_bull_flag_atr_M1_v2`. The v1 rows stay in the ledger, tagged biased, and are never pooled with these.
- **Unit:** R per trade after the default costs (`Costs()`), as the forward test writes it.
- **Ranges:** percentile bootstrap of the mean R, by session (the verdict) and by trade, as
  `wt.backtest.stats.bootstrap_ci` computes it, and both halves in order.
- **Verdict:** each hypothesis's `falsified_if`, read once a trial has 30 trades and 20 sessions, or on 2027-04-30
  with no verdict if it has fewer. The report goes in this folder and is written once.
- **No baseline:** neither trial has a frozen backtest of its v2 rules, so the weekly scorecard shows "no
  baseline" for both, by design. A pass earns a registered development-span backtest under a new experiment.
- A number changed after a result is seen means a new experiment and new trials.
