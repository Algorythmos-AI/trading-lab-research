# DEC-0052: The Options desk's board says ENTER on a break and retest only when the options clone's retest completes

- **Status: ACCEPTED on 2026-11-17.** approved_by: owner. Proposed on 2026-11-17 (#453) and accepted by the owner's
  merge of the pull request that changed this line.
  - **The DEC-0035 point 4 exception was approved by the owner, in chat, on 2026-11-17** (section 6):
    `approved_by: owner`.
  - The owner asked for this accepting change on 2026-11-17. The merge is the acceptance.
  - Acceptance registers HYP-0060 and EXP-0035 and fixes the definitions below. It changes no code and starts
    nothing: the board's change is a later pull request.
- **Not written before every affected result was viewed, and it says so.** What the author had seen is set out under
  "What has already been seen". In short:
  - one recent owner trade entered on the board, and its result;
  - the clone's decision lines for that session;
  - the clone's cumulative figures for HYP-0029, whose retest this record adopts.

  That is why DEC-0035 point 4's statement cannot be made (section 6). Going ahead is the owner's explicit decision,
  not a rule this record can satisfy on its own.
- **Amends:**
  - **DEC-0035 point 4:** the card's trigger. The amendment and the statement it cannot make are in section 6.
  - **DEC-0045 section 3** and **DEC-0050 point 3:** the frozen numbers carried into EXP-0033.
  - **DEC-0044's note:** a row in the engine table at release.
  - **DEC-0051:** its "Unchanged: the board's states and its engine" holds except for this record.
  - **EXP-0033** `frozen_numbers`, and **EXP-0034**'s engine pin, each before its window starts.

  Each amendment is worded under "Amendments to earlier records". A dated note in each amended record points here.
- **Registers** HYP-0060 (BOARD-RETEST-CONFIRMED) with EXP-0035 (section 5): one new trial in family O, which becomes
  **37** (section 7).
- **Experiment:** EXP-0035. **Hypothesis:** HYP-0060.
- **Unchanged:**
  - the owner's nine trade rules (`dashboard/src/lib/trade-rules.ts`);
  - the card plan's entry, stop (0.1 ATR) and targets (DEC-0035);
  - the board's failed break, sweep and rejection triggers;
  - the levels the board watches: the focus card's ceiling and floor;
  - the options clone and everything DEC-0030 freezes, HYP-0029 included.
- **Depends on:** DEC-0030, DEC-0035, DEC-0042, DEC-0043, DEC-0044, DEC-0045, DEC-0050, DEC-0051.

## Why

The board and the clone name the same setup, and differ in two points no record states.

**What they share:**
- The break: a 2-minute close through the level, the close before it not. The board mirrors Python's first-bar rule
  (`trade-state.ts` lines 345-365).
- "No close back through", as the board's plan off (line 386).
- The 6-bar window (`MAX_BARS_TO_RETEST`, copied from `setups.retest`, `entry-checks.ts` line 38).

**Where they differ:**
1. **The touch.** The board counts a bar within `RETEST_ATR` (0.1) of the focus item's daily ATR from the level
   (`trade-state.ts` line 478). The clone counts a bar within 1.0 two-minute ATR (`config/options_clone.yaml`
   `setups.retest.retest_within_atr`).
2. **Confirmation.** The board says ENTER at the touch, while the live price is beyond the level, and keeps saying it
   for as long as that holds. The clone signals only on the first bar after the touch to close beyond the touch bar's
   close (`src/wt/options/setups.py` lines 43-45), and on that one bar.

The board's code says it follows the clone's retest ("setups.retest's window", `trade-state.ts` lines 319 and 394;
`entry-checks.ts` line 38 names HYP-0029). It follows only the window.

**An example with made-up numbers.** On a name whose daily ATR is 18.00:
- the board's touch band is $1.80;
- the card's stop is $1.80 beyond the level, and its entry a cent the other side, so the band is about as wide as the
  whole distance to the stop.

On 2-minute bars that typically move a few tens of cents, the clone's band is a fraction of that, and it adds the
confirming close.

**The reason for this record is consistency with the registered rule, not a result.**
- The owner trades from the board, and is told the clone trades "by your nine rules".
- One trade is not evidence that either rule is better.
- Section 5 measures it once, on sessions already recorded.

## What has already been seen

1. **One recent owner trade.** It was entered while the board showed ENTER on a break and retest, and it closed at a
   loss. Its details are the owner's (PRIVATE) and are not recorded here.
2. **The clone's decision lines for that session, read on the host.** The clone found no retest on that name while the
   board showed ENTER. The author also read that session's bars by the clone's rule as written, without running the
   clone's code, and found no confirming close.
3. **The clone's cumulative figures by hypothesis (Trades page).** These include HYP-0029, the retest this record
   adopts. They were seen before HYP-0060 was written. HYP-0060 is therefore not independent of them, and EXP-0035's
   report must say so.

No outcome of EXP-0033, EXP-0034 or EXP-0035 exists: no window has started, and no `dry` session has run (EXP-0034
README line 41).

## Decision

### 1. The board's break and retest completes as the clone's does

For a call at the focus card's level L (a put is the mirror), the side is in its enter zone for a break and retest
only from the settled 2-minute close that completes `wt.options.setups.retest` on the
board's merged SIP bars at L, for the slots section 2 gives.

- **Break** (unchanged): a 2-minute close above L, the close before it at or below L.
- **Touch** (new): within `MAX_BARS_TO_RETEST` (6) bars after the break bar, a bar's low comes within
  `RETEST_WITHIN_ATR` (1.0) × the 2-minute ATR of L.
  - The 2-minute ATR is 14 periods (`bars.atr_period`) of the board's merged bars, taken at each evaluation as
    `atr2m` already is for the sweep (`trade-state.ts` line 798).
  - It needs 15 bars, so no retest can complete before about 10:00 New York. The board's 09:35 start (DEC-0043)
    still applies to the other triggers.
- **No close back through** (unchanged): any close at or below L from the break on is plan off.
- **Confirmation** (new): the closing bar is the first after the touch to close above the touch bar's close.
- **Everything the enter zone already needs still applies:**
  - a fresh quote;
  - the live price above L;
  - no gap in the slots since the break;
  - target 1 not reached since the break;
  - inside the session's entry hours and the day's limits.

The clone's `invalidation_atr` is not adopted. Before the entry, any close back through L already ends the plan.
After it, the card's stop (DEC-0035) is the stop, as now.

### 2. What the owner sees

- **From the touch to the confirming close:** GET READY, with "Retest touched: wait for a 2-minute close above
  <the touch bar's close>" ("below" for a put).
- **ENTER:** for the two slots that follow the confirming close: the slot it opens and the next one, about four
  minutes. The clone signals on one bar, and fills inside it; the owner needs time to read, choose a contract and
  place it. The owner chose two slots on 2026-11-17.
  - ENTER ends early once the live price runs more than 1.0 two-minute ATR beyond the confirming close (the same
    `RETEST_WITHIN_ATR`): past that, entering is chasing.
- **The risk line.** While ENTER shows, the line adds what entering there means against the card. For example:
  "Confirmed at 101.40: $0.38 past the card entry; to the stop $1.53, not $1.15".
  - It gives the confirming close, how far that is past the card's "In ≈" price, and the distance from the
    confirming close to the card's stop against the card's own entry-to-stop distance.
  - The card's numbers (entry, stop, target 1) are unchanged. This is wording only (DEC-0035 point 4 exempts
    presentation). The owner chose it on 2026-11-17, rather than moving the card's entry.
