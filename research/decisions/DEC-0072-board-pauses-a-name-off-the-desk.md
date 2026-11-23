# DEC-0072: the Options desk's board pauses any name that is not one of the desk's names

- **Status: PROPOSED on 2026-11-23.** It takes effect when the owner merges the pull request that changes this line to
  ACCEPTED. This record changes no code. The board's change is a later pull request, which must meet section 4.
- **Why now:** DEC-0070 section 6a (added 2026-11-23, in #598) found that the Trade now board can say ENTER ZONE for a
  name that is not one of the desk's 12. It made a registered guard a precondition of the switch (DEC-0048). This is
  that guard.
- **Kind:** a change to the board's engine (`trade-state.ts`), so `ENGINE_VERSION` and `SIGNAL_CODE_HASH` move. It is
  a safety guard, not a rule change for any name the board can be given today. For the desk's 12, no state, level,
  card number, line or guard changes (section 4 proves it on the fixtures).
- **Written before any affected result was viewed.** This guard has no result: no board row of a non-desk name has
  ever existed, because the focus has only ever been drawn from the 12. Nothing was viewed but code: the audit of
  DEC-0070 section 6a, the engine table in DEC-0044, and the records named below.
- **Trials:** none. Family counts are unchanged.
- **Amends** (each only as said):
  - **DEC-0044's engine table:** a row at release (section 5).
  - **EXP-0034's engine pin**, before its window starts (section 6).
  - **DEC-0051:** its "Unchanged: the board's states and its engine" holds except for DEC-0052, DEC-0053 and this
    record.
- **Does not amend:**
  - DEC-0035 (the card and its trigger), for the reason in section 2a; the owner confirms that reading on acceptance;
  - the owner's nine trade rules (`trade-rules.ts`);
  - DEC-0052's retest and DEC-0053's lock;
  - the bad-data guards of DEC-0042 and their switch (`desk/guards.json`);
  - the options clone (DEC-0030; DEC-0070 section 8 keeps it on the 12);
  - `market-calendar.json`.
- **Depends on:** DEC-0035, DEC-0042, DEC-0044, DEC-0051, DEC-0052, DEC-0053, DEC-0070.

## Why

Every surface that tells the owner to act draws from the row state (`nameState` in `trade-state.ts`). That covers:

- the Trade now board's row and its notice, browser notification and sound;
- the hero;
- the focus card and its glance;
- the status rail;
- the manage card's "I'm in" form.

The row state holds no list of names and reads no calendar. A name the event calendar does not keep (its
`options_names`, the desk's 12) therefore reaches `enter_zone` like any other, with nothing checking its earnings.
Only the signal word (`signal.ts`) refuses such a name, and no page draws the signal word.

The fix belongs where the row state is decided. It also has to fail closed for any name, not only the Radar's: a typo
in an edition, a renamed ticker, or a class share must never reach an entry.

## Decision

### 1. The rule

When a row's symbol is not in `OPTIONS_NAMES`, `nameState` returns `paused`. `OPTIONS_NAMES` is
`market-calendar.json`'s `options_names` (`market-calendar.ts`), the same list `board-events.ts` uses to keep
earnings dates. `scripts/build_market_calendar.py` writes it from `config/options_desk.yaml`'s `names`. On
2026-11-23 both hold the same 12 names, SPY and QQQ included. A change to the desk list changes both, through
`make schema`, in the same pull request. The board's rows come from the focus items only, so no other symbol reaches
`nameState`. The row's line reads:

> Not one of the desk's names: its earnings and expiry facts are not on file

- **Always on.** It is not a `desk/guards.json` switch, and no switch turns it off.
- **First.** It is checked before the stale-feed check and before every clock gate, in and out of the session. No
  other state can be reached for such a name.
- **Symbols compared upper-cased**, as the editions carry them. `GOOG` is not `GOOGL`: an alias is a different
  name to this rule.
- **Every surface follows the paused state**, by the code as it stands:
  - `rowView` gives a paused row no grid and no side;
  - `noticeKey` keys no notice for it;
  - `entryPrompt` is false for it, so no notification, no sound and no "I'm in" form;
  - the hero, the focus card, the glance and the rail show "Paused".
- **The signal word is unchanged:** `signalWord` already answers NO TRADE for a paused row (`STATE_AGAINST`).
- **Two existing lines are not specific to this cause, and are kept:**
  - the signal record's "prices are paused";
  - the manage card's "Prices paused: manage this one on your platform", which is still the right instruction for a
    position held in such a name.
  Only `trade-state.ts` changes.

### 2. What it does not do

- **It does not change any row of the desk's 12.** Every one of them is in `OPTIONS_NAMES`.
- **It does not admit a non-desk name to anything.** A Radar name is paused on the board until a later record adds
  its earnings and expiry facts to the calendar, the board's freeze pin. That is the owner's decision under DEC-0048
  or its own record.
- **It does not hide the name.** The row is drawn, paused, so the owner sees what the focus held and why the board
  will not act on it.

### 2a. Why this is not an amendment to DEC-0035

DEC-0035 point 4 needs a dated amendment for a change to a number the card plan uses: `ENTRY_ATR`, `STOP_ATR`,
`MIN_ROOM_MULTIPLE`, the trigger, or which level is the target. DEC-0052 and DEC-0053 amended it because they changed
when a desk name's row reaches ENTER.

This rule changes none of those for any name the card has ever been drawn for. It is a check of whether the board
has the facts to act on a name at all. That makes it the same kind of check as:

- the stale-feed pause, which was in place when DEC-0035 was accepted;
- the bad-data guards (DEC-0042's note of 2026-11-12), which pause a name and were not an amendment to DEC-0035.

An amendment to DEC-0035 is one of EXP-0033's early ends, so this classification matters. **The owner's merge of
the accepting change confirms it.** If the owner reads it otherwise, the accepting change adds the amendment to
DEC-0035 instead, and EXP-0033 is handled as section 6 says.

### 3. Where it sits in DEC-0070

This record meets DEC-0070 section 6a's precondition once its code is released to production. DEC-0048 may publish a
non-desk focus name only after that release.

### 4. The code change (a later pull request) must show

1. **The engine identity check** (`dashboard/test/validation/engine-identity.test.ts`) against the integration commit
   before the change:
   - no row's state, `brokeAt`, card number, line or display field differs over the fixtures, with the counts the
     check reports;
   - every fixture and logged identity session uses desk names only (on 2026-11-23 the board fixtures name AAPL and
     the other desk names); the pull request lists any symbol it finds that is not one, and then stops for the
     owner;
   - the bar states of the retest vector sessions are unchanged.
2. **A new fixture case:**
   - a non-desk symbol whose bars, quotes and plan would otherwise reach `enter_zone`, with every other gate passing;
   - its row reads `paused` with the line of section 1;
   - `entryPrompt` is false, `noticeKey` is null, and `rowView` has no grid;
   - the hero, focus card, glance and rail render no "ENTER", "CALL" or "PUT" for it;
   - the same case with the symbol replaced by a desk name reads `enter_zone`.
3. **Both hashes move, and only these files:**
   - `ENGINE_VERSION` and `SIGNAL_CODE_HASH` move;
   - the literal in `dashboard/test/signal-freeze.test.ts` moves with them;
   - no file outside `trade-state.ts` (and any test) changes in either closure.
4. **The last 10 logged sessions run before the label reaches production,** as for the earlier engine rows. No row
   may differ.

### 5. DEC-0044's engine table (at release)

A row: release "DEC-0072 (board pauses a name off the desk)". Labels before and after as released. Engine file:
`trade-state.ts`. Change to a state, a level or a guard: "A symbol not in `OPTIONS_NAMES` reads paused. None for
the desk's names, measured by EXP-0034's engine identity check (section 4)."

### 6. The experiments

- **EXP-0034** (signal gates) has not started: no `dry` session, no window. Its engine pin is replaced by this
  release's label before its window starts. Neither ends anything.
  - Its unit is a break that reaches `enter_zone`. A paused row never reaches one, so a non-desk name can never
    enter its log as a scored break, whatever the switch publishes.
- **EXP-0033** (the owner's trades on the board, SIP) has not started: no label has been written.
  - Its engine hash is taken from "the release that first writes labels", so this change, released before that, is
    part of its frozen copy and ends nothing.
  - If its window has started by the time this code reaches production, this release is its `other_engine_version`
    early end. The code PR must then wait for the owner's decision, and say so.
- **EXP-0035 and EXP-0036** (the retest and lock replays) run the board's own code at fixed commits (`engines` in
  each `config.yaml`): `8cd5ff0d`, `eaa2ab52` and the commits that merged DEC-0052's and DEC-0053's code. A later
  engine is not one of them, so this change reaches neither.
- **EXP-0031** ended with no session when the board moved to SIP (DEC-0050); EXP-0033 asks its questions.
- **EXP-0032** (selection forward) and **EXP-0050** (the clone) do not read the board's engine.

## What is not decided here

- How a non-desk name gets its facts onto the calendar: the earnings rows, the expiry facts and the freeze pin
  (`market-calendar.json`, inside both closures). That is a later record under DEC-0048.
- The switch itself (DEC-0048).

## Consequences

- No act-now prompt (an ENTER ZONE row, a notice, a notification or sound, an entry step or the "I'm in" form) can
  fire for a name the desk's calendar does not keep.
- The focus card still prints its plan's levels for every focus name (display only, DEC-0035). Whether a non-desk
  name gets a card at all is DEC-0048's.
- Nothing visible changes before the switch: every focus name is a desk name.
- After the switch, a Radar name in the focus shows on the board, paused, with its reason, until its facts are on
  file.

## Note on the code (added 2026-11-23, before acceptance)

The code pull request found two things section 1 and section 4 did not say. Neither changes the rule.

1. **`desk-eval.ts` changes too, in one line.** The server's evaluation sets the day's `stale` flag when any row is
   paused without a bad-data guard. An off-desk pause would have read as a stale feed. The row now carries
   `offDesk: true`, and `stale` leaves such a row out. No other line of `desk-eval.ts` changes.
2. **One test file named a symbol off the desk.**
   - `dashboard/test/owner-labels.test.ts` (EXP-0033's labeller, which no job runs yet) replayed a synthetic focus name
     `ABC`. It is renamed `AMD`, a desk name, and nothing else in the file changes.
   - In production the labeller turns any position outside the focus into `not_focus` before it reads the board
     (`owner-labels.ts`). Every focus name so far is a desk name, so no label of a real position can change.
   - The board fixtures and the identity check's cases name desk symbols only.

Measured on 2026-11-23 against integration 5cf8997 (`engine-identity.test.ts`, which replaces DEC-0053's check):
- no row of any fixture differs, in state or in any byte: 735 board cases, 2,205 rows; 84 evaluated slots, 420 rows;
- no bar state of the 15 retest vector sessions differs (312 bars);
- the same entry-zone rows under a symbol off the desk read paused, with no grid, no notice and no entry prompt;
- such a row is paused in the evaluation, and is not counted as a stale feed.

`ENGINE_VERSION` moves from `e-593cd517f8d5` to `e-8591f874008c`. `SIGNAL_CODE_HASH` moves to
`s-f9d5b56c2e2764713cc81828753725c86fd5b44b091bf2dbaeba71f70f7a1206`, and the pin in
`dashboard/test/signal-freeze.test.ts` moves with it.
