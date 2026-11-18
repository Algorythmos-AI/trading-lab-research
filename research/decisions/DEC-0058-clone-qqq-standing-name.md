# DEC-0058: The options clone trades QQQ every session

- **Status: ACCEPTED on 2026-11-17 (New York).** approved_by: owner.
  - The owner asked for this record in chat on 2026-11-17.
  - They chose its start from three options put to them: the next session, after EXP-0039's verdict, or a date of
    their choosing.
  - They accepted that EXP-0039 closes after one session (point 6).
  - The merge of the pull request that carries this line accepts it.
- **Written before any session under the new rule exists, and before EXP-0039's first session.** What the author
  had seen is listed in "Disclosure".
- **Amends** DEC-0032 in the names only: QQQ is added beside the focus names, and the top-up rule is unchanged.
  Every gate, floor, cap, exit, limit and latch is unchanged.
- **Depends on:** DEC-0005 (trial accounting), DEC-0028 (family O), DEC-0030, DEC-0032, DEC-0033, DEC-0034,
  DEC-0039, DEC-0040 and DEC-0056.
- **Experiment:** EXP-0040.

## Why

The focus names are single stocks picked the evening before. A signal on one of them often finds no contract the
clone may buy. Signals on the index names almost always find one.

Counts come from the clone's decision lines, 2026-10-20 to 2026-11-17 (21 sessions). They are signals and gate
verdicts only; no outcome was read.

| Name | Sessions | Signals | Contract check passed | Refused by the contract check alone |
|---|---|---|---|---|
| SPY | 21 | 92 | 88 | 0 |
| QQQ (only as fallback or top-up) | 2 | 2 | 1 | 0 |
| Single names | 19 | 132 | 62 | 10 |

Why QQQ:

- QQQ lists a contract expiring every session, so it always trades on the same day's expiry.
- It must meet the index volume floor (5,000), and as an index name it is never skipped for earnings
  (`contract.index_names`).
- Until now it traded only when there was no focus for the session, or too few focus names could be traded
  (DEC-0032).

Over the same sessions the clone filled 18 entries on 11 of the 21 sessions. On the other 10 it took none.

## Decision

1. **QQQ is a standing name** (`config/options_clone.yaml`, `names.standing: [QQQ]`).
   - It is added every session after the focus names, and is not counted in `max_names`, so it never displaces a
     focus name.
   - If QQQ is itself a focus name, it is traded as one, never twice.
   - Like any name, it is dropped for the day when it has no expiry the policy allows, or its daily bars cannot be
     read.
   - The `names` journal line lists it under `standing`.
2. **Unchanged:** the top-up rule (`top_up: [SPY, QQQ]`, `min_names: 2`), the fallback and the expiry policy
   (`nearest`).
3. **Unchanged:** every gate (trend, extension, room, reach, shock, macro, earnings) and the setups.
   - The trend gate still reads SPY against its VWAP for QQQ, as for every name.
   - QQQ's levels come from the edition when the edition carries it, otherwise from the tape (DEC-0033).
4. **Unchanged:** the contract floors and caps (the index volume floor of 5,000, both spread caps, the $15.00 ask
   cap, the delta floors, no open-interest floor), the entry limit, one contract, the exits, the latches and the
   15:10 flatten.
5. **Unchanged:** the money limits (`config/risk.yaml`, key O).
   - One open position at a time, at most 5 entries a day and 2 a name.
   - QQQ competes for the same single position as every other name.
6. **A new experiment, EXP-0040.**
   - The clone's three trials (HYP-0029 `retest`, HYP-0030 `rejection`, HYP-0031 `nearest`) are run again under
     the new names as **three new trials**. Family O goes from 44 to **47**.
   - Each verdict needs a fresh 30 trades and 20 sessions from the first session under this rule, with the test of
     DEC-0030 section 6.
   - `wt.options.review` reports the window apart (`qqq`). The nightly review prints and stores only its trade and
     session counts until the report is written, as it does for EXP-0039.
   - If DEC-0057 is accepted, the Paper page treats EXP-0040 as it treats EXP-0039.