- **After those slots, or after a run past the confirming close:** MISSED, with a new reason, "slot passed":
  "Retest confirmed at <time>: missed, don't chase". This is beside the existing "target" and "window" reasons, until
  the window or the plan ends.
- **The window.** A confirming close inside the clone's window (at most `MAX_BARS_TO_RETEST + 1` bars after the
  break) keeps its two ENTER slots even when the second falls one slot past the window.
- **One confirmation per break: the first.** The confirming close that governs is the earliest bar at which the
  clone's rule, read with the 2-minute ATR at that bar, completes.
  - A later bar that would confirm again, for example after the ATR has grown, neither restarts the two slots nor
    changes the confirming close. Once they have passed, the side stays MISSED for the rest of that break.
  - So the board shows at most one ENTER per break where the clone may signal twice; the clone, too, takes one trade
    at a time.
- **Back at the level.** If, during the two slots, the live price comes back to the level without a close through it,
  the side reads GET READY with "Retest confirmed at <close>: price back at <level>, wait".

### 3. The numbers live where the clone's other numbers do

- `RETEST_WITHIN_ATR` (1.0) is copied into `dashboard/src/lib/entry-checks.ts`, beside `MAX_BARS_TO_RETEST`, in its
  `config/options_clone.yaml` block.
- `tests/unit/test_entry_checks_parity.py` is extended to hold it equal to the YAML.
- `trade-state.ts` stays pure, and the numbers stay inside the hashed code.
- `RETEST_ATR` (0.1) stops deciding the touch. It remains the card's `STOP_ATR` band (`trade-state.ts` line 38).

