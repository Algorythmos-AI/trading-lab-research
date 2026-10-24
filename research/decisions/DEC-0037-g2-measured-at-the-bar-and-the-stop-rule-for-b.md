# DEC-0037: G2 is measured at the bar from the replay files, and strategy B stops itself by a rule written down today

- **Status: ACCEPTED on 2026-10-24.** The owner chose "keep trading, with a pre-registered stop rule" on
  2026-10-24, asked directly, from three options (keep trading with a stop rule; pause B now; keep trading as
  is). The merge of the pull request that carries this line accepts it.
- **Date drafted:** 2026-10-24, before the scorecard of 2026-10-30 exists. The figures quoted are the scorecard of
  2026-10-23 and the replay files of 2026-10-12 to 2026-10-23, read on the host that day; nothing else was viewed.
- **Amends:** DEC-0023 (what G2 counts) and DEC-0024 (clean sessions) in one respect: the agreement measure.
  DEC-0010 (round 3) and the frozen rules of strategy B (`research/active_strategies/B_intraday_momentum_qqqm.yaml`,
  v1) are unchanged; no entry or exit rule of B moves.
- **Trials:** none. No configuration was evaluated and no rule of B changes, so `config/trial_registry.yaml` gets
  no row. The thresholds below gate nothing about the strategy's content; they gate whether it keeps trading.
- **Sets:** `config/risk.yaml` `B.stop_rule` (the three triggers), `wt.risk.stop_rule` (how they are read),
  `wt.live.runner_b` (where they are asked, at arming), `wt.risk.virtual_account.reset_latch` (what clears the
  latch), and the agreement measure in `wt.analytics.g2` and `wt.analytics.b_replay`. Both parts are built in
  the pull request that carries this record.

## What the record says

The scorecard of 2026-10-23: 18 sessions armed, 14 clean, 4 trades closed, all losers, cumulative -2.94R,
E[R] -0.736, and "signal agreement with forward-test B: 4/14 = 29% (G2 needs >= 90%)". The agreement number
is day-level: a clean session "agrees" when paper B traded if and only if forward B traded. The two sides are
not the same experiment. The runner reads IEX minute bars and acts only when the signal is on the newest closed
bar; the forward test reads consolidated bars and accepts any mark; the runner is blocked by things the forward
test never sees (`kill_file`, `latched`, `max_1_trade_per_day`, an event blackout, `stale_signal_data`,
`spread_or_no_quote`) and by settled cash in a US$600 account on T+1. The number measures those differences
as much as the strategy.

The harness that measures the right thing already runs: `wt.analytics.b_replay` writes, after every forward
test, `var/forward/replay/<session>.json` with the forward test's reading, a replay of the frozen rule on the
recorded bars with the runner's own sigma and previous close, and the runner's journaled signal. Its docstring
says the gate's measure changes only by a decision record. This is that record. The files on the host for the
ten sessions 2026-10-12 to 2026-10-23 say:

| Comparison | same | neither | different | only one side |
|---|---|---|---|---|
| replay vs journal (recorded bars vs what the runner did) | 3 | 6 | 0 | 1 (journal only, 2026-10-23) |
| forward vs replay (sigma and feed) | 3 | 7 | 0 | 0 |

The runner has journaled what the replay needs (sigma, the previous close, a decision summary) since
2026-10-08; earlier sessions cannot be replayed and are not counted.

## Decision, part 1: the agreement measure

1. **Agreement is measured at the bar, from the replay files.** A clean session agrees when
   `replay_vs_journal` is `same` or `neither` (the frozen rule on the recorded bars and the runner reached the
   same signal, or neither signalled); it disagrees on `different`, `only_first` and `only_second`. Sessions
   whose reading is unknown (no replay file, or a runner that did not journal its inputs) are left out of the
   denominator and listed by count. Sessions blocked by `event:*`, `kill_file` or `latched` are listed as
   blocked and left out: the rule was not asked.
2. **`forward_vs_replay` is reported beside it, never pooled.** It measures the sigma and feed difference
   between the forward test and the runner's inputs: a diagnostic of the harness, not of the desk.
3. **The day-level number stays in the record as history** (4/14 on 2026-10-23) and leaves the scorecard once
   part 1 is built. Until then the scorecard prints both and labels the day-level one provisional.
4. **G2 is read in two parts.** G2a, "the desk runs the rule": at least 30 clean sessions, 20 incident-free in
   a row, and at least 90% bar-level agreement over the sessions that can be read. G2b, "the rule earns": the
   trades. The thresholds of DEC-0023 (50 trades, 30 sessions, 90%, 20 incident-free) are not changed; this
   says which of them the desk can close by running and which only the market can.
5. **What is built for it, in the same pull request:** `wt.analytics.b_replay.agreement` judges the replay
   files and `wt.analytics.g2.summary` carries the result (`agreement_level: bar`, the judged and unknown
   counts, the harness counts beside them); the publisher's allow list, the schema and the dashboard's types
   carry the new keys; the Research page's gate rail draws the agreement; the weekly scorecard prints it.

## Decision, part 2: the stop rule for strategy B

Nothing on record said when the paper desk stops. Four trades, all losers, is not evidence against B (at the
backtest's hit rate, four losses in a row happen about one time in eight) and the paper sessions are the only
source of G2a evidence, so B keeps trading. But the line is drawn today, in the configuration the runner reads,
not in prose:

| Trigger | Threshold | Where |
|---|---|---|
| `cum_r` | cumulative R over B's entry-origin closed trades with a real exit at or under **-6.0R** | `config/risk.yaml` `B.stop_rule.cum_r_max_loss` |
| `review` | at **30** closed trades or more, the bootstrap CI95 upper bound of E[R] below zero | `B.stop_rule.review_at_trades` |
| `date` | **2027-01-30**, whatever the count is | `B.stop_rule.stop_date` |

6. **The runner asks the rule at arming** (`wt.risk.stop_rule.evaluate`, from its own journal). When a trigger
   holds it latches the virtual account with a reason that begins "stop rule", journals `stop_rule`, pages once,
   and arms in exits-only mode: open positions are managed and flattened, no entry is placed.
7. **Only a new decision record clears that latch.** `make reset-latch` refuses a stop-rule latch unless the
   reason names a record other than this one (`DEC-NNNN`). That record changes `B.stop_rule` or retires B:
   a reset that leaves the thresholds as they are brings the latch back at the next arming, because the journal
   has not changed.
8. **A desk with no stop rule does not arm.** If `B.stop_rule` is missing from the configuration the runner
   refuses to arm for entries and says why.
9. **The thresholds are frozen.** -6.0R is wide for a four-trade record and narrow for a year: it is a loss
   the US$600 account can show without the daily, weekly or drawdown latches firing first. Thirty trades is
   where a confidence interval on E[R] begins to mean something. The date is the end of the first forward
   quarter. Changing any of the three is a new record.
10. **The scorecard prints where the rule stands** every week: cumulative R against the line, trades against the
    review, the stop date, and whether a trigger has fired.

## What is not decided here

DEC-0011 (the audit corrections, proposed 2026-09-29) stays proposed; the owner accepts or withdraws it in its
own line. The virtual account's settled-cash constraint (US$8.93 settled of US$600 on 2026-10-23) is named here
as a known blocker of entries; whether to re-size the account is its own record with its own experiment id.
