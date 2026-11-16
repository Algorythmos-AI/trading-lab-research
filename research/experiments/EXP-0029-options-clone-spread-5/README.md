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

## Fidelity fix: only finished 2-minute bars (appended 2026-11-17, before the change runs)

- **Defect.** The live runner built each 2-minute bar from the 1-minute bars it had at the poll and judged it as soon
  as the clock passed its end, even when the bar's second minute had not reached it yet. The bar was then marked as
  looked at and never judged again. DEC-0030 says the clone acts on finished bars only, and the dry run (EXP-0025)
  only ever saw finished bars, so this was a gap between the record and the runner, not a rule.
- **Change (code only).** `wt.options.regime.resample` takes an optional grace. The live control passes
  `runner_o.LAST_MINUTE_GRACE` (15 s): a bar whose second minute has not arrived waits for it, up to 15 s past its
  end. A minute the feed never sends (IEX leaves out a minute with no trade there) still ends its bar, 15 s later. A
  bar whose close changes after it was judged is journaled as `bar_revised`. `config/options_clone.yaml` is
  unchanged, so `control_config_hash` and this experiment's frozen numbers are unchanged. The dry run and the
  research arms' leader tape keep the old call.
- **Expected effect.** Small, and only in timing. A read-only probe on 2026-11-16 (4 names, 5 minutes, IEX) found
  every minute available 1 s after it ended and none revised later. The runner polls every 10 s on a free-running
  clock, so a poll can land 0-10 s after a bar ends. When it lands inside the feed's delay (roughly 1 bar in 10 at
  that delay), the bar is now judged one poll later on its real close instead of at once on its first minute's close.
  The exits that read the bars (a close through the invalidation, the next level, the research arms' shadow exits)
  follow the same rule, so in that window they act on the last finished bar. No gate, threshold, window, sizing or
  exit rule changes. Entries keep their time-to-fill measured from the bar's end, so a bar judged later has up to one
  poll (plus the 15 s grace, if its minute is late) less time to fill.
- **Not covered.** The research arms' leader tape (SMH for QQQ) still reads its bar without the grace. `bar_revised`
  only compares the close of the last bar judged, inside the entry window, so a count of zero means "none seen", not
  "none happened".
- **Disclosure.** While diagnosing, the author read the journal and decision lines of this experiment's sessions
  2026-11-05 to 2026-11-16. Nothing in this fix was chosen from them, and no gate, threshold, window or exit rule changes.
  Trades from the release that carries this fix onward count as before. Whether that release has a `bar_revised`
  line is checked and stated in the report.