### 4. Engine, signal and the records

The change is in `trade-state.ts`, inside both hashed sets, so `ENGINE_VERSION` and `SIGNAL_CODE_HASH` both change. It
is a rule change, not a defect fix.

- **DEC-0044:**
  - its table gets a row at release, with both labels and this record;
  - its enter-zone alert fires on the confirming close only;
  - the shadow log's event count per session falls.
- **DEC-0051, its identity check** (lines 414-417) is run on this change as written. Its answer ("rows differ"),
  with the counts, goes in EXP-0034's README. It ends nothing, because EXP-0034's window has not started (the
  precedent is its README lines 49-57).
- **DEC-0051, its lifecycle** (lines 107-108) will read "invalidated" two slots after every CALL or PUT on a retest,
  since ENTER now lasts at most two slots. This is expected, not a fault.
- **DEC-0051, its "weakening" word** (lines 107-117) still counts the slots left in the 6-bar window from the break, as
  DEC-0051 defines it. A retest confirmed on the 5th to 7th bar after the break reads "weakening" from its first ENTER
  slot, and its count of slots left can go below zero. DEC-0051's definition is not changed here. This is expected,
  not a fault.
- **EXP-0034:** no dry session has run. Amendment 1 reads only dry sessions recorded under the signal-code hash this
  change produces.

### 5. Measurement: HYP-0060 and EXP-0035

**HYP-0060 (BOARD-RETEST-CONFIRMED):** on the same focus names and sessions, the confirmed retest gives fewer
break-and-retest ENTERs than the 0.1-daily-ATR touch, and a larger share of them reach the card's target 1 before
its stop. It is measured on the stock, from the card's entry, stop and target 1.

**EXP-0035: a retrospective replay, run once:**
- **What it runs:** both rules, through the board's own code at each rule's engine label.
- **Sessions:**
  - every session with a DEC-0044 record and its SIP 2-minute bars, up to the release that carries this change;
  - focus names only (DEC-0051 section 5.1);
  - the session of the trade in "What has already been seen" left out.
- **Report:** per rule, the count of ENTERs, and the shares reaching target 1 first, the stop first, or neither.
- **Freezing:** its config, inputs and session list are frozen in the pull request that accepts this record.
- **Its report states** that HYP-0029's figures and one owner trade were seen before HYP-0060 was written.
- **It does not gate section 1,** which holds on consistency grounds. If HYP-0060 is falsified, the owner decides
  whether to write a further record.

### 6. DEC-0035 point 4

Point 4 requires a dated amendment to DEC-0035 before a change to the card's trigger is merged.

- **The amendment gives:**
  - the old trigger: a touch within 0.1 daily ATR, ENTER while the price is beyond the level;
  - the new trigger: section 1;
  - the reason: consistency with HYP-0029's registered rule.
- **The statement it cannot make.** Point 4 also requires it to say "that no result of the owner's trades with the
  card plan was viewed to choose them". That cannot be said: item 1 of "What has already been seen" was viewed.
- **So:** this record proceeds only on the owner's explicit approval of that exception.
  - **The owner gave it in chat on 2026-11-17,** after reading this section.
  - It is recorded as `approved_by: owner` on the status line and repeated in the dated note added to DEC-0035.
- The card's "Break and hold" wording (`focus-plan.ts` lines 60-62) is updated to say "a 2-minute close confirms the
  retest".

