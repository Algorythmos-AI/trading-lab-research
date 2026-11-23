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
  many-decimal ATRs and 0 of 20,000 with five-decimal levels. The other half of the check, the logged sessions
  through both engines, was run on 2026-11-17, after this label had reached production (see the line below): no, no
  row differs (582 slots, 2,304 names, 4,608 evaluation rows). No `dry` session and no window
  had started, so it ends nothing.
- Engine identity check over the logged production sessions (DEC-0051 section 8), run 2026-11-17 on the Mac with
  `dashboard/scripts/identity-collect.mjs` and `dashboard/test/validation/engine-identity-sessions.test.ts`, engines
  pinned by commit, oldest first: `343a032` (`e-28344e769752`), `8cd5ff0d` (`e-05b589ff4f1c`), `eaa2ab52`
  (`e-d6053c7fdd0a`), `964bfe3` (`e-593cd517f8d5`).
  - **Sessions:** 3, all the logged production sessions there are (2026-11-12 to 2026-11-16), not the 10 section 8
    names; 582 slots, none skipped, all logged under `e-28344e769752`.
  - **Late for two labels:** Release #456 put `e-05b589ff4f1c` and `e-d6053c7fdd0a` into production before this run.
    Section 8 asks for it first. The answers below are as expected, so nothing is undone, but the order was broken.
  - **Inputs check:** the logging engine rebuilt the rows it logged in 514 of 582 slots. 121 slots used the day's
    data limit. The 68 that differ are not explained here; they bound how exactly a replay stands for production.
    - **Explained (2026-11-17, a later run of the same 3 sessions):**
      - **65 slots: the day's limit.** Their record says it was used, and every row it holds is no trade. The replay
        has no journal, so the limit read as not used. With the record's limit applied (the replay tool's fix), they
        match, and the check rebuilds 579 of 582 slots.
      - **3 slots: the day's high and low.** The engine takes them from the snapshot read at run time, about 110 s
        after the slot's end, and the record holds no prices. In 2 of them the next bar had passed target 1 or a new
        low, so production read missed where the rebuild reads enter_zone. This is the conservative direction the code
        states, never toward an entry.
      - **Differing names in slots with the day's limit used, where the board drew no trade:** none, 15 of 48 and 350
        of 815 for the three changes below. The rest of each answer is unchanged.
  - **The answers and counts are on each change's line below.**
 none to the outcome code. To the signal code:
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
- A rule change to the signal's code before any `dry` session: 2026-11-17, DEC-0052 (accepted by its own pull request,
  #453), not a defect fix.
  - **What changed:** the board's break and retest completes as the options clone's retest does: a touch within 1.0
    two-minute ATR, then a confirming close. ENTER holds for two slots, ended by a run past the confirming close, then
    reads missed "slot". The card's "Break and hold" wording follows.
  - **Files:** `trade-state.ts`, `trade-now.ts`, `entry-checks.ts` (`RETEST_WITHIN_ATR`) and `focus-plan.ts`.
  - **Hashes:** `SIGNAL_CODE_HASH` `s-44709694b261a3bceebdafe21cc15f9f58f49f2359b73122d493d6e54aca1a41` to
    `s-065118e5ffe27eee3b520c817f045160327c9b6d9c14b4fa1e782cc289cc41e3` (the pin in
    `dashboard/test/signal-freeze.test.ts` moved with it). DEC-0044 `ENGINE_VERSION` `e-05b589ff4f1c` to
    `e-d6053c7fdd0a`.
  - **The identity check on the fixtures: rows differ, as a rule change should.** The old engine (integration
    8cd5ff0d) and the new one ran on the original fixture inputs, before the fixture morning was moved for the new
    rule, with rows matched by name.
    - **Board:** 21 of 2,205 rows differ: QQQ at the scripted step 3, in every edition and quote set.
    - **Evaluation:** 14 of 420 rows differ: the QQQ call at the step-3 slot.
    - **What differs:** all are enter_zone → get_ready. No `brokeAt` and no card number differs.
    - **The fixture morning** was then moved one price (QQQ at 10:26) so the scripted story still has a confirmed
      retest. On the moved fixture the two engines differ in wording only.
    - **The re-based check:** `dashboard/test/validation/engine-identity.test.ts` is re-based on `e-d6053c7fdd0a`. It
      pins 52 of 312 bar states differing over the 15 retest vector sessions, where the new engine matches the
      clone's first signal and the old one does not.
  - **The identity check on the logged sessions (2026-11-17, after release): yes, rows differ, as expected.** 48 of
    2,304 names differ, all in a side's state: enter_zone → get_ready 35, enter_zone → missed 13. No `brokeAt`
    differs; 8 differ in card numbers. 74 of 4,608 evaluation rows differ; the evaluation's status differs in no slot.
  - No `dry` session and no window had started, so it ends nothing. Amendment 1 reads only `dry` sessions recorded
    under the new hash.
