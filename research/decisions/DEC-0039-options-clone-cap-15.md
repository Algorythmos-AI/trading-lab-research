# DEC-0039: The options clone's contract cap rises to $15.00

- **Status: ACCEPTED on 2026-10-29.** The owner chose the new cap on 2026-10-29. The merge of the pull request that
  carries this line accepts it.
- **Written before any trade under the new cap exists.** No session has run with an ask cap above $2.00. The author
  has not looked at any paper P&L of the clone, or at any probation-rule result, while writing this record.
- **Amends** DEC-0030 (the clone's frozen rules) in the contract's price cap and the three loss latches only. Every
  other gate, filter, exit and limit is unchanged.
- **Depends on:** DEC-0005 (trial accounting), DEC-0028 (family O), DEC-0030, DEC-0031, DEC-0034 (the nearest
  expiry), DEC-0038 (AVGO and AMD).
- **Experiment:** EXP-0028.

## Why

With an ask of at most $2.00 ($200 a contract), the higher-priced names (META, TSLA, AVGO among them) never offer a
same-day or weekly contract near the money that the clone may buy, so the clone cannot trade them at all. The owner
chose to raise the cap rather than drop those names.

## Decision

1. **Contract cap** (`config/options_clone.yaml`, `contract.max_ask`): 2.00 -> **15.00**, that is $1,500 a contract.
   - **Which contract:** the one nearest the money among every contract that passes the filters with an ask up to
     $15.00, as before (`wt.options.chain.pick`, nearest strike). No code path prefers the cheapest contract.
   - `config/risk.yaml` key `O`: `max_premium` 200 -> **1500**, `max_limit_price` 2.00 -> **15.00**.
2. **The 25% premium stop is kept.** The planned loss of one trade is 25% x $1,500 = **$375** (was $50).
3. **The loss latches are derived, not chosen:** each is scaled 7.5x with the cap, so that one full stop still fits
   inside the day latch, as it did before.
   - `day_loss_latch` 100 -> **750**
   - `week_loss_latch` 300 -> **2250**
   - `drawdown_latch` 500 -> **3750**
4. **Unchanged:** `max_contracts` 1, entries a day, attempts a name, orders a day, open positions, the delta floors,
   the spread caps, the volume and open-interest floors, the exits, the gates and the 15:10 flatten.
   - Observation, not a change: the absolute spread cap `max_spread: 0.15` is unchanged, and may still refuse
     higher-priced names whose quoted spread is wider than 15 cents.
5. **A new experiment, EXP-0028.** Trades under the new cap are counted apart from every trade before it.
   - The clone's three trials (retest and rejection on same-day contracts, HYP-0029 and HYP-0030; nearest expiry,
     HYP-0031) are run again under the new cap as **three new trials**. Their statements are unchanged; only the
     frozen configuration they read differs.
   - The trial count for family O therefore goes from 15 to **18**.
   - Each trial's verdict needs a fresh 30 trades and 20 sessions, counted from the first session under the new cap
     only, with the same test as DEC-0030 section 6 (`wt.options.review.verdict`).
6. **Effective first session: Friday 2026-10-30.** The owner chose this date; the release must be deployed to the
   host before that session opens. Thursday 2026-10-29 is the last session under the old rules.
7. **The trades before the new cap keep their rules.** Every trade on or before 2026-10-29 stays in EXP-0024 and
   EXP-0026 under DEC-0030, DEC-0031, DEC-0034 and DEC-0038; none of them counts toward EXP-0028, and no trade
   counts in both. `wt.options.review` reports the two windows apart (`OLD_RULES_END`, `CAP15_START`).

## Not changed

- The probation rules (HYP-0025 to HYP-0028) and their numbers.
- The owner's own trade rules on the dashboard (`dashboard/src/lib/trade-rules.ts`, `MAX_PREMIUM`). They are the
  owner's account rules, not the clone's.
- Size: one contract. A pass never raises the size without its own record.
