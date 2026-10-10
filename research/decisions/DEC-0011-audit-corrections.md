# DEC-0011: Audit corrections (September 2026)

- **Status: PROPOSED, awaiting owner approval in chat.** Nothing below is run until the owner approves this record.
  The code corrections can land before then; the P&L they affect is not computed.
- **Date drafted:** 2026-09-29, before any affected P&L was computed.
- **Source:** the September 2026 engineering and research audit (plan v2, workstream E).
- **Owner decisions already given (2026-09-29, in chat):**
  - Strategy B's data bug: record first, then re-run.
  - The two biased legacy forward strategies: fix them and restart from zero.

## Why

The audit found data and evaluation defects that bias recorded results. The test suite was green: these are logic
bugs the tests did not cover.

| Id | Defect | Affected records |
|---|---|---|
| R-C1 | `etf_minutes` asked for "the 1st of next month" as an inclusive date, so each month file also held the next month's first session: 23,400 duplicated bars per symbol (SPY, QQQ, IWM, …). B counts bars by position, so on about 60 days its signal checks and its 14-day sigma were wrong. | EXP-0005, EXP-0005b, EXP-0006, EXP-0006b, EXP-0011 (holdout), EXP-0012 |
| R-C2 | Split factors are never re-fetched for symbols already in the table, so a new split on a forward day enters ranking as a fake gap. | Forward round-3 and legacy watchlist trials from 2026-09-28 |
| H-REV | REV-1 warms up on prior-session bars that are not split-adjusted. | HYP-0019 (not yet run on P&L) |
| H-LA | The HOD bull flag filters on full-day volume, and the watchlist bull flag on the 09:30 open gap. Both are look-ahead. | EXP-0008, EXP-0013, EXP-0014 and their forward rows (`watchlist_bull_flag_atr_M1`, `hod_bull_flag_atr_M1`) |
| M-FILL | Profit targets fill on a touch, and stop slippage is never stressed. | All backtests; round 3 before its P&L is viewed |
| M-STAT | The bootstrap resamples trades, not days, although trades cluster by day. DSR can take the experiment's own trial count instead of the global one. $ P&L comes from nominal risk, not `Trade.pnl`. | All reported CIs and DSRs; round-3 evaluation |

The other data findings are also corrected in code; they change no recorded conclusion on their own:
- update chunks overriding later rebuilds;
- GG-4 and 1-minute ORB searches that stop instead of continuing;
- the stagnation stop firing a minute late;
- non-atomic caches.

Known and **not yet corrected** (a 2026-09-29 re-audit found an earlier draft of this record listed them as fixed):
- the EDGAR `known_from` date is still the period end plus 5 days, not the filing date (`wt.data.edgar`); the fix
  needs a fresh download and gets its own decision record;
- the forward universe is still read from a static asset list (no `first_seen` refresh).
Neither feeds strategy B or the re-runs below.

## Decision (proposed)

1. **Code corrections.** Every defect above is fixed in code, with a test pinning it. The ETF loader now removes
   duplicates, then asserts that no `(symbol, t)` repeats (`wt.data.quality`).

2. **Pre-declared re-runs.** Each gets a new experiment id, because experiments are append-only. Each writes a run
   manifest (git SHA, config and lockfile hashes, data-snapshot hash). **Both old and corrected numbers are
   reported side by side.**
   - **EXP-0016, data-only re-run of EXP-0005b** (B and A on SPY and QQQ, development span). The methodology is
     unchanged; the only difference is that duplicates are removed.
   - **EXP-0017, corrected-methodology re-run of EXP-0005b:**
     - target fills need a trade-through;
     - a separate stop-slippage stress;
     - day-block bootstrap;
     - DSR at the global trial count.
   - **EXP-0018, re-score of the EXP-0011 holdout** on de-duplicated data, with parameters frozen exactly as
     EXP-0011 ran them.
   - **EXP-0019, data-only re-run of EXP-0006/0006b** (the ETF random-entry controls), so B's control comparison
     uses the same corrected data.
   - **EXP-0020, data-only re-run of EXP-0012** (B on IWM and DIA).

3. **The holdout is consumed.** EXP-0011 was viewed once, so EXP-0018 is a second look at the same period.
   - **It can demote B, never promote it.** If the corrected holdout is worse than recorded, B's status follows the
     G1 criteria mechanically. If it is better, B's recorded holdout evidence is *not* upgraded.
   - **No parameter of B may change because of any corrected result.**

4. **Selection bias is stated, not hidden.** B was chosen from 75 trials evaluated partly on contaminated data.
   Every ETF-track trial touched by R-C1 is re-run on corrected data (items 2 and 5). `G1_SUMMARY.md` gains a
   section saying so, whatever the outcome.

5. **Trial count.**
   - The re-runs in item 2 are corrections of existing trials, not new hypotheses, so the global count stays at
     **85**.
   - The two legacy forward strategies are re-specified without look-ahead: the HOD flag selects on cumulative
     volume up to decision time, and the watchlist prefilter uses pre-market data only. These are **new trials:
     the global count goes from 85 to 87.**
   - Their existing forward rows are archived and tagged `biased`, and their forward records restart from zero.

6. **Round 3.**
   - Forward round-3 sessions recorded before the corrections are deployed are tagged `pre-correction` and excluded
     from round-3 scorecards.
   - The corrected fill model and statistics (M-FILL, M-STAT) apply to round-3 evaluation before any round-3 P&L is
     viewed. That keeps DEC-0010's pre-registration intact.

7. **Until this record is accepted**, the dashboard shows B as "under re-evaluation (DEC-0011)".

## After approval

1. Set this record's status to `ACCEPTED`, with the approval date.
2. Run EXP-0016 through EXP-0020 with manifests.
3. Update `research/G1_SUMMARY.md` and `research/active_strategies/` (B's entry) with old and corrected numbers
   side by side.
4. Record the outcome in DEC-0012.

## Note on the ids named above (added 2026-10-11; nothing above is changed)

This record was drafted on 2026-09-29 and names EXP-0016 to EXP-0020 and DEC-0012 for its re-runs and its
outcome. While it waited for approval those ids were taken by the crypto desk's records (EXP-0016 to EXP-0022,
DEC-0012). The numbers above therefore no longer point at these re-runs.

When this record is approved, each re-run and the outcome record take the next free id at the time they are
registered, and the experiment's own record names the paragraph of this decision it carries out. No re-run has
been registered or run.