### 7. Trials

- One new trial in family O: EXP-0035 / HYP-0060.
- Family O, because it is a replay of the Options desk's board, as EXP-0034 is (DEC-0051 section 9).
- The family becomes 37 in `config/trial_registry.yaml`: a `proposed` row until this record is accepted.

## Amendments to earlier records

- **DEC-0035 point 4:** as section 6, with the exception stated and the owner's approval.
- **DEC-0045 section 3:** the frozen `RETEST_ATR` of 0.1 decides the touch only for sessions recorded under the engine
  label before this change. After it, the touch is DEC-0052 section 1.
- **DEC-0050 point 3:** EXP-0031's values carry into EXP-0033 unchanged except `RETEST_ATR`'s role as the touch, which
  DEC-0052 replaces.
- **DEC-0044's note:** a row is added at release: "DEC-0052: the break and retest completes as the clone's; a rule
  change". It has both labels.
- **DEC-0051:** as section 4.
- **EXP-0033 config.yaml:**
  - `frozen_numbers` gains `RETEST_WITHIN_ATR: 1.0` and the confirmation, and `RETEST_ATR` is marked as the card's
    stop band only;
  - its frozen-copy hash is not pinned yet (set in the release that first writes labels, config line 71), so nothing
    else changes;
  - its `in_zone` label (config line 123) now covers at most two slots, which narrows what HYP-0056 measures; EXP-0033's README
    says so;
  - amended before its window starts, as its lines 5-6 allow.
- **EXP-0034 config.yaml:**
  - the engine label pinned at registration is replaced by the new one, before its window starts, as its lines 3-6
    allow;
  - its README states what was viewed (above) and that the change was chosen for consistency, not on an outcome of
    EXP-0034, none of which exists.

EXP-0031 is not closed: its README lines 35-39 still read "not yet", and DEC-0050 lines 46-50 make its closure
conditional. It is untouched here, beyond the DEC-0045 and DEC-0050 notes.

Each amended record gets "## Note on DEC-0052 (added <date>)" pointing here; its text is otherwise unchanged.

## Not decided here (the owner's steps)

- **Approving the DEC-0035 point 4 exception** (section 6), and accepting this record.
- **Publication:**
  - the repository is public at the time of writing;
  - AGENTS.md classes decision prose as RESTRICTED;
  - whether and when this record is pushed is the owner's decision.
- **The clone's other gates** (trend, room, contract): whether they should also shape the board's words is not
  proposed here.

## Accepting this record

The pull request that accepts this record:
- changes the status line;
- adds HYP-0060, and EXP-0035 with its frozen config;
- adds the trial registry row;
- adds the dated notes in DEC-0035, DEC-0045, DEC-0050, DEC-0051, EXP-0033 and EXP-0034.

It changes no code: `entry-checks.ts` is in the hashed code too, so even the new constant waits for the board's
pull request. The board's change is that later pull request. It cites this record and adds:
- `RETEST_WITHIN_ATR` in `entry-checks.ts`, and its line in `tests/unit/test_entry_checks_parity.py`;
- the engine table row;
- the synthetic tests in which the board and `wt.options.setups.retest` agree bar for bar:
  - a touch that is never confirmed is never ENTER;
  - a confirmed touch is ENTER for two slots (fewer if the price runs 1.0 ATR past the confirming close), then MISSED;
  - a close back through is plan off.

## Consequences

- **Fewer and later ENTERs:** the board says ENTER on fewer break-and-retest setups, at the confirming close and not
  at the touch, and none before about 10:00.
- **The same rule, not the same trades.** The board and the clone apply the same retest rule. The clone watches its
  own marked levels on IEX bars, while the board watches the card's ceiling and floor on SIP bars. A board ENTER is
  therefore not always a setup the clone saw, and the clone may refuse one it saw on its other gates.
- **Records and alerts:**
  - DEC-0044's alerts and shadow events thin out;
  - DEC-0051's lifecycle shows "invalidated" after each retest ENTER's two slots;
  - EXP-0033's `in_zone` narrows;
  - EXP-0034's Amendment 1 reads only sessions under the new signal-code hash.
