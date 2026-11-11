# DEC-0030: The options clone, a paper bot that trades same-day options by the owner's rules

- **Status: ACCEPTED on 2026-10-18.** The owner accepts it by merging the pull request that carries this status
  line. He approved the plan this record comes from on 2026-10-18 and chose, the same day, that the clone trades
  paper from its first session, with no shadow sessions.
- **Depends on:** DEC-0005 (every configuration tried counts as a trial), DEC-0028 (the options desk, family O),
  DEC-0029 (return on premium as the unit; still PROPOSED, and not needed here: this record prices from fills).
- **Amends** DEC-0028, section 1, in one sentence only: code in this repository may place orders, for the clone
  alone, under the rules below. Everything else in DEC-0028 stands, and the four probation rules are untouched.
- **Date drafted:** 2026-10-18.

## Why

The owner trades long calls and puts by hand, same day, under nine rules shown on the Trades page. Whether those
rules win cannot be read from his record: the record mixes many styles and years. A bot that keeps the rules
without exception, in a paper account, gives a clean test of the rulebook itself.

His reconstructed record (1,245 round trips: 765 calls, 266 puts and 214 stock swing trades; percentages and counts
only, kept out of this repository under `knowledge/`) shows what the rules must stop: a dollar-weighted profit factor
of 0.90 despite a 56% win rate, losses that ran past half the premium, calls bought against the tape, the busiest
and weakest hour at the open, re-entering the same loser, and overtrading. Each finding has a mechanism below.

## Decision

### 1. What the clone is
- **Paper only.** The broker adapter talks to the paper host, named by a constant, and refuses a live key. There is
  no live setting anywhere in its configuration.
- **One kind of trade:** buy one same-day call or put, sell it the same day. No spreads, no selling premium, no
  exercise, no position held past 15:10 New York time.
- **Everything is frozen in `config/options_clone.yaml` and `config/risk.yaml` key `O`** at the commit that merges
  this record. A changed number after a result is seen is a new record and new trials.
- **It trades from its first session.** Its own checks run while it trades; a failed check narrows what it may do
  (no new entries, exits only, flatten), and never waits for a human.

### 2. The two setups, one trial each
Both trigger only on a closed 2-minute bar, only within one 2-minute ATR of a marked level (previous day, week and
month highs and lows, the pre-market high and low, the 20- and 50-day averages).

- **HYP-0029, break and retest:** a close through the level in the trend's direction; within six bars a touch back
  to within one ATR of it without a close back through; then a close away from it. Invalidation: a close one ATR
  back through the level.
- **HYP-0030, rejection:** at a strong level only (a big zone, or a week or month high or low), a bar pokes through
  and closes back inside, or its wick through is at least half its range, **and** the next bar also closes inside.
  Invalidation: a close beyond the poke's extreme.

Every trade must also pass every gate, and the journal records each gate on its own, every bar, for every name:
trend (VWAP and SPY's VWAP), extension (1.5 ATR from the 9 EMA), room (next level at least twice the risk away and
inside the day's expected move), events, shock, contract, and the limits.

**The rule is the code.** A setup means what `wt.options.setups` does at the commit that merges the pull request
that builds it, under the numbers frozen here.

**Trials:** two new trials in family O. The family count goes from 12 to **14** (`config/trial_registry.yaml`).
DEC-0029 is still proposed; if it is accepted later, its row must be written as 22, not 20.

### 3. The account, and the owner's hand trades
If the key pair `APCA_CLONE_KEY_ID` / `APCA_CLONE_SECRET_KEY` is set on the host, the clone trades in a paper account
of its own. Otherwise it trades in the second paper account, beside the owner's hand trades. A broker holds one
position per contract, so in a shared account no order tag can prove which lot is whose. The clone therefore:
counts its position from its own fills only; never opens a contract the account already holds; never sells more
than its own lots; and when the account's quantity falls below its own with no fill of its own, books that trade as
`unresolved`, pages, and leaves it out of the verdict. The count of such trades is reported.

### 4. Prices and feeds
- Fills are the record. The paper engine matches orders against the national best bid and offer.
- The option quotes the clone reads are the broker's free real-time `indicative` feed, whose quotes are modified
  from the exchange's. The clone never treats a modelled price as executable; it measures, every poll, how old its
  quotes are and, every fill, how far the fill is from the quote. Over thresholds it stops opening positions for the
  session (`feed-unfit`). The exact feed (OPRA) is the owner's choice and switches by one setting.

### 5. Stops: planned and guaranteed
Planned: $50 a trade (a 25% premium stop on a premium of $200 or less), $100 a day, flat by 15:10. Guaranteed: never
more than the premium paid plus fees on a trade. A software stop checked every 10 seconds sells at the next fill
after the trigger, not at the trigger. The worst case if exits fail is the whole premium a trade and two premiums a
day; the escalation from a failed exit to a critical page is in `docs/runbooks/options-clone.md`.

The 10% stop and 20% target of the owner's earlier paper test are not used: the Trades page's own study of SPY
2-minute bars found a 10% stop on an at-the-money option hit by the very next bar 17% of the time, against about 1%
for 25%, and LL-0002 found stops inside the bar's noise lose to costs. Testing 10/20 as well would be two more trials.

### 6. The verdict
Unit: **return on premium from fills**, after $0.03 a contract each way. For each setup, on trades from its first
session on:
1. No verdict before **30 trades and 20 sessions**.
2. **Falsified** if the lower end of the 95% bootstrap range of the mean, resampled **by session**, is at or below
   zero, or the mean is at or below zero in either half of the trades taken in order.
3. **Passes** only if that range lies wholly above zero and both halves are above zero.

Also reported and never the verdict: the same range by trade, dollar profit factor, expectancy in dollars, maximum
drawdown, longest losing streak, the share of favourable excursion captured, rule breaks per 100 trades, latch days,
slippage, quote ages, and every figure split by regime and by gate pattern at entry.

**A pass changes nothing by itself. Position size never increases automatically.** A second contract needs its own
review, a new record and the owner's explicit approval.

### 7. The experiment
EXP-0024 (`research/experiments/EXP-0024-options-clone-forward/`) is the forward run. Its ledger is append-only and
hash-chained; its report is written once, by a script that refuses to overwrite it.

## What this record does not do
It changes no probation rule, no page claim of DEC-0028, and nothing of strategy B or the crypto desk.

## Note on the earnings dates (added 2026-11-11; nothing above is changed)
The events gate's earnings skip (`session.event_block`) reads `config/events/earnings.csv`. On 2026-11-11 that file's
data was completed from the companies' own announcements: rows added for AMD (2026-11-03) and AVGO (2026-12-09),
and NVDA's 2026-11-17 row changed from expected to confirmed. The AMD row is in the past and changes no future run:
the 2026-11-03 and 2026-11-04 sessions ran without that skip. The rule and its numbers are unchanged. No clone
journal, trade or result was viewed for this change.
