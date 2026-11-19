# DEC-0065: The board's two retest replays (EXP-0035, EXP-0036) run once on a fixed horizon of sessions, and EXP-0036 splits the lock's removals by how fast the break failed

- **Status: PROPOSED on 2026-11-19.** The owner's merge of the pull request that changes this line to ACCEPTED, and
  the registry row to `accepted`, accepts it. Acceptance changes no code, starts nothing and changes no engine label.
- **Amends, before either run:** EXP-0035 (DEC-0052's replay) and EXP-0036 (DEC-0053's replay), as each config's
  header allows ("before the run a decision record may amend it, saying what was viewed"). HYP-0060 and HYP-0061 keep
  their statements except for the session list, as section 1 says.
- **Registers** HYP-0068 (BOARD-LOCK-SLOW-FAILURE), a secondary trial of EXP-0036 (section 2): one new trial in family
  O, which becomes **48** (section 5).
- **Unchanged:** DEC-0052 section 1 and DEC-0053 section 1 as written, the board's code, the engine labels, the
  clone, and every other frozen definition in EXP-0035 and EXP-0036 (engines, inputs, groups, outcome, statistics,
  seeds, lapse dates).
- **Depends on:** DEC-0044, DEC-0051, DEC-0052, DEC-0053.

## Why

**Both replays end their session lists at the release they measure, so neither can ever give a verdict.** DEC-0044's
server records start on 2026-11-12. DEC-0052 and DEC-0053 both reached production in releases cut on 2026-11-17,
before that day's session. So:

- EXP-0035's list ("from the first to the last session before the release that ships DEC-0052 section 1", less the
  owner-trade session) holds 2 sessions. Its `too_few` needs 10.
- EXP-0036's list (EXP-0035's, "extended to the last session before the release that ships DEC-0053 section 1") holds
  the same 2. Its `too_few` needs 10 sessions, 10 removed ENTERs and 20 kept ENTERs.

The list never needed to stop at the release. Each replay runs the board's own code at fixed commits on recorded
inputs (DEC-0044 records, edition copies, SIP bars read again). The engine production ran on a later day does not
enter it: the without-lock engine replays a post-release session as well as an earlier one. Stopping at the release
only made the evidence for both rules one or two sessions deep.

**Why a fixed date, not "until 10 sessions" or "until the thresholds are met".** The ENTER rate seen in the logged
sessions (section 4) suggests 10 sessions would leave EXP-0036 below 20 kept and 10 removed ENTERs. A list that stops
when counts are reached is a stopping choice made while watching. A calendar date fixed now involves no choice later.

**Why the split (HYP-0068).** On 2026-11-19 the owner asked whether a break that fails late in the day, after holding
for hours, should lock its side like a fast failure. DEC-0053 section 1 chose "no bar limit" on purpose. The board's
own failed-break trigger (`FAIL_WITHIN_BARS` = 3, `altAt`) treats only a failure within 3 bars as a trap, so the
board holds two definitions of a failed break. The owner chose to keep DEC-0053 as written and to measure the
difference before any rule change. HYP-0068 is that measurement, written before any outcome of it exists.

## What has already been seen

1. **Everything DEC-0052 and DEC-0053 list as seen.**
2. **The live-records check of 2026-11-17 and 2026-11-18** (EXP-0034 README): every record on `e-593cd517f8d5`; one
   counted failure locked as written.
3. **A states-only count on 2026-11-19** over all five logged sessions (2026-11-12, 11-13, 11-16, 11-17, 11-18; 970
   slots; SIP bars), through the without-lock engine (eaa2ab52), the lock engine (73007107), and three local,
   uncommitted patched copies of the lock engine (lock only failures within 3 bars; afternoon lock of 30 or of 60
   minutes):
   - 15 counted failures; 3 of them after 13:00; 9 within 3 bars of the break and 6 slower (4, 5, 14, 21, 34 and 124
     bars);
   - the lock removed 8 ENTER runs (14 slots): 3 after fast failures and 5 after slow ones;
   - a 3-bar limit would have restored 2 of those runs; a 30-minute afternoon lock 1; a 60-minute one none;
   - the lock engine rebuilt its own logged rows in 386 of 387 slots.
   These include the owner-trade session, which both lists exclude. **No outcome was computed.** No target, stop,
   price or later state of any ENTER was read. So the group sizes on the five sessions are known and their outcomes
   are not: this is not blind, and the report says so beside each verdict.

## Decision

### 1. The session lists (EXP-0035 and EXP-0036)

- **Each list is** every session with a DEC-0044 server record from 2026-11-12 **through 2027-01-29**, New York date,
  half days included. The owner-trade session each config already excludes stays excluded.
- **Each replay runs once, after the 2027-01-29 session's records are sealed**, and before its lapse date
  (2027-02-28, unchanged).
- **Within that list, "the last session before the release" no longer bounds the inputs.** Both engines of each
  replay run every session on the list, whichever engine production ran that day.
