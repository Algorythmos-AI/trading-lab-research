# DEC-0073: Gap Hunter's kill test: execution stops that carry over, and what its date stop means

- **Status: PROPOSED on 2026-11-22 at 18:30 ET**, the evening before Gap Hunter's first session (2026-11-23). The
  owner accepts it by merging it.
  - The numbers and lines marked **(set here)** are this record's choice and are his to change before he accepts it.
  - Its code (section 3) comes in a later pull request, and nothing changes on the host until a release carries it.
- **Amends:** DEC-0066 section 4, the stock desk's stop rule. It adds stops and fixes the reading of the date. It
  removes nothing: the −6.0R line, the 30-trade review and 2027-03-31 stand as written.
- **Does not amend:** DEC-0068 (the rule) or HYP-0071 (its measure, interval and "too few" line).
- **Trials:** none. No rule is added and no result is read; the count stays at 87, family S at 3.

## Disclosure

- **No Gap Hunter trade exists.** Checked on 2026-11-22 at 18:16 ET:
  - the host holds no stock-desk journal;
  - the Mac's has one row and no fill;
  - HYP-0071 trades from the session of 2026-11-23 (DEC-0066's note of 2026-11-22).
- **What was seen.** The only Gap Hunter numbers seen are EXP-0053's before-switch-on counts: sessions, primaries,
  orders, reached triggers and fills. They hold no R and no price.
- **The forward ledger.** The ledger of the frozen trials had been seen before (DEC-0066 "Disclosure").

## Why

The stop rule of DEC-0066 section 4 has three triggers: −6.0R cumulative, a review at 30 trades, and 2027-03-31.
Checked against how often the desk can trade:

- **The rate.** In 40 morning pools (2026-09-01 to 2026-11-20) the rule's entries would have filled 3 times
  (`before_switch_on_counts.json`). That is 0.075 a session, and the 95% upper bound of a count of 3 is about 0.19.
- **The trades.** There are 87 sessions from 2026-11-23 to 2027-03-31, so the desk can be expected to close:
  - about 6.5 trades at the counted rate (90% range 3 to 11);
  - about 17 at the upper bound (10 to 24).
- **The simulation.** `research/experiments/EXP-0053-gap-hunter-paper-book/kill_power.py`, 4,000 runs a case.
  - The R of a trade is a stated model, not a measured one: a loser −1.05R, a scratch +0.5R, a runner +2.5R, with
    standard deviation about 1.26R.
  - Each mean is reached by moving the weights, so a loser never loses more than its stop.
  - The script also prints a second model, where every value moves instead; the tables give its result in brackets.

By 2027-03-31, at the counted rate (about 6.5 trades):

| If the rule's true mean R a trade is | −0.50R | −0.25R | 0R | +0.25R |
|---|---|---|---|---|
| the −6.0R line fires | 16% (25%) | 7% (11%) | 3% | 1% (0%) |
| the 30-trade review is reached | 0% | 0% | 0% | 0% |
| a sequential test (SPRT, 0R against −0.5R, α 5%, power 80%) fires | 0% (2%) | 0% | 0% | 0% |

At the upper bound of the rate (about 17 trades):

| If the rule's true mean R a trade is | −0.50R | −0.25R | 0R | +0.25R |
|---|---|---|---|---|
| the −6.0R line fires | 77% | 45% | 21% | 5% |
| the 30-trade review is reached | 0% | 0% | 0% | 0% |
| the sequential test fires | 16% (24%) | 4% | 1% | 0% |

- **What the numbers mean.**
  - At about 6 trades the standard error of mean R is about ±0.51R.
  - Measuring it to ±0.15R takes about 70 trades.
  - The sequential test needs about 35 trades on average to decide even when the rule is bad.
- **The conclusion.** No test of R, fixed or sequential, can tell a winning rule from a losing one by the stop date,
  even at the upper rate. The date fires first in nearly every case, and the answer it can give is "too few"
  (HYP-0071).
- **The −6.0R line** is a loss cap (6% of the US$600 book), not a test, and it stays one.
- **A sequential test is not adopted.** At the counted rate it would almost never fire.
- **Two gaps, read in `wt.live.runner_s` at `origin/integration`.**
  - **Faults stop only the session they happen in.**
    - A short is journaled and paged, and never covered.
    - A position left at the close is journaled `END_OF_DAY_NOT_FLAT` and paged.
    - At the next arming the desk adopts and sells any long it holds, and pages a short.
    - None of these turns entries off: the arming refusals are the record, the switched-on trial, the shadow
      host, the lease, disk, account, calendar, virtual-account state, stop-rule and scan-input checks. The only stop that carries over is the stop rule's latch.
  - **The date stop has no reading.** Nothing says what 2027-03-31 means with about 6 trades. Left open, it is
    decided after the P&L is seen.

## 1. Execution stops (new)

These can be seen every session, whatever the trade count: they say the desk is not doing what it was built to do.
Each one latches the desk's virtual account, as the stop rule does (`wt.risk.virtual_account`):

- entries stay off, and exits keep running;
- the latch reason names this record;
- only a decision record clears it: the reset (`wt.risk.virtual_account.reset_latch`) asks for a record id. The
  desk has no owner command for it yet (`make reset-latch` clears only the retired QQQ book); section 3 adds one.

| Stop | Fires when |
|---|---|
| X1 short | the desk's account holds a short position at any poll **(set here)** |
| X2 not flat | after the close the desk holds a position that has no resting GTC stop **(set here)** |
| X3 unprotected | during the session a position the desk owns has no resting stop at two polls in a row **(set here)** |
| X4 off-rule entry | an entry in a name other than the session's journaled primary, or a second entry in one session **(set here)** |
| X5 stop slippage | two stop exits, each filled more than 0.5R under its stop price **(set here)** |

- **X2 is narrower than the `END_OF_DAY_NOT_FLAT` page, on purpose.**
  - A halted name may stay overnight on its GTC stop and leave at the next open: that is the desk working as
    designed (DEC-0066 section 3), and it pages but does not latch.
  - A failed after-close read pages but does not latch either. X2 fires only on a position read, after the close,
    that shows shares with no stop.
- **X3's exception.** A stop held under DEC-0071 (an exit that cancelled it and is asked again) does not count.
  Neither does the poll during which the desk itself replaces a stop.
- **X4.** The code already refuses both cases: the primary is read once and kept in the journal, and `gap_done`
  ends the day after a fill. The stop is for the code being wrong.
- **X5.** It counts within the book, not within a day. One fill through the stop is the risk of these names
  (halts, gaps); a second says the stop cannot be relied on at this size.
- **Deliberately left out.** The entry fill against the quote has no stop of its own: the registered collar
  already refuses an entry more than 10% of R over its trigger. The execution measures of EXP-0053 report it.

## 2. What 2027-03-31 means

- **Before the date.** The date stop fires as written: entries latch off.
- **At the date with fewer than 30 closed trades.** This is the expected case. The result is **too few**, as
  HYP-0071 defines it. The record written at the date must not call the rule passed or failed on its R.
- **That record then chooses one of two:**
  1. **Extend** the same rule, unchanged, to 30 closed trades or 2027-12-31, whichever comes first
     **(set here)**. Allowed only when:
     - no execution stop of section 1 is latched, or each one that fired was closed by a record that fixed its cause;
     - and the −6.0R line has not fired.
     
     The trades so far count towards the 30.
  2. **Retire** the rule.
- **The choice may not depend on R** beyond those conditions. A rule changed in any way is a new trial, and its
  trades are counted apart.
- **At 30 closed trades or more, before the date or after an extension.** The review of DEC-0066 section 4 applies
  as written: the stop fires when the 95% bootstrap upper bound of mean R is below zero.

## 3. What has to be built (a later pull request, then a release)

- `wt.live.runner_s` latches the virtual account on X1 to X5, with a reason that starts with the stop-rule prefix and
  names DEC-0073.
- It pages once, using the alert text of each fault as now.
- It journals `execution_stop` with the stop's id and counts. It never journals a symbol in the latch reason.
- An owner command clears the desk's latch with a record id (`make reset-latch-s REASON=...`, on `var/smallcap/`), as
  `make reset-latch` does for the retired QQQ book.
- The weekly scorecard prints where X3 and X5 stand.
- **Tests, each failing without its code:**
  - each stop latches, and the next session refuses entries while exits still run;
  - a halted name on its GTC stop overnight does not fire X2;
  - a stop held under DEC-0071 does not fire X3;
  - the latch clears only with a record id.

**Until it is built.**

- X1 and X2 page today. On either, the owner sets `var/smallcap/KILL`, which keeps entries off and exits running,
  and this record's reading stands.
- X3, X4 and X5 are not visible to the owner today: X3 shows only as a reconcile line in the journal, and X4 and X5
  need the journal read. Until section 3 is built they are checked by hand in the weekly review. That is a known gap.

## Not adopted

- **A sequential test on R.** See "Why".
- **A lower trade count for the review.** HYP-0071's "too few" line is 30; lowering it would make the review fire
  on noise.
- **Tighter loss lines** (for example −3R). At the counted rate a −3R line would stop a break-even rule in about one
  run in four (25%, `kill_power.py`); it would measure luck, not the rule.
