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
- Precondition 1, the per-slot range baseline in production, its commit: not yet.
- Precondition 2, the read script merged, its commit: not yet.
- Precondition 3, the outcome code merged and frozen, its commit: not yet.
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
- Engine identity checks (yes or no, with counts): none.
- Defect fixes to the outcome or signal code before the read: none.
- Early end, with its cause: none.

## Verdict

- Read once, by the read script, which writes its report into this folder and refuses to write over an existing one.
- The report is never shown on the site. After both reads, this one and EXP-0033's, the site may show its SAFE
  figures only: the counts, the estimate, its range and the verdict.
- Supported: the tag becomes "Stock test passed (HYP-0059); option result not tested". Anything else withdraws the
  words; the gates stay as plain facts.