- **A session is skipped and counted, not dropped silently,** when the replay cannot rebuild its inputs (the
  harness's existing skip reasons: no edition, another feed, a copy not kept). Each config's existing lapse clause
  ("the replay cannot be run on both engines from the recorded inputs") covers a list on which it fails throughout.
- **The session list, the bars' sha256s and the engine commits** are written into each README before its run, as
  before.
- **One interim count is allowed, once, on or after 2026-12-17:** the number of sessions on the list so far, and each
  replay's group sizes (EXP-0035: ENTERs per rule; EXP-0036: kept, removed, removed after a slow failure, removed
  unseen, faults). It reads states only, no outcome. It changes nothing and is written as a dated README line. Its
  only purpose is to say whether the thresholds look reachable by 2027-01-29.

HYP-0060's and HYP-0061's statements name their old lists. Each gains a `session_list` line pointing here. Their
other fields are unchanged.

### 2. HYP-0068: BOARD-LOCK-SLOW-FAILURE (EXP-0036, secondary)

**Statement.** Among the ENTERs EXP-0036 counts as removed by the lock, those removed by a lock that a slow failure
set reach the card's target 1 before its stop in a share no greater than the share among the ENTERs the lock keeps.

- **Slow failure.** For a removed ENTER, take the lock that removed it: the side's `failedAt` at that slot.
  - Its break is the `brokeAt` the side carried while it read `plan_off` with that `failedAt`.
  - The failure is **fast** when `failedAt − brokeAt ≤ FAIL_WITHIN_BARS × 2 minutes` (6 minutes, 3 bars), and
    **slow** otherwise.
  - `FAIL_WITHIN_BARS` is the board's existing number (`trade-state.ts`): no new number is introduced.
- **The half (reported, not tested).** Each removed ENTER is also labelled by its failing bar's end: by 13:00, or
  after. The report gives the counts and shares for each half beside the test.
- **The difference tested:** (slow-removed share reaching target 1 first) minus (kept share). It uses EXP-0036's
  outcome, entry, card, first-touch and flat rules unchanged.
- **Statistics:** 5,000 session resamples, mulberry32 seeded **20261168**, 95% range, numpy linear percentiles.
- **Too few:** fewer than 10 slow-removed ENTERs, 20 kept ENTERs or 10 sessions on the list is an exploratory mark,
  not proof.
- **What it decides.** It gates nothing by itself.
  - With enough data, if the whole 95% range lies above 0, the owner is told.
  - The owner may then propose, by a new record through AGENTS.md rule 2, that only a failure within
    `FAIL_WITHIN_BARS` bars locks its side (the owner's choice of "fast", 2026-11-19).
  - Otherwise nothing changes.
- **Multiplicity.** HYP-0061 stays EXP-0036's primary trial. HYP-0068 reads a subset of HYP-0061's removed group, on
  the same sessions, so the two are not independent. The report says so, and the owner weighs it.

### 3. Where it lives

- **EXP-0035 `config.yaml`:** `inputs.sessions` as section 1, a header note, and the README "Before the run" lines.
- **EXP-0036 `config.yaml`:** `inputs.sessions` as section 1, a second `trials` row (HYP-0068, `role: secondary`),
  the slow-failure definition under `groups`, and a header note. Also the README.
- **`research/hypotheses/HYP-0068-BOARD_LOCK_SLOW_FAILURE.yaml`.**
- **A dated note** in DEC-0052 and DEC-0053 pointing here.

### 4. Why not change the rule now

- **The rule was not chosen on the counts.** The owner chose before they existed, and the counts carry no outcome.
- **The single all-day case (2026-11-13, failing at 14:10):** neither option would have changed its ENTERs. The first
  re-break after it failed within 3 bars, so a 3-bar lock locks the side anyway. A 60-minute lock from 14:10 ends at
  the 15:10 flat time.
- **No option changed more than 2 ENTER runs in five sessions.** A rule change costs a new engine label, an identity
  check, an EXP-0034 re-pin and a release. On that count, it buys nothing measurable yet.

### 5. Trials

- One new trial in family O: HYP-0068 in EXP-0036.
- The family becomes 48 in `config/trial_registry.yaml`, a `proposed` row until this record is accepted.
- At acceptance, the tests that pin family O's count move to the new total (`tests/unit/test_options_records.py`,
  `tests/unit/test_options_clone_records.py`), as DEC-0053's acceptance did.
- If another record that adds family O trials is accepted first, the total is that record's plus one.

## Not decided here (the owner's steps)

- **Accepting this record.**
- **Running the interim count and the replays.** They need the production store, and the owner runs them as the
  engine-identity runbook says (`docs/runbooks/engine-identity-sessions.md`).

## Consequences

- **Both replays can now reach their thresholds.** At the rate seen so far, about 50 sessions should yield more than
  20 kept and 10 removed ENTERs. EXP-0036's verdict on the lock, and HYP-0068's on slow failures, land in February
  2027 instead of never.
- **The lock stays as written until then.** Any change to it goes through a new record.
