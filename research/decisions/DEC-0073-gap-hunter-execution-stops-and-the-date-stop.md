# DEC-0073: Gap Hunter's kill test: execution stops that carry over, and what its date stop means

- **Status: ACCEPTED on 2026-11-22 at 18:50 ET.** The owner merged it (#600, 5cf8997f) the evening before Gap
  Hunter's first session (2026-11-23). It was proposed at 18:30 ET.
  - He took the numbers and lines marked **(set here)** as written.
  - Its code (section 3) is the pull request that carries the note of 2026-11-22 below. Nothing changes on the host
    until a release carries it.
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

## Notes

### 2026-11-22: how the code reads section 1

Written at 20:00 ET with the pull request that builds section 3, before Gap Hunter's first session: no Gap Hunter
trade exists, so none of these readings was chosen with a result in view. Each is **for the owner to confirm or
change**.

- **Where it lives.** `wt.risk.execution_stops` reads the five stops from the desk's own journal. The numbers are
  in `config/risk.yaml` (`S.execution_stops`, with this record's id). `wt.live.runner_s` asks at arming, and again
  each time it journals a row a stop reads, so a fault latches the book in the session it happens in.
- **The latch.**
  - It is set as the stop rule's is: entries off, exits still managed.
  - A resting entry is cancelled at the next poll (`entry_cancelled`, why `latched`), as the kill file does.
  - The reason starts with the stop-rule prefix and ends with this record's id. It never names a symbol.
  - `make reset-latch-s` clears it only with another record named in the reason, and refuses while `paper-s` or its
    runner holds a lock.
  - It pages once, when it latches (priority 5), as the stop rule does: not again at each arming while latched. The
    journal says each time (`execution_stop`, `new_latch`).
- **After a reset.** Only journal rows after the last reset of a latch this record set count, so X5's count starts
  again. A reset of another latch (the stop rule's) does not restart them.
- **A fault while the book is already latched** (by the stop rule) keeps the earlier reason. It is journaled
  (`execution_stop`) and latches again at the next arming once the other latch is cleared.
- **X1.** A `short_position` row at any poll, or a short after the close.
- **X2.**
  - After the close, a long whose shares are not all covered by this desk's resting GTC stops.
  - A position over the hard caps, left for the owner (DEC-0066 section 3, item 5), is not the desk's and does not
    count.
  - A position that cannot be read is unknown and does not count. It still pages as before.
- **X3.**
  - Read at the start of each poll: the position as the last poll left it, against the shares this desk's resting
    stops would sell (`OMS.stop_cover`, reconcile's measure).
  - A stop the desk replaces in one poll counts once, never twice. A DEC-0071 hold does not count. A failed read
    counts nothing.
  - Read first and in its own block, so a protect step that raises cannot hide it. Found by its test: a stop the
    broker refuses at every poll made reconcile raise before a later check could run.
  - The manager's other deferrals do not trip it on their own. A trailed stop whose cancel is unconfirmed twice
    running and then lands shows bare at one poll start, and reconcile puts a stop back before the next (a test
    holds this). A first-target sale whose cancel is unconfirmed leaves half the shares under a resting limit sale;
    if reconcile cannot settle it at two polls in a row, that counts, and is meant to.
  - Once a stop has fired, `unprotected` rows are no longer journaled that session.
- **X4.**
  - Read only on Gap Hunter days, those with a `gap_primary` row.
  - The day of an entry is the date in its trade id.
  - An entry on a day with no primary counts. An adopted orphan does not.
  - The same trade journaled twice is one entry.
- **X5.**
  - From the stop order's own fill: `stop_fill` and `stop_price`, journaled on `trade_closed` from this release.
  - The exit price on that row is the average over every sell of the plan, the first-target sale included, so it
    cannot say how far the stop slipped.
  - The slip is measured against the stop's price when it filled (a trailed stop counts from where it was), in R of
    the stop the trade entered with.
  - Trades booked before this release carry no stop fill and are not counted.
  - **The line is small in cents.** These entries carry small risk. On the gap fixtures the trigger is 5.06 and the
    stop 4.94, so R is 12 cents and 0.5R is 6 cents. Two stop-outs that each slip 6 cents (common on a US$5 name)
    would have latched the desk. The owner set a floor (next note).
- **The overnight stop.** The after-close step asks each position's stop on its own, so one that fails no longer
  stops the checks for the others (`overnight_stop_failed`).
- **The scorecard** prints the stock desk's stop rule and these stops after section 5: the most unprotected polls in
  a row, and the stop fills over the line, since the last reset.
- **No false latch on a normal session.** The replay tests of both rules (`test_runner_s.py`,
  `test_runner_s_gap.py`) now refuse any `execution_stop` or `unprotected` row unless a test means one. All of them
  pass unchanged.

### 2026-11-22: X5 gets a floor of US$0.10 a share

Asked in chat at 20:30 ET whether to keep X5 at 0.5R or add a floor, the owner answered "Add a 10c floor". No Gap
Hunter trade existed.

- **X5 now reads:** two stop exits, each filled under its stop price by more than the larger of 0.5R and US$0.10 a
  share. Everything else in section 1 stands.
- **Where it lives.** `config/risk.yaml` `S.execution_stops.stop_slip_min_usd: 0.10`.
- **Its effect.**
  - On an entry with 12 cents of risk, a slip must pass 10 cents, not 6.
  - On one with a dollar of risk, 0.5R (50 cents) still sets the line.
  - A test holds both cases (`test_x5_a_small_r_slip_counts_only_past_the_ten_cent_floor`).
