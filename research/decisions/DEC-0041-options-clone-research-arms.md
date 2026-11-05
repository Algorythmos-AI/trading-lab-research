# DEC-0041: Fourteen research arms on the options clone, tagged or virtual, the control unchanged

- **Status: ACCEPTED on 2026-11-05.** The owner approved the plan on 2026-11-05 to test, in the lab's own clone, the
  rules distilled from a twelve-month study of one public options and futures day trader's posts (the study record:
  `research/external/desi-trade/`, its own pull request). The merge of the pull request that carries this line
  accepts it.
- **Written before any affected P&L is viewed.** No arm below exists in code yet: no trade has been tagged and no
  virtual trade has been booked. The author did not read the clone's journal, trades or results for EXP-0029 (or any
  earlier window) while writing this record, and no backtest or replay of any arm was run.
- **Amends nothing.** DEC-0030, DEC-0034, DEC-0039 and DEC-0040 stand as written. EXP-0029's control (HYP-0029,
  HYP-0030, HYP-0031 under `config/options_clone.yaml` as frozen by DEC-0040) places exactly the orders it would
  place without this record.
- **Depends on:** DEC-0005 (every configuration tried counts as a trial), DEC-0028 (family O), DEC-0030, DEC-0034,
  DEC-0040.
- **Experiment:** EXP-0030. **Hypotheses:** HYP-0034 to HYP-0047.

## Why

The study found rules a trader who has survived a year of posted wins and losses uses on the same kind of trade the
clone makes: a reaction at a level marked before the open, in the first hour or so. Several of them are cheap to test
in the clone: where an entry stands in the day's range, gaps, a leading sector, the price of the option, the time of
day, how a winner is managed, and two triggers the clone does not take. His results are self-reported. Nothing is
adopted on his word: each rule is a hypothesis with a frozen test, and the clone's own fills decide.

A review of the clone found the rules cannot run as parallel live arms in the same runner. It holds at most one open
position (`max_open_positions: 1`), and its latches and loss pauses are shared, so a second set of orders would
change the control's own trades. Hence two kinds of arm, neither of which can change what the control does.

## Decision

1. **Tag arms (no orders).** Each is a frozen flag written into the runner's per-session decision log beside the
   gates, on the control's own decisions. A trial compares the control's trades with the flag against those without
   it. Ten trials, one per arm per base setup (retest, rejection):
   - **H-NTZ** (HYP-0034, HYP-0035): the entry in the middle third of the prior-day or five-day range with no marked
     level broken this session. `Tape.word` is logged beside it and reported only.
   - **H-GAP** (HYP-0036, HYP-0037): a call into an unfilled gap up or a put into an unfilled gap down, the gap as
     `levels.state` draws GAP ABOVE and GAP BELOW (the open beyond PDH or PDL; filled when a bar trades back to it).
   - **H-LEADER** (HYP-0038, HYP-0039): QQQ trades with SMH on the wrong side of its VWAP, the mirror of the SPY half
     of the trend gate.
   - **H-IVGATE** (HYP-0040, HYP-0041): the contract's `chain.Quote.iv` above **0.35** for SPY and QQQ or **0.70** for
     single names. The earnings blackout (`session.event_block`) already exists and is not part of the test.
   - **H-EARLY** (HYP-0042, HYP-0043): entries from 10:00 to before 11:00 against those from 11:00 to 14:30.
2. **Shadow arms (virtual only, never orders).** A new evaluator, `wt.options.shadow`, reads the runner's own tape,
   quotes and fills after each bar and books virtual trades in its own file. It imports no order path. Four trials:
   - **H-RUNNER** (HYP-0044, HYP-0045): a virtual second contract on each real fill of the control, same contract and
     price. Breakeven after +25%, then a trail on `Tape.ema_fast` (the 9-period EMA of 2-minute closes), the next
     level, or 15:10; no 50% target and no 5-minute time stop. Tested as a paired difference against the real
     contract, so there is no sizing or selection confound.
   - **H-TRAP** (HYP-0046): a failed break at a strong level (a 2-minute close across it, then a close back within
     three bars), traded back inside.
   - **H-RECLAIM-FAST** (HYP-0047): a sweep beyond a strong level by at least 0.25 ATR that closes back inside on the
     same bar, entered on that bar without the confirming bar of OC-REJECT.
   Both new triggers use OC-REJECT's levels, gates, contract choice and exits; a virtual fill needs the quoted ask to
   be inside the clone's own entry limit.
3. **Every number is frozen in the hypothesis records** (`frozen:` and `statement:`). Changing one is a new record
   and new trials.
4. **Trials.** Fourteen new trials; family O goes from 21 to **35** (`config/trial_registry.yaml`). Each trial is
   tested alone with the test of DEC-0030 section 6, resampled by session: 30 trades (per group, for a tag arm) and
   20 sessions. A tag arm is tested on the difference in means; H-RUNNER on the paired difference; H-TRAP and
   H-RECLAIM-FAST on their own mean.
5. **Window.** Each arm counts only sessions run by a release that writes its tags or its virtual trades, from the
   first such session, never backfilled from earlier logs. The code comes in a later pull request, after this record
   is merged, with `research_arms:` in `config/options_clone.yaml` off by default and none of the frozen keys changed;
   a test there proves the control's decisions are identical with the arms on and off. An arm stops, with whatever
   it has, if EXP-0029's config changes.
6. **Close without a verdict on 2027-11-05.** The clone takes about one trade every two sessions and the subsets are
   smaller still, so some trials will not reach their count; on that date each such trial closes with no verdict.
   OC-NTZ-RETEST is likely to be one: a retest needs a level break, and the zone excludes a broken level. It is
   registered anyway, so the count stays honest.
7. **The report** of each trial is written once, by a verdict script the code pull request adds, when the trial
   reaches its count or its close date. No split of the control's trades by tag, and no shadow result, is read before
   then.
8. **A pass changes nothing by itself.** A tag arm that passes earns a record proposing a gate, with new trials. A
   shadow arm that passes earns a record proposing that the clone trade it, which, because of the shared position and
   latches, is a change to the control and its own experiment.

## Deferred, each needing its own record

- **A 09:35 window.** The clone cannot enter before about 10:00, because its 2-minute ATR needs warming up. Testing an
  earlier start changes the control's entry window.
- **A swing family.** Multi-day holds on daily levels are a different desk, not the clone.
- **Expiry rules** (matching the expiry to the expected hold). The clone is flat by 15:10; HYP-0031 already covers
  the nearest expiry.
- **Promoting a shadow arm to paper orders**, or adding the new level codes (overnight, swing, event-candle, gap and
  all-time-high levels) to the frozen `levels.names` or `levels.strong`.

## Not changed

- `config/options_clone.yaml` and `config/risk.yaml` key `O`: every key, as frozen by DEC-0040.
- The owner's own trade rules on the dashboard and the probation rules (HYP-0025 to HYP-0028).
