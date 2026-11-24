# DEC-0079: A shadow arm on the options clone: the 5-minute time stop judged at the quote's midpoint

- **Status: PROPOSED on 2026-11-25 (Sydney; 2026-11-24 after the close, New York).** The owner asked for this record
  in chat on 2026-11-25. It is accepted by the owner's merge of a pull request that changes this line to ACCEPTED.
- **NOT blind.** It was written after the author had read results of the rule it tests. What was seen is listed in
  "Disclosure". No session up to and including the one of the acceptance counts.
- **Amends nothing.** DEC-0030 (the clone and its exits), DEC-0031 (the dry run), DEC-0041, DEC-0059 and DEC-0064
  stand as written. The control (the clone's trials in force under `config/options_clone.yaml`, EXP-0050) places
  exactly the orders it would place without this record. `config/options_clone.yaml` is not changed by this record.
- **Depends on:** DEC-0005 (every configuration tried counts as a trial), DEC-0028 (family O), DEC-0030, DEC-0031,
  DEC-0041 (the shadow evaluator `wt.options.shadow` and its paired test), DEC-0059 (the old arms stopped booking).
- **Trial:** 1 new, HYP-0073 (OC-TIME-MID), in family **O** of `config/trial_registry.yaml`: 51 now, **52** once
  this record is accepted. The global count stays at 87.
- **Experiment:** EXP-0055.

## Why

The clone's time stop (DEC-0030, `exits.time_stop_min: 5` in `config/options_clone.yaml`, frozen with the comment
"bid not above the fill this long after it") closes a trade at any poll from five minutes after the fill on at which
the contract's **bid** is at or below the fill (`wt.live.runner_o.Runner.exit_reason`). The clone buys at the
ask. So at the fill the bid is already below the fill by the whole spread, and the trade survives the time stop only
if the bid climbs by more than the spread within five minutes and stays above the fill until the trade reaches
breakeven.

The live rule is the registered one: this record does not find a defect. Two things make the question worth a trial:

1. **The dry run judged it differently.** DEC-0031 section 3, point 5 priced the clone from option minute bars and
   tested "the minute's close is not above the fill". A traded close sits nearer the middle of the spread than the
   bid does. The two readings of one registered rule disagree exactly when the spread is wide against the move.
2. **It was the clone's most frequent exit** in what the author saw (see "Disclosure"), and most of those trades had
   had a bid above the fill at some point before the exit.

The question is whether the time stop, judged at the midpoint of the quote the control already reads, keeps trades
whose spread, not their direction, made them look stalled, and whether that pays after the spread is paid on exit.

## Decision

1. **One shadow arm, `time_mid` (HYP-0073).** A virtual second contract on each real fill of the control, of either
   setup (retest or rejection): the same contract, the same fill, the same time. It follows the control's exits in the
   control's order (`exit_reason`) with one change only: the time stop fires when, five minutes or more after the
   fill, the quote's **midpoint** ((bid + ask) / 2) is at or below the fill, in place of the bid. **(set here)**
2. **Everything else is the control's.** The 25% premium stop and the breakeven move after +25% judged on the bid,
   the chart (invalidation) close, the next level, the 50% target, the 15:10 flatten (12:10 on a half day). A safety
   exit of the control (`wt.options.shadow.SAFETY_EXITS`: blind, stale stock feed, day loss, an operational exit,
   kill, latch, the flatten) closes the virtual contract with the control at the control's price. Every exit of the
   virtual contract is priced at the bid of the quote the runner read at the poll it fired on, as the other shadow
   arms are (DEC-0041 point 2). Return on premium after $0.03 a contract each way, as
   `OptionPlan.return_on_premium`.
3. **Where the two can differ.** The midpoint is never below the bid, so the variant's time stop can fire only at a
   poll where the control's fires too. Up to the control's own time-stop exit the two contracts are the same trade;
   they part only at a control time-stop exit where the midpoint is above the fill. **The unit is that trade:** a
   control trade closed by the time stop at a poll where the quote's midpoint was above the fill. Every other control
   trade gives a difference of zero by construction and is counted, not tested. **(set here)**
4. **Quotes.** The runner's own quotes, the ones the control's exits read at each poll (about every 10 seconds). Not
   the lab's tape: its 5-second tier holds only contracts asked at $3.00 or less (`wt.lab.tiers`) and only the
   session's focus names, and the clone buys above that and trades the standing name.
5. **No orders, no effect on the control.** The code comes in a later pull request, after this record is accepted:
   the arm in `wt.options.shadow`, which imports no order path, booked to the runner's shadow file under its own
   switch, off by default. That pull request carries a test that the control's decisions and its config hash
   (`runner_o`'s hash leaves out the `research_arms` block) are identical with the arm on and off. The owner turns the
   switch on; the window starts at the first session the arm books on the host after that.
6. **Window (set here).** Forward only, never backfilled from journals or logs. It counts while the control's
   `exits` and `order` sections of `config/options_clone.yaml` are as they are at the acceptance. A change elsewhere
   in the control's config (names, caps, feeds) does not end it; each unit carries the control's config hash and the
   report lists the units by hash. A change to `exits` or `order` ends the trial with whatever it has.
7. **The test.** DEC-0041's paired test, as HYP-0044: on units only, the mean paired difference per unit (variant
   minus control, return on premium after fees), a 95% bootstrap range resampled by session, 10,000 resamples, seed
   20261179 **(set here)**. At least 30 units and 20 sessions with a unit. Falsified if the lower end of the range is
   at or below 0, or the mean difference is at or below 0 in either half of the units taken in order.
8. **Close without a verdict on 2027-06-30** **(set here)** if it has fewer than 30 units by then.
9. **Reported once**, by a verdict script the code pull request adds, when the trial reaches its count or its close
   date. Until then only counts are shown: sessions booked, control time-stop exits, and how many of them were units.
   No difference, P&L or return of the arm is read or shown before the report.
10. **A pass changes nothing by itself.** Trading the midpoint rule is a change to the control's exits: its own record
    and new trials for the clone's setups.

## Disclosure

Before writing this record the author read, on 2026-11-25 (Sydney), from the host's options journal:

- the two trades of the 2026-11-24 session, both closed by the time stop about five minutes after the fill, with
  their fills, exit prices, best and worst bids, and P&L;
- a count of every closed clone trade by exit reason, with each reason's summed P&L, over all sessions to date;
- how many of the time-stop exits had a best bid above the fill at some point (most of them).

Not read: the quote's midpoint or ask at any time-stop exit, any tape, any replay of this rule. No unit can be
computed for those sessions, because the runner kept no midpoint at its exits; they could not count in any case
(point 6).

## Not changed

- `config/options_clone.yaml`: every key, including `research_arms` (still `enabled: false`, DEC-0059).
- The control's orders, latches, pauses and position count; the DEC-0041 arms and their verdicts.
