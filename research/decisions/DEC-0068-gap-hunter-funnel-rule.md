# DEC-0068: Gap Hunter: the funnel with scored chart and catalyst checks, one trade a day

- **Status: ACCEPTED on 2026-11-20** by the owner, in chat. He approved the chart score ("Yes, absolutely approve
  this formula"), asked for the catalyst to become a score with the buyout rejection kept hard, and confirmed one
  trade a day on the US$600 book. The numbers below are his where he gave one; where he gave a range or none, the
  choice made here is marked **(set here)** and is his to change before the rule is switched on.
- **Builds on:** DEC-0066 (the stock desk's paper book, its account, limits, day stop and stop rule; all unchanged)
  and SPEC-0001 (the registered entries and exit; unchanged).
- **Does not amend:** DEC-0010. The ten round-3 trials, their sets F and P and the frozen funnel
  (`wt.scanner.ranking.funnel`, held by its goldens) stay exactly as registered; the forward test keeps running
  them. This record adds a second selection rule beside the frozen one.
- **Trial:** 1 new, HYP-0071, in family **S** of `config/trial_registry.yaml` (now 3). Forward only: it is judged on
  paper sessions after it is switched on. The global count stays at 87.
- **Experiment:** EXP-0053.
- **Display name:** the desk is called **Gap Hunter**. Strategy tag `S`, journal, job `paper-s`, lease and record
  ids keep their names.

## Why

Counted on the host's 39 morning pools from 2026-09-28 to 2026-11-19 (counts only):

- 65 names reached Tier 1 (the hard filters), about one a day; on 8 days none did.
- Of those 65, 3 passed the trend check, 6 the window check and 4 the pre-market check; 49 passed none.
- So the frozen funnel's Tier 2 (every chart check passed) was empty on every day, and nothing was ever staged.
- Among names the hard filters rejected, 120 failed only for having no qualifying headline.

The owner's reading of the method: catalyst, float, gap and relative volume put a name in play; the daily chart
says where resistance is and how good the name is, and a name with no headline but real volume is still in play.

## The rule (frozen)

Inputs are the 09:25 pool's columns, as `scripts/build_pool.py` writes them. Nothing later is read.

**Hard filters. A name failing any is out.**

| Check | Value |
|---|---|
| Price at 09:25 | US$1.00 to US$20.00 |
| Gap from the split-adjusted prior close | at least 4% |
| Float (shares outstanding on record) | known, and at most 50,000,000 |
| Pre-market volume | at least 50,000 shares |
| Pre-market relative volume | at least 2.0 |
| Buyout or acquisition headline | none |
| Suspect split | false (a data-integrity check, not a chart opinion) |
| **No headline at all** | then relative volume at least 2.5 **and** pre-market volume at least 100,000 |

**Score.** The frozen base score (`wt.scanner.ranking.spec_score`: gap 0.25, relative volume 0.25, low float 0.20,
catalyst 0.15, former runner 0.15) with these changes and additions:

| Term | Value |
|---|---|
| Qualifying catalyst | as in the base score (0.15 times the category's value) |
| A headline that does not qualify, including an unconfirmed rumour | +0.05 **(set here: the owner's "+0.05")** |
| No headline | 0 |
| Above the daily EMAs (the pool's `trend_ok`: above the 20, 50 and 200) | +0.10 |
| Clean window (the pool's `window_ok`) | +0.10 |
| Pre-market structure (the pool's `pm_consolidation`) | +0.10 |

**Selection.** Tier 1 is the top 20 by score. Tier 2 is the top 4 by score. Ties: higher relative volume, then
larger gap, then symbol. The **primary** is rank 1 **(set here: the owner's "single highest-scoring setup")**.

**The trade.** One a day, in the primary only: the first of the registered gap entries (SPEC-0001's ENT-GG-1 to
ENT-GG-4) to give a valid signal, with every execution must as registered (first-minute volume, spread at most
US$0.05 with unknown failing, 2:1 room, the strict 10%-of-R collar) and the registered exit (half at the first
target, stop to breakeven, the stagnation stop, the trailed stop, the EMA exit). If the primary gives no valid
signal by the end of the entries' own windows, the desk does not trade that day. It does not rotate to another
name **(set here, from "one trade a day")**.

**The book.** DEC-0066 section 3 and 4, unchanged: US$600, 1% of equity at risk, T+1 cash, the day stop, the hard
limits and the stop rule.

## What is not adopted, and stays open

The owner's description of the method also has a marketable limit entry at the ask plus US$0.05 and direct
routing. DEC-0066 lists both as not adopted; this record does not adopt them either. The entry stays the
registered stop-limit with its collar. Changing it is a rule change for a record of its own, once the desk's quotes
show how often the collar refuses a fill.

## Disclosure

- The counts in "Why" were seen before this rule was written. They are counts of names through steps; no result of
  any trade under this rule exists or was computed.
- The forward ledger of the frozen trials to 2026-11-19 had been seen (DEC-0066 "Disclosure").
- This rule cannot be checked on 2019 to 2025: the news source returns nothing dated before 2026-04-28, so a pool
  built now for those years has no headlines. Its evidence is forward paper sessions only.

## What must be true before it is switched on

1. The selection is implemented beside the frozen funnel, with the frozen funnel's goldens unchanged.
2. On the host's pools, counts only: sessions with a primary under this rule, and how many primaries pass the
   entry musts. The owner sees those counts first.
3. The gap entries run live through `wt.live.runner_s` with the order manager's partial exit, and match the batch
   simulation on fixture days.
4. A dated note in DEC-0066 switches HYP-0071 on, with its id in `S.switched_on`, in one pull request.

## Notes

### 2026-11-20: how the live desk reads "the first of the registered entries to give a valid signal"

Written with the pull request that adds the gap entries to `wt.live.runner_s`. Nothing is switched on by it:
`S.switched_on` stays empty. Each point below is a reading the code had to choose; each is **for the owner to
confirm or change before the rule is switched on**. Where the record was silent, the reading that trades less was
taken.

1. **One resting order: the lowest valid trigger.** The batch run tests each entry rule on its own. A live desk
   has one order manager, and its guard forbids a second open buy in a name. Several rules can have a valid order
   at the same moment (the level order rests from 09:31 to 10:00 while the opening-range and red-to-green orders
   are re-priced). The desk rests only the valid order with the lowest trigger, the first a rising price reaches,
   and replaces it (cancel, confirm, then place) when that changes. Equal triggers go to the lower rule number.
   The journal names the rule by a code, `e1` to `e4`, for ENT-GG-1 to ENT-GG-4.
2. **The day's one attempt.** The first closed bar that reaches the trigger of the order that should be resting
   is the day's attempt. If it fills, that is the day's trade. If it does not (the bar opened over the collar, the
   order had been refused for its spread or a gate, the desk was not running), the desk does not trade that day:
   it does not go on to another rule's order. This follows DEC-0066's note of 2026-11-19, item 4 ("an order that
   does not fill ends the name for the day"). A rule whose order is invalidated without being reached (its stop
   trades first, or its window ends) ends only that rule; the others go on.
3. **Spread at the decision.** The spread must is asked each time an order is about to be sent. A signal refused
   for its spread, or for a collar narrower than the slippage the simulation charges, is never sent later.
4. **Orders that live for one bar.** The one-minute opening-range order and each red-to-green order are valid for
   the next bar only. The desk cancels them when the minute they were decided for ends, by the clock, and places
   the next one once that minute's bar has been read. An entry order is placed only when the bar of the minute
   just ended printed (DEC-0066 section 3: no print is treated as halted).
5. **Size.** Sized at the fill the simulation expects (the trigger plus its slippage), as the engine sizes at the
   fill; with the small risks of these entries a cent changes the share count.
6. **Order count.** Re-pricing stops for the day once 40 orders have been sent (`S.max_orders_per_day` is 60; the
   rest is left to the exit's stop moves). The journal says so.
7. **The pool.** Read once, at the first poll of the session at or after the open, from
   `data/candidates/<day>.parquet`. A file that is missing, unreadable, or whose rows are not dated that day
   gives no primary: entries are off for the session and exits are still managed. A restart reads the primary
   back from the journal and does not choose again.
8. **Which trial a session runs.** One: the one in `S.switched_on`. With HYP-0070 and HYP-0071 both listed the
   session places no entry. With neither it runs as before (the reversal rule with entries off).

**Where the live desk cannot be the batch simulation.**

- The simulation fills the first target on a bar's high; the desk sells when the bid is at or over it, with a
  limit at the target's price (DEC-0063's rule, as the reversal mode does).
- The five-minute entry's breakout-volume check is known only when its five-minute bar completes, up to four
  minutes after the fill. On that last minute the simulation asks the check before the target; the desk may
  already have sold half on the quote. Either way the position is closed at the next open.
- The batch run skips a name with fewer than 30 minute bars in the whole session. That is not knowable in the
  morning; the desk does not apply it.
- The engine caps the size at 10% of the entry bar's volume, and takes no trade under 10 shares
  (`wt.backtest.engine`). The entry bar is the bar the order fills on, which has not printed when the order is
  sized, so the desk does not apply the cap. On a thin fill bar the simulation trades fewer shares, or none,
  where the desk trades its full size.
- The first-target sale is tried at most once a minute, and only on a quote no older than
  `S.max_quote_age_s`; the simulation has no quote and no wait.
- A trailed stop the broker refuses because the market is already under it is treated as the stop being hit:
  the desk sells at the market, for the exit the simulation takes at that bar's open.

**What the parity tests hold** (`tests/unit/test_gap_live.py`, `tests/unit/test_runner_s_gap.py`, constructed
days only, no market data): for each of the four rules, the live reading and the batch detector with
`wt.backtest.engine.simulate` agree on whether there is a trade, the entry bar, the entry price, the stop, the
breakout-volume flag and every exit; and the runner, replayed, takes the simulation's trade on fixture days of
each rule.

### 2026-11-22: the owner confirms the eight readings

Asked in chat for a yes or no on the eight readings of the 2026-11-20 note (point 2 named as the one most worth
his attention), the owner answered "yes". All eight stand as written, with the review fixes of #572 listed under
"Where the live desk cannot be the batch simulation". Nothing is switched on by this note: HYP-0071 trades only
once the owner has seen the host's entry counts (`scripts/gap_hunter_counts.py`), a dated note in DEC-0066 switches
it on, and its id is in `S.switched_on` (`config/risk.yaml`), with its key pair on the host.

### 2026-11-22: where the morning pool comes from

Reading 7 of the 2026-11-20 note named `data/candidates/<day>.parquet`. Checked on the host before the first live
session, that file is written only after the close, by the forward test. The pre-market routine builds the pool
at each stage, but it kept the pool in memory. A live session would therefore have found no pool and taken no entry.

From the pull request that carries this note:

- At 09:25 the pre-market routine runs the after-close pool's own build: the 09:00 to 09:25 window, on the
  consolidated feed (`PoolConfig()`'s defaults). It saves the pool to `data/candidates_live/<day>.parquet`, with
  `data/pm_bars_live/<day>.parquet`.
- The stock desk reads that file at the first poll at or after the open. Everything else in reading 7 stands.
- If the build fails, the routine pages ("Gap Hunter: no morning pool") and the desk takes no entry that session.
- The forward test's after-close pool stays where it was and is never written by the routine. The forward test
  reuses a pool file that already exists, so writing to the same folder would have changed its inputs.
- The before-switch-on counts (EXP-0053) were taken on the after-close pools: the same build on the same window,
  made later.

### 2026-11-23: an exit whose stop cancel is not confirmed (DEC-0071)

One more difference from the batch simulation, recorded and narrowed by DEC-0071. When an exit cannot confirm its
stop's cancel, it is asked again on the next poll. Until DEC-0071 takes effect, that poll's reconcile first puts a
fresh stop back, and the exit has to cancel it too: about a loop and two orders each time. Robot B lost up to two
such rounds on its end-of-day flattens. With DEC-0071, the stop is not replaced for up to 15 s, so the next poll
sells. The simulation exits at the bar's open in both cases. No reading of the rule changes.

### 2026-11-26: a partial check on 2019 to 2025 is proposed (DEC-0081)

The line "This rule cannot be checked on 2019 to 2025" still holds for headlines. Alpaca confirmed on 2026-11-24 that
the Benzinga history is gone for good. DEC-0081 (PROPOSED) and EXP-0057 propose SEC filings as a partial stand-in
for the catalyst columns. It must first pass an agreement test, and then gives counts only, on the development span
only. Nothing in this rule changes, and its evidence stays the forward paper sessions until a later record says
otherwise.

### 2026-11-26: the SEC-filing stand-in failed its test (DEC-0081)

EXP-0057 phase 1 measured the EDGAR proxy against the forward headlines. Earnings agreement was 74.5%, below the 0.80
bar, and buyouts matched 3 of 14. DEC-0081's note of 2026-11-26 closes the proxy. "This rule cannot be checked on
2019 to 2025" therefore still holds in full. Nothing in this rule changes.
