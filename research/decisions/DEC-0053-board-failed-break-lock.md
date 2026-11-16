# DEC-0053: After a side's break fails, the Options desk's board says no ENTER on that side for the rest of the entry window

- **Status: ACCEPTED on 2026-11-17.** approved_by: owner. Proposed on 2026-11-17 (#458) and accepted by the owner's
  merge of the pull request that changed this line.
  - **The DEC-0035 point 4 exception was approved by the owner, in chat, on 2026-11-17** (section 6):
    `approved_by: owner`.
  - The owner asked for this accepting change on 2026-11-17. The merge is the acceptance.
  - Acceptance registers HYP-0061 and EXP-0036 and fixes the definitions below. It changes no code and starts
    nothing: the board's change is a later pull request.
- **Not written before every affected result was viewed, and it says so.** What the author had seen is set out under
  "What has already been seen". That is why DEC-0035 point 4's statement cannot be made (section 6). Going ahead is
  the owner's explicit decision, not a rule this record can satisfy on its own.
- **Amends:**
  - **DEC-0035 point 4:** the card's trigger (section 6).
  - **DEC-0052 section 1:** a confirmed retest on a locked side is not an enter zone.
  - **DEC-0045 section 3** and **DEC-0050 point 3:** the frozen numbers carried into EXP-0033.
  - **DEC-0051:** its "Unchanged: the board's states and its engine" holds except for DEC-0052 and this record.
  - **EXP-0033** `frozen_numbers`, and **EXP-0034**'s engine pin, each before its window starts.
  - **DEC-0044's note:** its engine table gets a row at release (no dated note).

  Each amendment is worded under "Amendments to earlier records". A dated note in each amended record except DEC-0044
  points here.
- **Registers** HYP-0061 (BOARD-FAILED-BREAK-LOCK) with EXP-0036 (section 5): one new trial in family O, which
  becomes **38** (section 7).
- **Experiment:** EXP-0036. **Hypothesis:** HYP-0061.
- **Unchanged:**
  - the owner's nine trade rules (`dashboard/src/lib/trade-rules.ts`);
  - the card plan's entry, stop and targets (DEC-0035);
  - DEC-0052's retest: the touch, the confirming close, the two ENTER slots and "one confirmation per break";
  - the board's failed break, sweep and rejection triggers: the alternative trigger a failure at L arms in the
    opposite direction (`SideState.alt`, HYP-0046 and its kin) is still worked out and shown;
  - the levels the board watches: the focus card's ceiling and floor;
  - the options clone and everything DEC-0030 freezes. The clone takes the most recent break (`setups.py` line 58)
    and has no such lock: this record departs from it on purpose (section 4).
- **Depends on:** DEC-0030, DEC-0035, DEC-0042, DEC-0043, DEC-0044, DEC-0045, DEC-0050, DEC-0051, DEC-0052.

## Why

The board takes the most recent break at a level (`trade-state.ts`, the break search in `sideState`). So when a
break fails (a 2-minute close back through the level, the board's plan off), the next close beyond the level is a
new break. The side reads GET READY again at once, and under DEC-0052 can reach ENTER a few bars later. Nothing
records that the level has just failed.

**An example with made-up numbers.** A call's ceiling is 50.00.
- A bar closes 50.30: the break.
- Two bars later a bar closes 49.85: back under the ceiling, plan off.
- The next bar closes 50.20: a new break. Under DEC-0052 the side can confirm a retest within a few bars and say
  ENTER.

**Why that ENTER is a poor one.** In break-and-retest trading a close back through the level is a failed break. It
traps the traders who followed the first break. If the failure says anything, it says the opposite direction, not a
second try in the same one. The board already arms the opposite direction on a quick failure (within 3 bars, its
failed-break trigger). It does not yet stop the same side from arming again.

**Why DEC-0052 alone does not settle it.** DEC-0052's confirming close makes a re-break harder to confirm, not
impossible: a re-break a few bars after a failure can confirm on an ordinary 2-minute close.

**Why the rest of the entry window, not the rest of the session.** The owner's entries fall into windows: up to
11:30, and 13:00 to the flat time on a full day (DEC-0043, the owner's rules). A failure says something about that
stretch of trading. A whole-session lock would also block an afternoon setup on a level that failed in the morning,
at a cost the lab cannot yet measure. EXP-0036 measures what the lock removes.

**The reason for this record is the setup's logic, not a result.** One trade is not evidence. Section 5 measures it
once, on sessions already recorded.

## What has already been seen

1. **The owner trade DEC-0052 names.** It was entered while the board showed ENTER on a side that had failed a break
   at the same level earlier in the session, and it closed at a loss. Its details are the owner's (PRIVATE) and are
   not recorded here.
2. **That session's 2-minute bars and the board's recorded states**, read to find out why the board said ENTER.
3. **That session read by DEC-0052's rule as written**, without running its code. Under DEC-0052 the re-break did not
   confirm, so DEC-0052 alone removes that ENTER. But it did not confirm by a narrow margin: one 2-minute close a few
   cents different would have confirmed it. This record was chosen because of that margin.
4. **Everything DEC-0052 lists as seen**, since this record follows it.

No outcome of EXP-0033, EXP-0034, EXP-0035 or EXP-0036 exists: no window has started, no `dry` session has run, and
EXP-0035 has not been replayed. No session has been counted for how often a failed break is followed by a re-break
in the same window.

## Decision

### 1. The lock

For a side at the focus card's level L (call: the ceiling, broken upward; put: the floor, broken downward):

- **Which breaks count.** Only a break the board counts: a 2-minute close beyond L whose close before it is known, not
  beyond L, and in the slot just before it (as `sideState` finds its `ia`; the lock scans every counted break from the
  open, not only the latest). A break the board does not count (the session's first bar, an open beyond L, a close
  beyond L with a missing slot before it; `sideState` reads some of these as `brokeEarlier`) neither arms nor locks. A
  break whose breaking bar ends inside a lock that is running neither arms nor locks either.
- **A failed break** is any completed 2-minute bar, after a counted break and before a fresh one, that closes back at
  or through L: the board's existing plan off. There is no bar limit. A break that held for an hour, or reached
  target 1, and then closed back through L is a failed break.
- **The lock** runs from the end of the failing bar. The failing bar's end decides the window, and is the time shown
  (a failure before 09:35 locks the morning too):
  - full day, failing bar ending at or before 13:00: the side is locked until 13:00;
  - full day, failing bar ending after 13:00: until the flat time (15:10);
  - half day: until the flat time (12:10).
- **While locked**, the side reads `plan_off`, in place of get_ready, enter_zone or missed, whatever later bars do.
  - Its `brokeAt` is the end of the counted break whose failure set the running lock. So DEC-0051's lifecycle keeps
    reading "invalidated" for that break, and signal-run logs no new break entry while locked.
  - A break made inside the lock, and its failure, are not counted: they neither move the lock's end nor change
    `brokeAt`.
- **When the lock ends:**
  - a break made inside it is ignored: the side reads `watch`, with `brokeAt` null and the failure's time kept
    (`failedAt`), whatever the live price or the last close, until a fresh counted break;
  - a fresh counted break (its breaking bar ending after the lock's end) arms the side as DEC-0052 section 1 says.
- **Worked out from the session's bars and the half-day flag alone**, the same way on the page and in the server's
  evaluation (DEC-0044): no memory between evaluations, no browser state. `sideState` gains the `halfDay` input
  (`nameState` already has it), and the lock's end comes from `LUNCH_TO_MIN` and `flatMinute(halfDay)`.
- **When the board's bars do not cover the session from its open** (`bars.complete` false, or a slot missing between
  the open and the confirming close), a failure may be unseen. A retest that would confirm then reads GET READY,
  "confirm on your chart: the board has not seen the session from its open", never ENTER.
  - This uses its own field (`lockUnseen`). It sets neither `gap` nor `brokeEarlier`, so the server keeps the name's
    record (`desk-eval.ts`'s `bars-gap`) and EXP-0033 labels as before.

### 2. What the owner sees

- **The locked side's line:** "Failed at <time>: no <call|put> until 13:00" ("until 15:10", "until 12:10" on the
  other windows). The same words are used on the side's line and on the name's row.
- **On the name's row,** whichever side the row leads with:
  - the lock is said on the row whenever a side is locked, beside the other side's line (for example
    "Failed at 13:24: no call until 15:10 · Puts below 48.00", with made-up times and prices);
  - with both sides locked, both locks are said, the earlier failure first;
  - when the locked side has an alternative trigger, the alternative's line comes first and the lock is said after
    it.
- **No new state name and no new record field.** `failedAt` and `lockUnseen` are display fields on `SideState`
  only. It is not written to DEC-0044 rows (`StateRow` is `{symbol, side, state}`) or to DEC-0051 logs (`LogSide`'s
  keys), so neither schema changes.

### 3. Where it lives

In `trade-state.ts`, beside DEC-0052's retest, inside both hashed sets. The window ends are the ones the board
already uses (`LUNCH_TO_MIN`, `flatMinute`, `HALF_DAY_FLAT_BEFORE_CLOSE`); no new number is introduced.

### 4. Engine, signal and the records

The change is in `trade-state.ts`, so `ENGINE_VERSION` and `SIGNAL_CODE_HASH` both change. It is a rule change, not a
defect fix.

- **The clone is not changed.** The board and the clone no longer apply exactly the same retest: a confirmed retest
  on a side the board has locked is one the clone may still trade. This is a stated departure from DEC-0052's
  "the same rule", for the owner's board only.
- **DEC-0044:** its table gets a row at release, with both labels and this record. Its enter-zone alert does not fire
  on a locked side.
- **DEC-0051's identity check** (lines 414-417) is run on this change as written. Its answer goes in EXP-0034's README.
  It ends nothing, because EXP-0034's window has not started.
- **The same release as DEC-0052 if it can be.** If DEC-0052's engine reaches production first, this change is a
  second engine label, with its own identity check and its own EXP-0034 README line. Neither ends anything while
  EXP-0034's window has not started.

### 5. Measurement: HYP-0061 and EXP-0036

**HYP-0061 (BOARD-FAILED-BREAK-LOCK):** among the board's break-and-retest ENTERs under DEC-0052, those the lock
removes reach the card's target 1 before its stop in a smaller share than those it keeps. It is measured on the
stock, from the card's entry, stop and target 1.

**EXP-0036: a retrospective replay, run once:**
- **What it runs:** the board with and without the lock, through the board's own code at each engine label. The
  with-lock commit's engine files (`trade-state.ts`, `trade-now.ts`, `desk-eval.ts`) differ from the without-lock
  commit's by this record's sections 1 and 2 alone; the run checks that first and stops if not.
- **An ENTER** is read from the name's row (`stateRows`), where the 09:35 start, the lunch block and the flat time
  already apply, not from `sideState` alone. The groups are read from the side states (`evaluateSlotStates`'
  `states`), which carry `failedAt` and `lockUnseen`.
- **Groups:** ENTERs without the lock are kept (enter_zone with the lock too), removed by the lock (at that slot the
  side reads `plan_off` with a failure time, or `watch` with a failure time after an ended lock, on a break made
  inside it), removed as unseen (`lockUnseen`; counted apart, left out of the test), or a fault (any other removal,
  or an ENTER added by the lock; counted and reported).
- **Sessions:** EXP-0035's list (every session with a DEC-0044 record, focus names only, the owner trade's session
  left out), extended to the last session before the release that ships this record's section 1.
- **Report:** the counts in each group, and for kept and removed the shares reaching target 1 first, the stop first,
  or neither.
- **Freezing:** its config is frozen in the pull request that accepts this record; its session list before the run.
- **Its report states** what "What has already been seen" lists.
- **What it decides.** The lock stays unless the ENTERs it removes did clearly better: with at least 10 removed
  ENTERs, 20 kept ENTERs and 10 sessions on the list, if the 95% range of (removed share reaching target 1 first)
  minus (kept share) lies wholly above 0, the owner is told, and decides whether to withdraw the lock by a further
  record. Otherwise nothing changes.
- **Possibly too few.** That is a guess, made with no count: failed breaks followed by a confirmed retest in the same
  window may be rare. Below the thresholds the report is an exploratory mark, not proof, and the lock stays.

### 6. DEC-0035 point 4

Point 4 requires a dated amendment to DEC-0035 before a change to the card's trigger is merged.

- **The amendment gives:**
  - the old trigger: DEC-0052 section 1, with the side free to arm on any new break;
  - the new trigger: DEC-0052 section 1, except on a side locked by section 1 of this record;
  - the reason: a failed break is a warning about that side for the rest of its entry window.
- **The statement it cannot make.** Point 4 also requires it to say "that no result of the owner's trades with the
  card plan was viewed to choose them". That cannot be said: items 1 and 3 of "What has already been seen" were
  viewed.
- **So:** this record proceeds only on the owner's explicit approval of that exception.
  - **The owner gave it in chat on 2026-11-17.**
  - It is recorded as `approved_by: owner` on the status line and repeated in the dated note added to DEC-0035.
- **The amendment lands before EXP-0033's window starts**, so it is not the early end "an amendment to DEC-0035"
  (DEC-0050 point 4).

### 7. Trials

- One new trial in family O: EXP-0036 / HYP-0061.
- Family O, because it is a replay of the Options desk's board, as EXP-0034 and EXP-0035 are.
- The family becomes 38 in `config/trial_registry.yaml`: a `proposed` row until this record is accepted.

## Amendments to earlier records

- **DEC-0035 point 4:** as section 6, with the exception stated and the owner's approval.
- **DEC-0052 section 1:** a retest that completes on a side locked by DEC-0053 section 1 is not an enter zone; its
  "everything the enter zone already needs still applies" gains "the side not locked by a failed break".
- **DEC-0045 section 3** and **DEC-0050 point 3:** the frozen numbers carried into EXP-0033 gain the lock
  (`FAILED_BREAK_LOCK: rest_of_entry_window`). EXP-0033 labels every session with one frozen copy and never backfills,
  so its frozen copy includes the lock only if the lock ships in or before the release that first writes EXP-0033's
  labels. Otherwise the lock's release is EXP-0033's `other_engine_version` early end.
- **DEC-0044's note:** a row is added at release: "DEC-0053: a failed break locks its side for the rest of the entry
  window; a rule change". It has both labels.
- **DEC-0051:** as section 4.
- **EXP-0033 config.yaml:** `frozen_numbers` gains `FAILED_BREAK_LOCK: rest_of_entry_window`. Its frozen-copy hash
  is not pinned yet, so nothing else changes. Its `in_zone` label excludes locked sides. Amended before its window
  starts, as its lines 5-6 allow.
- **EXP-0034 config.yaml:** the engine label pinned at registration is replaced by the label of the release that
  ships this record's section 1, before its window starts, as its lines 3-6 allow. Its README states what was viewed
  and that the change was not chosen on any outcome of EXP-0034, none of which exists.

Each amended record except DEC-0044 gets "## Note on DEC-0053 (added <date>)" pointing here; its text is otherwise
unchanged.

## Not decided here (the owner's steps)

- **Accepting this record.**
- **Publication:** the repository is public at the time of writing, and AGENTS.md classes decision prose as
  RESTRICTED. Whether and when this record is pushed is the owner's decision.
- **The release:** whether the lock waits to go out with DEC-0052's engine, or follows it.

## Accepting this record

The pull request that accepts this record:
- changes the status line, HYP-0061's and EXP-0036's statuses, and the registry row to accepted;
- moves the tests that pin family O's count from 37 to 38 (`tests/unit/test_options_records.py`,
  `tests/unit/test_options_clone_records.py`), as DEC-0052's acceptance did.

