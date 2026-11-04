# DEC-0040: The options clone's absolute spread cap rises to $5.00

- **Status: ACCEPTED on 2026-11-04.** The owner chose the new cap on 2026-11-04. The merge of the pull request that
  carries this line accepts it.
- **Written before any trade under the new cap exists.** The author read the clone's decision log for 2026-10-30 to
  2026-11-04 (which gate refused which signal, counts only) and the two trade results already reported; no trade under
  a spread cap above $0.15 exists.
- **Amends** DEC-0030 and DEC-0039 in the absolute spread cap only. Every other gate, filter, exit, limit and latch is
  unchanged.
- **Depends on:** DEC-0005 (trial accounting), DEC-0028 (family O), DEC-0030, DEC-0034, DEC-0038, DEC-0039.
- **Experiment:** EXP-0029.

## Why

A contract must pass two spread caps: at most `max_spread` dollars and at most `max_spread_pct_of_mid` (8%) of mid.
On the higher-priced names the fixed $0.15 decides: on 2026-11-04 two AMD signals passed every other gate and were
refused only for `spread-too-wide`. The owner chose to lift the fixed cap and keep the 8% cap.

## Decision

1. **Absolute spread cap** (`config/options_clone.yaml`, `contract.max_spread`): 0.15 -> **5.00**.
   - With `max_ask` at $15.00, 8% of mid is at most $1.20, so the 8% cap now binds first on every contract the clone
     may buy. The spread a contract may have scales with its price.
   - Which contract: the one nearest the money among those that pass every filter, as before (`wt.options.chain.pick`).
2. **Unchanged:** `max_spread_pct_of_mid` 8, `max_ask` 15.00, the delta floors, the volume and open-interest floors,
   the entry limit (the ask plus 2%, never above `max_ask`), the 25% premium stop, the latches, the exits, the gates,
   one contract and the 15:10 flatten.
3. **A new experiment, EXP-0029.** The clone's three trials (HYP-0029, HYP-0030, HYP-0031) are run again under the new
   cap as **three new trials**; family O goes from 18 to **21**. Each verdict needs a fresh 30 trades and 20 sessions
   from the first session under the new cap, with the test of DEC-0030 section 6.
4. **Effective first session: Thursday 2026-11-05**, on the condition that the release is deployed to the host before
   that session opens. Wednesday 2026-11-04 is the last session under the $0.15 cap. If the release lands later, a
   one-line amendment to this record moves `SPREAD5_START` and `CAP15_END` to the first session it runs, before that
   session's trades are viewed.
5. **EXP-0028 closes at 4 sessions.** Trades from 2026-10-30 to 2026-11-04 stay in EXP-0028 and never count toward
   EXP-0029. EXP-0028 cannot reach 20 sessions and so will never give a verdict; it is kept as a record.
   `wt.options.review` reports the windows apart (`CAP15_END`, `SPREAD5_START`).

## Not changed

- The owner's own trade rules on the dashboard.
- The probation rules (HYP-0025 to HYP-0028).
