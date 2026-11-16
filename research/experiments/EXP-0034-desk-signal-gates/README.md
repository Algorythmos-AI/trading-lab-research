# EXP-0034: whether the desk's signal word picks the better enter-zone breaks, forward from the switch-on

- Decision: DEC-0051 (proposed 2026-11-13). Trial: HYP-0059 SIG-CONFIRMED, family O (total 36 with this one).
- **Design only.** Nothing here is a result. No signal, gate value or outcome exists when this was written, and no
  outcome of any board state, gated or not, has been worked out or viewed.
- Every frozen definition is in `config.yaml`: the signal word, the lifecycle, the four market gates (the market
  direction copied in words and numbers), the contract check, the log and its `dry` mode, the unit and its groups,
  the card numbers (frozen under DEC-0035 section 3), the outcome (EXP-0032's `outcome.after_fill`, by reference),
  the statistics, the generator and its test vectors, the seed, the read and the early ends.
- **The gates' numbers are not frozen yet.** `config.yaml` `parameters` holds the plan's candidates and the grids.
  DEC-0051's Amendment 1 freezes them once, by the rule DEC-0051 section 2 states, from at least 10 `dry` sessions,
  with no outcome read.
- The expiry rule is the owner's, decided on 2026-11-13: 1 to 5 sessions out, never the same day
  (`parameters.expiry_rule`).
- Start: the first counted session that opens after the signal switch first reads `log` in production (allowed only
  once the four preconditions below are met and Amendment 1 is in production). Its date is written here the same
  day. Never backfilled. Latest start date 2027-02-28: not started by then, the record lapses with no verdict.
- Close date: one year after the start date.
- Read: once, at the first of 100 scored confirmed breaks or the close date. Early ends give no verdict.

## Trial

| Trial | Hypothesis | Unit | Compared (a minus b) | Decided by |
|---|---|---|---|---|
| SIG-CONFIRMED | HYP-0059 | break, resampled by session | first enter-zone slot CALL or PUT minus WAIT or NO TRADE from a failed market gate, mean stock R | 95% session bootstrap above 0, both halves above 0 |

## Dates and commits (each written by the pull request or note that records it)

- DEC-0051 accepted: 2026-11-13. The close date follows from the window's start date (one year after it).
- `context.ts` code pin: 2026-11-13, #422 merged; `dashboard/src/lib/context.ts` at integration
  `c48d3477524131794cbab1fe85cc983134b96579`. The definition copied into `config.yaml` governs.
- Precondition 1, the per-slot range baseline in production, its commit: 2026-11-13,
  `3658d7d42c5a5f43fc10e6905f2b9786145a2d10` (#428): `flow.ts` `buildBaseline`, `BASELINE_V = 2` with `range_median`,
  released to `main` in #426 and unchanged through #436. In production: to confirm (written 2026-11-16). It is met on
  the session of the first stored baseline the owner sees reading `v: 2` with `range_median`; that date is written
  here, and the `dry` sessions Amendment 1 reads are those after it.
- Precondition 2, the read script merged, its commit: 2026-11-13, `8d9bb9aaf83c625e59fde359786bbc6e12033cbf` (#434).
- Precondition 3, the outcome code merged and frozen, its commit: 2026-11-13, `8d9bb9aaf83c625e59fde359786bbc6e12033cbf` (#434).
- Precondition 4, one full regular session stamped in production (board-feed stamps reading `sip`, sealed): not
  yet. Reported on 2026-11-13 by the owner: no stamp written since the open on 2026-11-12.
- Signal switch first at `dry` in production: not yet.
- Amendment 1 (the frozen numbers, the parameter hash, the signal-code hash) merged, and in production: not yet.
- Signal switch first at `log` in production: not yet.
- Window start date (the first counted session after that), and so the close date one year later: not yet.
- Signal switch first at `show` in production (signals first on the page; the same date goes into EXP-0033's
  `README.md`): not yet.
- "Signal confirmed" alert first switched on in production: not yet.
- DEC-0048's switch date (the report gives group counts before and after it): not yet.
- Engine identity checks (yes or no, with counts): 2026-11-16, `e-28344e769752` to `e-05b589ff4f1c` (the pre-dry
  defect fixes below), fixtures only: no, no fixture row differs (735 board cases, 2,205 rows; 84 evaluated slots,
  420 rows; `dashboard/test/validation/engine-identity.test.ts`, the old engine rebuilt byte-identical to the base
  commit's `trade-state.ts`). In the same test the only rows that differ are boundary touches: 4 of 4 constructed
  cases; 10,039 of 20,388 boundary scenes in a seeded sweep, 0 of its 19,612 other scenes, 0 of 20,000 scenes with
  many-decimal ATRs and 0 of 20,000 with five-decimal levels. The other half of the check, the last 10 logged
  sessions through both engines, is NOT done: the Mac cannot read the production records. DEC-0051 section 8
  requires it before this label reaches production; the owner or the host runs it. No `dry` session and no window
  had started, so it ends nothing.
- Defect fixes to the outcome or signal code before the read: none to the outcome code. To the signal code:
  - 2026-11-16, before any `dry` session, owner-approved (DEC-0051 section 8, precondition 3's defect-fix route), two
    defects found by the pre-dry validation (`dashboard/test/validation/logic-suspects.test.ts` cases a and d):
    (1) `dashboard/src/lib/trade-state.ts` `sideState`, the retest touch: a dip exactly 0.1 ATR from the line was not
    a touch in floating point (100.20 − 100.10 = 0.10000000000000853 > 0.1); when the level and the bar's low (high,
    for a put) are whole ten-thousandths, the dip is now taken in whole ten-thousandths and compared with the ATR
    exactly; any price with more decimals keeps the original floating comparison. (2)
    `dashboard/src/lib/contract-pick.ts` `judge`: an ask the ticket's sizing cannot take (not a safe whole number of
    cents, for example an ask of 1e300, on which `ticket.ts` `sizeTicket` throws) named no contract for the whole side
    (`no-chain`); it now fails that strike's premium check only and the other strikes are still judged. `ticket.ts`
    is unchanged. No parameter, threshold, rule or owner rule changed. `SIGNAL_CODE_HASH`
    `s-0ec9e5efd1e65790ca5f83e5ba845269ad2c3666b500c631d89f2cb7327f2345` to
    `s-44709694b261a3bceebdafe21cc15f9f58f49f2359b73122d493d6e54aca1a41` (the pin in
    `dashboard/test/signal-freeze.test.ts` moved with it); DEC-0044 `ENGINE_VERSION` `e-28344e769752` to
    `e-05b589ff4f1c` (of the two, only `trade-state.ts` is in the engine's code). The engine identity check is the
    line above. Comments in `signal.ts` corrected too (the chain's checked age is `contract.ts` `chainAge`; the
    lifecycle is counted at the slot's end + `CLOSE_GRACE_MS`): comments do not move the hash.
- Writer fixes before any `dry` session, 2026-11-16 (`signal-run.ts` and `desk-run.ts`, outside the hashed code), from
  a pre-dry validation: a run whose reads time out keeps the time to write its record; a signal write or a DEC-0044
  put that lands after its time limit is read back and counts as written only when the stored bytes are the run's
  own; a record whose flow answer is from another slot carries "flow is from another slot" in `unusable`; in `log`
  mode a record-level reason (the session's earlier records or the board-feed stamps not readable) gives the word
  NO TRADE; the lifecycle counts slots from the slot's end, as the board does; carried breaks keep a fixed key order.
  The checked age is unchanged: the chain's newest quote against when the answer was served (DEC-0051 section 2,
  `chainAge`).
- Early end, with its cause: none.

## Verdict

- Read once, by the read script, which writes its report into this folder and refuses to write over an existing one.
- The report is never shown on the site. After both reads, this one and EXP-0033's, the site may show its SAFE
  figures only: the counts, the estimate, its range and the verdict.
- Supported: the tag becomes "Stock test passed (HYP-0059); option result not tested". Anything else withdraws the
  words; the gates stay as plain facts.

## Readings fixed before the outcome code is frozen (2026-11-13)

Where the record leaves a choice open, the read script and the outcome code take these readings, written here before
any signal, outcome or bar of the window exists.

- Section 8, unit: a break's `brokeAt` is read from the scoring slot's signal record (the DEC-0044 rows carry none).
- Section 8, unit: a run of consecutive `enter_zone` slots whose first slot has no signal record is one `not_logged` break.
- Section 8, groups: a signal record that is there but does not parse, or a `dry` record, is `not_usable`.
- Section 8, groups: a group a or b break whose logged card has no entry, stop or T1 (or entry equal to stop) is `card_missing`, counted, not scored.
- Section 8, groups: the volume gate reading `not_yet` at the scoring slot is `gate_unavailable`.
- Section 8, read: the read takes the whole slot holding the 100th scored group-a break; later slots are not taken.
- Section 8, halves: the halves split all counted sessions in date order, not only those holding a scored break.
- Section 8, secondary: the option R25 range is reported as its minimum and maximum.
- Section 8, sensitivity: group b is re-weighted on the (name, window) cells both groups hold, with the share of group a those cells cover.
- Section 8, outcome: an `entry_open` already at or beyond T1 exits at `entry_open` (`entry_beyond_t1`); one already at or beyond the stop exits at `entry_open` (`entry_beyond_stop`).
- Section 8, outcome: R is rounded to 2 decimals half away from zero.
- Section 8, outcome: the entry bar is the first 2-minute bar starting at or after the scoring record's `evaluated_at`.
- Section 8, early ends: a stamp gap over 10 minutes across a deployment change is judged within a session only, between two known, different deployments; a deploy between sessions is not one (each stamp must still read `sip`).

## Note on DEC-0052 (added 2026-11-17)

DEC-0052, proposed on 2026-11-17, replaces the engine label config.yaml pins at registration with the label of the
release that ships its section 1, before this experiment's window starts, once it is accepted. The change was chosen
for consistency with HYP-0029's registered rule, not on any outcome of this experiment, none of which exists; no dry
session has run. The identity check's answer and counts for that change are written here the day it ships. The text
above is otherwise unchanged.

Viewed before this note: one owner trade entered on the board's old retest and its result, the clone's decision lines for that session, and the clone's cumulative HYP-0029 figures (DEC-0052, "What has already been seen").
