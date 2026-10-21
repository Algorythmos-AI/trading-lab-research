# DEC-0034: The options clone trades each focus name's nearest expiry

- **Status: PROPOSED on 2026-10-21.** The owner asked on 2026-10-21 for the clone to trade the four focus names
  every day. One question is still open for him (below). Once he answers, the record and its registry row move to
  ACCEPTED in the same pull request, and merging that pull request accepts it.
- **Written before any paper result of the new trial exists.** No contract expiring after its trade's session has
  ever been traded by the clone: until now it could only buy same-day contracts. The author has not looked at the
  clone's paper P&L for HYP-0029 or HYP-0030 while writing this record.
- **Amends** DEC-0030 (section 1, "one same-day call or put") and DEC-0032 (rule 2, "a contract expiring today").
  Each amendment is one rule: which expiry a name trades. The setups, the gates, the entry and exit numbers, the
  limits, the 15:10 flatten and the verdict's method are unchanged. Nothing is held overnight.
- **Depends on:** DEC-0005 (every configuration tried counts as a trial) and DEC-0028 (family O).

## Why

Single stocks list same-day contracts on some weekdays only, while SPY and QQQ list one every session. Under
DEC-0032 a focus name without a same-day contract is dropped, and SPY and QQQ fill the gap. On Tuesday 20 October
three of the four focus names were dropped this way, and the clone traded SPY and QQQ instead of the names the edition
had picked. On Wednesday 21 October all four had same-day contracts. Which names the clone trades should depend on
the edition, not on the weekday.

## Decision

1. **Expiry policy** (`config/options_clone.yaml`, `names.expiry`, replacing `same_day_expiry_only`):
   - `same_day`: the DEC-0032 rule. A name without a contract expiring today is dropped.
   - `nearest` (**the new default**): a name trades its nearest listed expiry on or after today. If a contract
     expires today, that is the nearest, and nothing changes for that name. Otherwise the clone takes the first
     listed expiry within `names.nearest_within_days` calendar days (**7**). A name with no expiry inside that
     window is dropped, as before.
2. The expiry is chosen once a day, at arm, from the broker's paper contract listing (`/v2/options/contracts`).
   The listing is first read for today. Only when it is empty is it read again for the range from tomorrow to the
   window's end. Every contract the clone may buy that day has the chosen expiry.
3. **The top-up stays.** SPY and QQQ are still added, in that order, when fewer than two names remain. Under
   `nearest` this happens only when a focus name has no expiry within the window, or its levels cannot be read.
4. **The journal shows which expiry each name trades:** the `names` event carries `expiries` (name to date) and
   `policy`.
5. **Unchanged for every expiry:** the trigger, the gates (trend, extension, room, reach, shock, events), the
   contract filters (delta floor 0.35, or 0.40 from 13:30; ask at most $2.00; spread, volume and open-interest
   floors), the exits (25% premium stop, breakeven after +25%, 50% target, 5-minute time stop, next level), the
   limits in `config/risk.yaml` key `O`, and the 15:10 flatten. A contract with days left is still sold before
   15:10 the same day.

### Time to expiry for modelled greeks (`wt.options.chain.with_model`)

The feed sends no delta or implied volatility for same-day contracts, so the clone works them out from the quote's
mid (DEC-0030 section 4, built 2026-10-21). The time to expiry it uses becomes **the calendar minutes from now to
the close on the contract's own expiry date**: 16:00 New York, or 13:00 on a half day. Before this change it was the
minutes to today's close, which is the same number for a same-day contract.

**Why calendar time and not trading time:**
- `wt.options.bs` annualises on a 365-day calendar year (`bs.years`). Quoted implied volatilities are on the same
  basis.
- The delta floor is the only gate that reads the modelled numbers. A quote's price fixes the product of volatility
  and the square root of time, so the delta solved from one price barely moves when the clock convention changes.
  What matters is solving the volatility and the delta with the same clock, and both use `bs`.
- Trading time would count a weekend as zero. That would mis-scale the implied volatility the reach gate reads for
  a contract expiring after a weekend.

The reach gate reads the implied volatility of the contracts the name trades. For a multi-day expiry that is the
term volatility to that expiry, not the same-day one. The gate still measures only what is left of today's session.

## Trials and the verdict

- **One trial is added: HYP-0031 (`OC-NEAREST`).** A trade on a contract that expires after its own session is a
  different instrument: more premium for the same delta, less gamma and slower decay. Its return on premium is
  read apart from same-day trades. Both setups are pooled in this trial: the question is whether the rulebook still
  pays when the contract has days left, not which setup pays more. Splitting it by setup would add two trials.
- Family O goes from 14 to **15** (`config/trial_registry.yaml`, row `DEC-0034`, proposed until this record is
  accepted).
- **Which trial a trade counts toward** (`wt.options.review.trial_of`): a trade whose contract expires on its own
  session counts toward its setup's hypothesis (HYP-0029 or HYP-0030), as before. A trade whose contract expires
  later counts toward HYP-0031 only. No trade counts twice.
- **`since`:**
  - HYP-0029 and HYP-0030 keep "the first session of job paper-o". Every trade booked so far was same-day, so none
    moves to another trial. From this rule on, the same-day trials see only the same-day names, while the
    multi-day names go to HYP-0031. The set of names changes, as under DEC-0032, but no number does.
  - HYP-0031 starts at **the first session of job paper-o that runs a release containing this rule**, as the
    `deploy` event in the host's journal dates it. Trades before that session cannot belong to it.
- **The verdict** for HYP-0031 is DEC-0030 section 6 unchanged: at least 30 trades and 20 sessions, a 95% bootstrap
  range of the mean by session, and both halves. Its report goes to EXP-0026, written once by
  `scripts/options_clone_verdict.py --trials nearest`.

## Open question for the owner (before this record is accepted)

**Do the delta floor (0.35, or 0.40 late) and the premium exits (25% stop, 50% target, breakeven after +25%) stay
as they are for contracts with days left?** This record assumes **yes**: no number changes, so the only new thing
being tested is the expiry. Expected effect: a contract with days left has more time value. At the $2.00 cap and
the 0.35 floor, fewer contracts will pass, so expect more `premium-over-cap` and `delta-below-floor` refusals on
those names. The journal counts each refusal by reason. A premium move of 25% also takes a larger stock move on a
multi-day contract than on a same-day one, so stops and targets will be hit less often before 15:10. Changing a
number later would be a new record and new trials.

## What this record does not do

It changes no setup, gate, entry or exit number, limit, time, or probation rule. It does not hold a position past
15:10. It does not change the verdict of HYP-0029 or HYP-0030, except that their trades are now same-day by
definition.