It changes no code. The board's change is a later pull request. It cites this record and:
- adds the lock in `trade-state.ts` (the `halfDay` input, `plan_off` with `failedAt`, `lockUnseen`) and the row's
  wording;
- makes the EXP-0033 and EXP-0034 config.yaml edits above (DEC-0052's own edits to those files are DEC-0052's board
  pull request's, and are not repeated here);
- adds the engine table row;
- adds synthetic tests:
  - a counted break, a failure and a re-break with a confirming close in the same window: never ENTER, PLAN OFF with
    the failure's time and the failed break's `brokeAt`;
  - a failing bar ending exactly at 13:00, and one ending at 13:02: locked until 13:00, and until the flat time;
  - a half day: locked until 12:10;
  - a break made inside the lock and still beyond L when it ends: `watch` with `failedAt` until a fresh break, which
    then arms; the same with that break already closed back before the lock ends;
  - a break made just before the lock ends that confirms just after it: no ENTER (`watch` with `failedAt`);
  - a `brokeEarlier` break that closes back: no lock;
  - the locked side's alternative trigger still shown;
  - bars missing from the open: GET READY with `lockUnseen`, never ENTER, and the name's DEC-0044 record kept;
  - the page and the server's evaluation agree on every slot.

## Consequences

- **Fewer ENTERs:** none on a side for the rest of the entry window after its break fails.
- **The board and the clone differ** on locked sides: the clone may trade a re-break the board does not show.
- **Records and alerts:** DEC-0044's alerts and shadow events thin out a little more; EXP-0033's `in_zone` narrows;
  EXP-0034 reads only dry sessions recorded under the signal-code hash this change produces.
