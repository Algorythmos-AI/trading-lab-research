# DEC-0031: The options clone, one historical dry run on SPY and QQQ (EXP-0025)

- **Status: ACCEPTED on 2026-10-20.** The owner gave the go for this run on 2026-10-20 ("do it for me"), and the
  merge of the pull request that carries this line accepts it. **Nothing below has been run, and no result of it has
  been seen, when this record is written.**
- **Depends on:** DEC-0030 (the clone, its two setups HYP-0029 and HYP-0030, its frozen numbers), DEC-0029 (the
  spread widths, still PROPOSED: only its widths and fee are borrowed here, as assumptions).
- **Does not amend** DEC-0030. Its verdict is read only from paper fills (EXP-0024). Nothing here feeds it.

## Why

The clone trades paper from 2026-10-20. Before its own record builds up, the owner wants to know how its two setups
would have done on the months behind it, priced as the options they stand for. This record fixes, before any result
exists, how that replay is run, so the answer cannot be shaped after it is seen.

## Decision

### 1. What is replayed
- **The code of the clone** at the commit that runs it: `wt.options.regime`, `wt.options.setups`,
  `wt.options.session` and the gates of `config/options_clone.yaml`, unchanged. The script that drives them,
  `scripts/options_clone_dry_run.py`, is merged before the run.
- **Names:** SPY and QQQ, every session: the clone's fallback names, the only ones with a same-day expiry every day.
- **Span:** sessions 2026-03-02 to 2026-10-16, the last full week before the clone's first session.
- **Bars:** the consolidated tape's 1-minute stock bars (`feed=sip`), split-adjusted, resampled into the clone's
  2-minute bars; the clone itself reads the IEX feed, which is thinner. Levels from the same tape's daily bars.
- **Events:** `config/events/macro_events.csv` and the FOMC rule, as the clone applies them.

### 2. The contract and its prices (the clone reads live quotes; history has none)
- **Contract:** the same-day call (or put) whose strike is the listed strike nearest the stock at the signal's close
  (of two equally near, the lower). The delta, volume and open-interest gates cannot be evaluated on history and are
  left out, and the report says so.
- **Option prices:** the contract's own **1-minute trade bars** (volume-weighted price, high, low).
- **Entry:** the volume-weighted price of the first 1-minute bar that starts at or after the signal bar's close,
  **plus half the spread**. No bar within 3 minutes: no trade, counted as `no-option-bar`. An entry above $2.00:
  no trade, counted as `over-cap` (the clone's premium cap).
- **The spread** (DEC-0029's widths for these two names): the larger of $0.02 and 2% of the price, full bid to ask.
  Every result is also given at **twice** that width; a reading must hold at both.
- **Fees:** $0.03 a contract each way.

### 3. Management, minute by minute, in the clone's order
On each minute after the fill, the first that applies:
1. **15:10** (12:10 on a half day): exit at that minute's volume-weighted price less half the spread.
2. **Day loss** at or under -$100, realised plus the open trade at its last price: exit as in 1.
3. **Chart:** a finished 2-minute stock bar closes beyond the invalidation: exit at the next minute's price.
4. **Premium stop:** a minute's low reaches 75% of the fill (the fill itself once +25% was reached): exit at that
   level less half the spread, or at the minute's open if it opened below it (a gap).
5. **Time stop:** five minutes after the fill, the minute's close is not above the fill: exit at that close.
6. **Next level:** a finished 2-minute stock bar closes at or beyond the next level: exit at the next minute's price.
7. **Target:** a minute's high reaches 150% of the fill: exit at that level less half the spread.
A minute that reaches both the stop and the target is a stop. Three minutes in a row with no option bar while in a
trade: exit at the next bar's price, counted as `gap-exit`. Every exit price is net of half the spread.

### 4. The day's limits, as frozen
Five entries a day, two per name, one position at a time, 30 minutes off after two losses in a row, done after three,
20 minutes off a name after a loss there, entries 10:00 to 14:30, the day latch at -$100. The week and drawdown
latches would stop a live clone until the owner resets them; here they are **counted and reported, and the replay
continues**, so the whole span is seen.

### 5. What it reports, and what it may be used for
- Per setup and both together, at 1x and 2x the spread: the figures of `wt.options.review.figures`. These are
  trades, sessions, mean return on premium with its 95% range resampled **by session**, both halves, dollar profit
  factor, drawdown, longest losing streak, and exits by reason. Also the trades left out by reason, and the days the
  week or drawdown latch would have stopped the clone.
- **It is exploratory.** It may inform the owner. It **may not change any number** of `config/options_clone.yaml`,
  may not promote, drop or resize anything, and is not evidence for DEC-0030's verdict. A change it suggests would
  need its own record, would count as new trials, and could only be judged on later paper trades.
- **Trials:** none added. It replays the two registered configurations, unchanged; family O stays at 14.
- **Run once.** The script refuses to write over its report; a re-run is a new experiment.

## What would count against this design
- If more than a fifth of a setup's signals are left out for want of option bars, that setup has no reading here,
  and the report says so instead of giving one.
- Same-day contracts in their last hours trade in fast, thin minutes: a 1-minute bar's volume-weighted price is a
  rough stand-in for a fill. The 2x spread run is the guard against that, not a cure.