- A rule change to the signal's code before any `dry` session: 2026-11-17, DEC-0053 (accepted by its own pull request,
  #458), not a defect fix.
  - **What changed:** after a side's break fails (a completed close back at or through the level), the side is locked
    for the rest of its entry window: to 13:00 when the failing bar ends at or before 13:00 on a full day, else to the
    flat time (a half day's flat time on a half day). While locked it reads plan off on the failed break; a break made
    inside the lock is not counted, and once the lock ends it reads watch until a fresh break. A confirmed retest on
    bars that do not cover the session from its open reads GET READY ("confirm on your chart"), never ENTER. The row
    says the lock ("Failed at <time>: no <side> until <time>") beside the other side's line, and the board's drawn
    headline says it too while an alternative trigger is live.
  - **Files:** `trade-state.ts`, and `trade-now.ts` (`rowView`'s headline only).
  - **Hashes:** `SIGNAL_CODE_HASH` `s-065118e5ffe27eee3b520c817f045160327c9b6d9c14b4fa1e782cc289cc41e3` to
    `s-ed25522ded279c218690d89ce110d996e607624d1ea270abf9377dc062ce9b44` (the pin in
    `dashboard/test/signal-freeze.test.ts` moved with it). DEC-0044 `ENGINE_VERSION` `e-d6053c7fdd0a` to
    `e-593cd517f8d5`. `config.yaml`'s `code_read.engine` pin moves to the new label (DEC-0053's amendment to this
    experiment).
  - **What was viewed:** what DEC-0053 lists under "What has already been seen": the owner trade DEC-0052 names, that
    session's 2-minute bars and the board's recorded states, and that session read by DEC-0052's rule. The change was
    chosen on the setup's logic and that session, not on any outcome of EXP-0034, none of which exists.
  - **The identity check on the fixtures (DEC-0051's, run as written): no row differs in a state, `brokeAt` or card
    number.** The old engine (integration 6bee358, `e-d6053c7fdd0a`) and the new one ran on every fixture input.
    - **Board:** 0 of 2,205 rows differ (735 cases). 63 cases differ in words and display fields only: SPY's failed
      break at the scripted steps 3 to 5, in every edition and quote set, now worded as its lock (the line and the
      drawn headline), with `failedAt` and `lockEnd` beside it.
    - **Evaluation:** 0 of 420 rows differ (84 slots).
    - **The re-based check:** `dashboard/test/validation/engine-identity.test.ts` is re-based on `e-593cd517f8d5`. It
      pins 6 of 312 bar states differing over the 15 retest vector sessions, in the two sessions with a failed break;
      in one of them the lock removes the clone's signal on the re-break (DEC-0053's stated departure from the clone).
  - **The identity check on the logged sessions (2026-11-17, before release): yes, rows differ.** 815 of 2,304 names
    differ. 668 differ in a side's state: missed → watch 294, missed → plan_off 200, plan_off → watch 132,
    get_ready → plan_off 29, enter_zone → plan_off 10, enter_zone → watch 2, get_ready → watch 1. All 815 differ in
    `brokeAt`, and 333 in card numbers. 1,010 of 4,608 evaluation rows differ; the evaluation's status differs in no
    slot.
    - **Traced:** every differing name is one of 6 sides whose break failed (3 sessions). Each difference is the rule
      as DEC-0053 states it:
      - while locked, a side reads plan_off and gives the failed break's `brokeAt`;
      - once the lock ends it reads watch, with no `brokeAt`, until a fresh break;
      - the name's card follows the side its row now shows.
    - **What the lock removed:** 10 enter_zone slots inside a lock. The 2 that become watch come after the flat time.
    - **For the owner:** a break that holds for hours and then closes back counts as failed (one case, failing at
      14:10, locked to 15:10). Separately, `e-d6053c7fdd0a`, now in production, gave enter_zone in a slot after the
      flat time in one case. That predates the lock and is not judged here.
    - **What was viewed:** the board states, levels and times of those 3 sessions under the two engines. No outcome
      of this experiment was viewed; none exists.
  - No `dry` session and no window had started, so it ends nothing.
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

## Note on DEC-0053 (added 2026-11-17)

DEC-0053, proposed on 2026-11-17, replaces the engine label config.yaml pins (already to be replaced by DEC-0052's)
with the label of the release that ships its section 1, before this experiment's window starts, once it is accepted.
The change was chosen because a failed break is a warning about that side, not on any outcome of this experiment, none
of which exists; no dry session has run. The identity check's answer and counts for that change are written here the
day it ships. The text above is otherwise unchanged.

Viewed before this note: the owner trade DEC-0052 names, entered on a side the board had re-armed after a failed break
at the same level, and its result; that session's 2-minute bars and the board's recorded states; that session read by
DEC-0052's rule as written; everything DEC-0052 lists as seen (DEC-0053, "What has already been seen").

## DEC-0072 (proposed 2026-11-23)

- Once it is accepted and its code is merged, the engine pin is replaced by that release's label, before this
  experiment's window starts.
- No `dry` session and no window had started on 2026-11-23, so it ends nothing.
- A row it pauses never reaches `enter_zone`, so it never enters this experiment's unit.
