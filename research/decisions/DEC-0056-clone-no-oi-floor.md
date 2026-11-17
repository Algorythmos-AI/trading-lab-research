# DEC-0056: The options clone drops its open-interest floor

- **Status: ACCEPTED on 2026-11-17 (New York).** approved_by: owner. The owner chose this rule in chat on 2026-11-17,
  from three options put to them after the corrected root cause below (drop the floor on every expiry; drop it on
  contracts that do not expire that day only; hold the change). They kept the trend and room gates unchanged,
  accepted that the research arms end (point 6), and asked for it to run from 2026-11-18. The merge of the pull
  request that carries this line accepts it.
- **Written before any trade under the new rule exists.** What the author had seen is listed in "Disclosure".
- **Amends** DEC-0030, DEC-0039 and DEC-0040 in the open-interest floor only. Every other gate, filter, exit, limit
  and latch is unchanged.
- **Depends on:** DEC-0005 (trial accounting), DEC-0028 (family O), DEC-0030, DEC-0034, DEC-0039, DEC-0040, DEC-0041
  (the research arms), DEC-0054 (EXP-0037).
- **Experiment:** EXP-0039.

## Why

`min_open_interest` (1000) counts the contracts left open at the previous close. It measures yesterday, not whether
a contract can be bought and sold today, and it refuses contracts that trade heavily:

- **The past refusals.** In the clone's decision lines of 2026-10-20 to 2026-11-17, 10 signals passed every gate but
  the contract one. The check that refused the contract nearest the money (the line's `reason`) was the
  open-interest floor for 4 of them, all on same-day contracts (AMD 2026-11-09, NVDA 2026-11-09, AMD 2026-11-16
  twice); the premium cap for 3, the spread cap for 2, and the volume floor for 1 (AVGO, 2026-11-17 10:38, on the
  next day's expiry).
- **A live read** of the OPRA chain at about 15:20 New York on 2026-11-17 (data requests only, no order path)
  found the at-the-money 2026-11-18 contracts of AVGO and TSLA refused for open interest alone, while volume and
  spread passed with room: AVGO 337.5 put 7.05 / 7.40, volume 1,313, open interest 152; TSLA 380 call 4.85 / 4.95,
  volume 25,496, open interest 386. With those refused, TSLA's put pick moved to the 387.5 strike, about $7 in the
  money.

The session's own volume floor (500; 5000 for SPY and QQQ) and the spread caps (8% of mid, $5.00) measure the same
session's trading, so they stay as the liquidity test.

## Decision

1. **No open-interest floor** (`config/options_clone.yaml`, `contract.min_open_interest`): 1000 -> **0**. The
   check stays in `wt.options.chain.pick`, so a later record could set a floor again.
2. **Unchanged:** the volume floors, both spread caps, the $15.00 ask cap, the delta floors, every gate (trend,
   extension, room, reach, shock, macro), the setups, the entry limit, one contract, the 25% premium stop, the
   exits, the latches, the names and the 15:10 flatten.
3. **A new experiment, EXP-0039.** The clone's three trials (HYP-0029 `retest`, HYP-0030 `rejection`, HYP-0031
   `nearest`) are run again under the new rule as **three new trials**; family O goes from 41 to **44**. Each
   verdict needs a fresh 30 trades and 20 sessions from the first session under the new rule, with the test of
   DEC-0030 section 6. `wt.options.review` reports the window apart (`no_oi`), and the nightly review prints and
   stores only its trade and session counts until the report is written.
4. **Effective first session: Wednesday 2026-11-18**, on the condition that the release is deployed to the host
   before that session's arm (09:25 New York). If it lands later, a one-line amendment to this record moves
   `SPREAD5_END` and `NO_OI_START` to the first session it runs, before that session's trades are viewed.
5. **EXP-0029 closes at 2026-11-17** with 9 sessions (2026-11-05 to 2026-11-17). Its trades never count toward
   EXP-0039. It cannot reach 20 sessions and so gives no verdict; it is kept as a record, as EXP-0028 was.
6. **The research arms end.** The change gives the control a new config hash from 2026-11-18, and DEC-0041 point 5
   stops each arm at the first session under another hash. All 14 arm trials (HYP-0034 to HYP-0047, EXP-0030) so
   end with at most 9 sessions. None can reach 20, so each closes with no verdict on its close date; they stay
   counted in family O. The owner accepted this cost. `wt.options.arms_verdict` keeps sessions from 2026-11-05
   open-ended, so the hash rule alone decides, as DEC-0041 wrote it.
7. **EXP-0037 (DEC-0054) is unaffected.** Its replay (`wt.options.dryrun`) prices the nearest strike from trade bars
   and never reads open interest, so its control behaves as before.

## Disclosure

- The author read, while finding the cause: the clone's decision lines for 2026-10-20 to 2026-11-17 (which gate and
  which floor refused which signal, counts only), its journal lines for 2026-11-16 and 2026-11-17, the pre-open
  pipeline checks, and the live chains above. No outcome of any refused signal was looked at.
- **The author saw EXP-0029's running figures.** The nightly review log of 2026-11-16 prints them, and it was read
  in this work; an earlier session of the same author had read them on 2026-11-16. The rule was not chosen from
  them: it follows from the refusal counts and live numbers above, and the owner chose it from three options before
  any figure under it can exist.
- A first draft scoped the change to contracts not expiring that day. An independent review found that the
  decision lines name the refusing floor, and the counts above showed that every past open-interest refusal was on
  a same-day contract; the owner then chose this rule.
- No backtest or replay of this rule was run.

## Not changed

- The owner's own trade rules on the dashboard (`dashboard/src/lib/contract-pick.ts` is the board's, and frozen).
- Robot B and every other desk.