7. **Effective first session: Thursday 2026-11-19**, on the condition that the release reaches the host after the
   2026-11-18 session and before the 2026-11-19 arm (09:25 New York).
   - The release into `main` therefore goes in only after the 2026-11-18 close.
   - If the release lands at any other time, earlier or later, a one-line amendment to this record moves
     `NO_OI_END` and `QQQ_START` to the first session that ran with `names.standing`. The `names` journal line
     shows which session that was, under `standing`.
   - That amendment is written before that session's trades are viewed.
   - **Amended 2026-11-18 (New York), before any 2026-11-18 trade was viewed: the dates stand.** The release landed
     early: the host deployed it at 00:47 New York on 2026-11-18, before that session's arm. But QQQ was a focus name
     that day, so the 2026-11-18 `names` line shows `standing: []`, and the session's names and gates are the same
     under DEC-0056 alone. 2026-11-18 stays EXP-0039's one session: `NO_OI_END` stays 2026-11-18 and `QQQ_START`
     2026-11-19. The owner chose this reading in chat.
   - From 2026-11-19 every session counts toward EXP-0040, whether or not QQQ is also a focus name that day. An empty
     `standing` on a later session never moves the start again.
   - Disclosure: after this amendment was written, at 11:06 New York on 2026-11-18, the author's supervision check
     printed that session's one closing line (trade 2026-11-18-O-1), its outcome included. The dates above were fixed
     before that trade existed.
8. **EXP-0039 closes at 2026-11-18** with one session (`wt.options.review.NO_OI_END`).
   - Its trades never count toward EXP-0040.
   - It cannot reach 20 sessions, so it gives no verdict. It is kept as a record, as EXP-0029 was.
9. **The pipeline check judges QQQ as a name the clone trades** (`wt.options.pipeline_check.STANDING`). A
   difference on QQQ's edition levels then fails, rather than warns.
10. **EXP-0037 (DEC-0054) is unaffected.** Its replay trades SPY and QQQ from its own fixed inputs and never reads
    the names block.
11. **The research arms (DEC-0041) already ended under DEC-0056.** Nothing more ends.

## Disclosure

The author read, while writing this record:

- The clone's decision lines for 2026-10-20 to 2026-11-17: signals, which gate refused which signal, and whether a
  contract passed, by name. Counts only.
- The clone's journal: per-session counts of entries sent and filled, and the `names`, `armed` and `session_end`
  lines.
- One trade of EXP-0029's window, 2026-11-16-O-1 (a `retest` put), in a supervision check.
  - Its quoted ask, its slippage and its exit reason (time).
  - Before that check was narrowed on 2026-11-17, a dry run also printed the trade's best and worst bid while it
    was open. That is an outcome of the trade, though not its return.
- The pipeline-check reports, and the other session's supervisor report of 2026-11-18.
- Robot B's `session_end` line for 2026-11-17, which was printed by a log search. Robot B is another desk and
  outside family O.

Seen before this work:

- **The author saw EXP-0029's running figures on 2026-11-16,** as DEC-0054 and DEC-0056 disclose.
- **The author knows EXP-0025's result,** the one historical dry run of the clone's rules, which was on SPY and
  QQQ. It found the rules lose on average.

The rule was not chosen from either. It follows from the gate counts above, and the owner chose when it starts
before any trade under it can exist.

What the author did not see:

- No return, R or P&L figure of any clone trade in this work.
- No running figure of EXP-0039 or of any arm.

No backtest or replay of this rule was run.

## Amendment (2026-11-18, New York, before any trade of that session was viewed)

Point 7's condition did not hold. The release carrying this record reached the host before the 2026-11-18 session,
not after it, so the first session that ran with `names.standing` is **Wednesday 2026-11-18**.

- **Evidence:**
  - The host's deploy record `var/deploy/20261118T054701Z.json` (00:47 New York) moved the working tree to `e7ad6a4e`,
    which contains this record's commit. The next deploy (`20261118T094707Z`, 04:47) kept it.
  - At the 09:25 arm the host's `config/options_clone.yaml` held `standing: [QQQ]`, and the `names` journal line had a
    `standing` key.
  - That key is empty for 2026-11-18 because QQQ was already a focus name that day; it was traded once, as point 1
    says. The `names` line alone therefore does not show the date, and the deploy record does.
- **Moved, as point 7 provides:** `NO_OI_END` to 2026-11-17 and `QQQ_START` to 2026-11-18 (`wt.options.review`).
- **Point 8 changes with it.** EXP-0039 holds **no session**, not one. DEC-0056's rule and this one reached the host
  before the same session, so no session ran under DEC-0056 alone. Its window ends before it starts, and the Paper
  page no longer lists it. The owner accepted one session; zero follows from the same release order.
- **Unchanged:** every rule in the Decision, the trial count (family O 47) and EXP-0040's verdict test.
- **Seen of 2026-11-18 before this amendment:** the units' state and the paper check at 09:02, the pre-open pipeline
  check's counts, and the `names` and `armed` lines at 09:25. No decision line, entry, fill or trade of that session.

## Not changed

- The owner's own trade rules on the dashboard.
- The board's contract pick (`dashboard/src/lib/contract-pick.ts`).
- Robot B and every other desk.
