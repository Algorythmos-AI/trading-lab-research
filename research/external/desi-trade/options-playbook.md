# His options handling, mapped onto our clone

Our options clone (family O, `config/options_clone.yaml`, EXP-0029) buys one call or put on a 2-minute trigger at a
marked level. This page sets his habits beside each part of it. Rule numbers point to [`rules.md`](rules.md).

| Part of a trade | The clone today | What he does | What we test |
|---|---|---|---|
| Where | marked levels: PDH/PDL/PDC, previous week and month, pre-market, averages, supply/demand | the same, plus swing highs and lows, event candles, gaps, prior ATH, overnight (R04, R05) | new level codes, tagged only, not in the frozen strong set |
| Trigger | retest within 6 bars and 1 ATR; rejection wick at a strong level | same two, plus reclaim after a sweep and trap after a failed push (R08, R09) | fast-reclaim arm HYP-0047 and trap arm HYP-0046 (shadow: virtual trades only) |
| When | entries 10:00 to 14:30, flat by 15:10 | most entries 09:30 to about 11:00; no late-day trades (R16) | early arm HYP-0042/0043: 10:00 to 11:00 against the rest (tag). Earlier than 10:00 is blocked by ATR warm-up and deferred. |
| Market filter | name and SPY on the right side of VWAP | semis must agree for Nasdaq trades (R15); no trades in the middle of a range (R13); gap rules (R14) | leader arm HYP-0038/0039, NTZ arm HYP-0034/0035 and gap arm HYP-0036/0037 (tags) |
| Contract | nearest expiry, spread at most $5, one contract, premium at most $1,500 | expiry fits the hold (R23); shares or futures when the option is poor (R24); avoid high IV (R21) | IV arm HYP-0040/0041 (tag); the expiry rule is deferred |
| Stop | -25% of premium; breakeven after +25% | small losses at a level fail (R20) | unchanged |
| Exit | +50% or the next level; 5-minute time stop | part off at the first target, runner trails the EMA to the next level, technical exits only (R19) | **runner arm HYP-0044/0045: a virtual second lot that moves to breakeven at +25% and trails the 2-minute EMA9 to the next level or 15:10** |
| Per day | 5 entries, 2 per name; pause after 2 losses; stop after 3 | one and done after a winner (R26) | deferred |

## Why the exit matters most

His results, as he tells them, come from a few large winners: 100% to 200% on runners, with many small losses.
The clone takes +50% or leaves after five minutes, which cuts off exactly that tail. If the clone's entries have any
edge, a trailing runner is where it would show. The runner arm (HYP-0044/0045) measures this on the clone's own
fills, so the entries and contracts stay the same and only the exit changes.

## Why the tags come first

Tag arms (NTZ, gap, leader, IV, early) place no orders. Each splits the clone's own decisions into two groups and
compares them. They cannot change EXP-0029, and they tell us which of his filters would have helped before we let
any of them stop a trade.
