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
