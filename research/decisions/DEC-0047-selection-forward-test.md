# DEC-0047: Whether the two-stage selection picks better names is measured once, forward, from the switch

- **Status: ACCEPTED on 2026-11-12.** approved_by: owner. Proposed on 2026-11-12 (#406) and accepted by the owner's
  merge of the pull request that changed this line, which also accepts the proposals listed under "Choices the owner
  makes by accepting this record". Acceptance registers the experiment; it starts nothing. Nothing below starts before
  the four preconditions of section 10 are met, DEC-0048's switch among them: no session is counted, no outcome is
  scored for this experiment and nothing is read.
- **Authority.** This is the registration DEC-0035 section 3 requires before the card plan is evaluated, and the only
  place a claim about the selection's accuracy may come from (DEC-0046's opening lines and section 8). The five-session
  gate of DEC-0046 section 7 is an operational release gate and is not evidence of accuracy.
- **Written before any affected P&L is viewed.** The affected P&L of this experiment is the forward window from the
  switch, and none of it exists yet: no session of the new selection has been picked, scored or read. The first
  author ran no code of the ledger repository and computed nothing from any result. The ledger's source code and
  schemas were read at commit `8130c7c460ffa08cb2d54af49d1c05ab89c215b3` of `Algorythmos-AI/focus-card-ledger` to copy
  its outcome rule. **Disclosure, in full:** in that reading the first author also opened three files that hold
  results of the previous picker, then stopped:
  - `README.md`: lines 1 to 60 (the head of its scorecard: the "Published cards" and "Last 20 published sessions"
    tables, which give for the old picker's published cards the count of setups, the trigger, fill, target-1, stop and
    target-2 rates with their ranges, the average and total R under the three exit policies, the option P&L over its
    trades, the average best and worst move, the median minutes to target 1 and the bias hit rate, and the line giving
    the count of published and rebuilt sessions), the headings of the rest, and lines 132 to 174 (rule prose, layout,
    commands). The rebuilt-history tables (lines 61 to 130), among them the one by card rank, were not read.
  - `docs/daily-runbook.md`: the whole file, which is procedure (times, commands, the option strike walk) and holds no
    outcome figure.
  - `tests/test_ledger.py`: a test fixture built from one real session of the ledger (2026-10-28): its four names and
    that day's counts of sides, fills, target-1 exits and stops, its total R and its option result.

  All of it concerns the old picker's four names only; none of it splits picked names from others, and no figure of
  the new selection exists. The first author believes none of it shaped the design. The outcome rule below is copied
  from the source files only (`ledger/score.py`, `ledger/card.py`, `ledger/common.py`, `ledger/bars.py`). The window,
  the unit, the outcome, the five hypotheses, what "supported" means and the pre-set action were fixed in the
  owner-approved plan of 2026-11-11, before any drafting. Every choice the plan left open is listed in "What the plan
  left open" below, with who made it, so that a reader can judge each one.
- **Revised blind.** On 2026-11-12 a reviewer who had seen no result of any picker, card, ledger, clone or owner trade
  reviewed the first draft without seeing any result. The same person then revised this record, its hypotheses,
  EXP-0032 and the registry row as the blind editor. The editor read only the seven ledger source files
  (`ledger/score.py`, `card.py`, `common.py`, `bars.py`, `validate.py`, `schema/prediction.schema.json`,
  `schema/outcome.schema.json`) at the commit above, and no README, document, test or data file of that repository.
  Every choice the plan left open now stands as the blind editor wrote it or confirmed it.
- **Rests on DEC-0035 section 3 and amends nothing.** DEC-0035 section 3 allows an evaluation of the card plan that
  is registered, with its own hypothesis, experiment and decision record, before any result is viewed, with its
  numbers frozen at that point and not taken from the display. This record is that registration for EXP-0032. Its
  verdict reads no dashboard file (not `focus-plan.ts`). It works out the card plan's numbers through the ledger's
  copy of the arithmetic (`ledger/card.py` at commit `8130c7c…`), frozen in section 3 below. EXP-0032's report is a
  result of the selection under this record, not a result "of the focus-card plan" under DEC-0035 section 2.
  DEC-0035 is not amended: its numbers and its section 1 stay as they are. So no early end that names an amendment to
  DEC-0035 (EXP-0031, EXP-0033) is triggered. **It changes no rule of DEC-0046.**
- **Registers** EXP-0032 with HYP-0051 to HYP-0055: a new trial family F, total 5, counted apart from the global, C, O
  and M families (`config/trial_registry.yaml`, an `accepted` row since this record was accepted).
- **Depends on:** DEC-0005, DEC-0032, DEC-0035, DEC-0042, DEC-0044, DEC-0045, DEC-0046, DEC-0049, DEC-0050.
- **Experiment:** EXP-0032. **Hypotheses:** HYP-0051, HYP-0052, HYP-0053, HYP-0054, HYP-0055.

## Choices the owner makes by accepting this record

Each item below is written into the record as proposed. Merging the record accepts the proposal. The owner can instead
pick the alternative by changing the record before merging it.

1. **What counts as a picked name's result when its setup triggers but never fills?** (Section 3, HYP-0051 to
   HYP-0055.)
   - *Proposed:* the plan's wording, restored. The primary is mean R per **triggered** side. A triggered side with no
     entry (`no_fill`, `failed_before_retest`) scores R = 0, because no trade was made. A session is excluded only
     when either group has no triggered side. The entry rate (names entered ÷ names triggered) is reported beside the
     result, with no test.
   - *Alternative:* R per scored name, a name with no trigger also scoring 0. This drops every exclusion that depends
     on what the session did. It also credits a selection whose names trigger more often, and adds more zeros, so a
     given difference reads smaller.
   - *Not proposed:* the first draft's mean R per **entered** side. It conditions the comparison on fills, an outcome
     after the selection is made. It also drops sessions in which the four picks did not fill, which is not symmetric
     between a group of four and a group of eight.
2. **What are the picks compared with?** (Section 2, HYP-0051, HYP-0054, HYP-0055.)
   - *Proposed:* "the rest" is the Stage 1-eligible scored names that were not picked. Ineligible names
     (`earnings_gap`) and unranked data-valid names (`benchmark_missing`) are reported descriptively only. HYP-0054
     correlates rank with R over ranked eligible scored names. HYP-0055 compares Pass B statuses over eligible scored
     names (Pass B gives `no_longer_qualifies` to a name whose earnings came out since Stage 1, so earnings names
     would otherwise crowd one of its groups).
   - *Alternative:* all other data-valid names, as the plan's words "every data-valid name" could be read. That would
     mix in names reporting earnings around the session, which the selection is forbidden to pick. The comparison
     would then partly measure "earnings day against no earnings day", not the skill of the choice.
3. **Which tests decide whether Stage 1's scoring stays, and how strictly?** (Sections 6 and 9.)
   - *Proposed:* HYP-0051 (the primary) and HYP-0053 (picked against the fixed rule) are each tested on their own at
     a one-sided 0.025 level. HYP-0053 is co-primary for the pre-set action only. HYP-0052, HYP-0054 and HYP-0055 are
     Holm-adjusted across the three. Keeping the scoring needs both HYP-0051 and HYP-0053 to be supported, which is
     already the stricter rule and needs no further correction. Replacing the scoring is the choice of the simpler
     rule when the more complex one has not been shown better. It is not a finding that the fixed rule is better.
   - *Alternative:* the plan's four-way Holm across HYP-0052 to HYP-0055. HYP-0055 is expected to close inconclusive
     and then enters with p = 1, so HYP-0053 would usually need p at or below 0.025 / 4 = 0.00625. That makes the
     scoring very likely to be replaced even when the selection is genuinely better than the fixed rule.
4. **What happens when the experiment ends early, or when the blind rule is broken?** (Sections 1, 8 and 9.)
   - *Proposed:* every early end closes the experiment with no verdict, whatever the counts, and counts as
     inconclusive for the pre-set action. A breach of the blind rule makes the experiment unreadable, and that also
     counts as inconclusive. **Either one means Stage 1's scoring is replaced by the fixed rule.** The five trials
     stay counted.
   - *Alternative:* the first draft's rule, under which an early end is read at that point (with at least 60
     sessions). Every early end is in the owner's hands (a change to the selection, the card numbers or the outcome
     rule), and the owner sees the picked names' results every day. That rule would let the read be timed for a
     good moment, the optional stop DEC-0050 point 4 refused for EXP-0033. Without a stated consequence for a breach,
     a breach would be a way out of the pre-set action.
5. **What may be shown before the read?** (Section 8.)
   - *Proposed:* before the read, no outcome of a name that was **not** picked is shown to anyone, singly or in
     total. The picked names' records and totals, the clone's results and the owner's own trades may be shown,
     because they say nothing about the rest. No page compares picked with not-picked names, or totals by rank,
     score, eligibility or Pass B status. Two tests enforce it (section 8). The owner can still watch the other
     names' charts: informal judgement cannot be sealed. What protects the result is the fixed read date, early ends
     with no verdict and the fixed pre-set action.
   - *Alternative:* the first draft's rule, which sealed every total over the picked names. That would black out the
     ledger review panel on the Options page for the whole window, and arguably makes the clone's pages and the
     owner's own Trades page a breach from the first day.
6. **How to read "falsified".** (Limits, section 5.)
   - *Proposed:* with about 120 sessions, only a difference of roughly a third of an R per triggered side or more is
     likely to be shown (the arithmetic is in Limits, worked out from the rule's construction, not from any result).
     "Falsified" means only that the registered condition was not met. The point estimate and its range are
     reported beside every label, so the size of a difference can be read even when it was not shown.
   - *Alternative:* a longer window or a lower bar. Either is a new registration, and neither is proposed.
7. **The card fields of every data-valid name are a precondition.** (Section 10, precondition 2.)
   - *Proposed:* no session counts until Stage 1's output carries the card fields of every data-valid name, not only
     of the picks. Those fields come from the card-field code of DEC-0046 section 6, which waits on a file the owner
     has not yet supplied. Until the owner supplies it the experiment cannot start.
   - *Alternative:* score only the names whose card fields are published. That would leave no rest to compare with,
     so the experiment could not run.

## Why

DEC-0046 replaces the cloud picker with a replayable two-stage selection and says, in its opening lines, that passing
its gate proves only that the code runs. Whether the names it picks behave better than the names it leaves is a
separate question. It can only be answered on sessions nobody has seen yet, because the owner has seen the previous
picker's history and no holdout exists. So the window, the unit, the outcome, the tests and the response to each
result are fixed here first, and the results are read once.

## Decision

### 1. The window and the sessions counted

- **Start.** The first regular New York session `S` on which the edition's focus names are the Stage 1 picks, under
  the switch DEC-0048 makes (precondition 4 below), once preconditions 1 to 3 are met. Forward only; never
  backfilled.
- **A session `S` is counted** when all of these hold:
  1. it is on or after the start, and the edition's focus names that day are the Stage 1 picks for `S`. A session on
     which the switch was reverted is not counted (`not_switched`). A revert is made only by a dated note in
     EXP-0032's README written before 09:30 New York on the first session it affects, and every revert is listed in
     the report;
  2. a Stage 1 output for `S` exists (the session `D` it scored being the session before `S`) and was published
     before 09:30 New York on `S` (otherwise `no_stage1`). It carries the `params_sha` in force at the first counted
     session (otherwise `other_params`; DEC-0046 section 4;
     `08617613bced71e4c7b7b022ca1cc34070d885d5eae17c438f39e80284e88e23` unless a dated amendment changes it before
     the switch, and the value used is written in EXP-0032's README at the first counted session);
  3. the ledger holds a prediction for every data-valid name of that output (precondition 1), each not `backfilled`,
     whose commit reached the ledger's default branch before 09:30 New York on `S`. The time that counts is the
     remote's push time, not the record's own `recorded_at` field. Otherwise `no_prediction`;
  4. the session's SIP bars were fetched and saved as section 3 says. A session whose fetch never succeeded is not
     counted (`no_bars`).

  A session that fails any of these is listed with its reason in the report and takes no part in any test.
- **Read once,** at the first of: the 120th counted session, or the end of the session of 2027-09-30. The read uses
  the counted sessions up to and including the 120th, or all counted sessions dated on or before 2027-09-30. It runs
  once, after the last of their outcomes is recorded. Sessions after the 120th are not used.
- **Who reads, and how.** The coordinator session on the console Mac runs the read, in a worktree of an up-to-date
  `origin/main`. It runs the analysis code at the commit recorded in EXP-0032's README (precondition 3); the read
  refuses to run if any analysis file differs from that commit. The report carries that commit, the command run and
  the SHA-256 of every input (the predictions, the Stage 1 outputs, the Pass B records and the saved bars). A run
  that stops before printing any statistic may be run again, after a fix recorded in a dated note in EXP-0032's
  README. A run that printed any statistic is never repeated, and the report is written once.
- **Inconclusive by count.** With fewer than 60 counted sessions when the read is due, every hypothesis is
  inconclusive and no test result is worked out.
- **Early ends.** The window ends at the last session before any of these reaches production:
  - a dated amendment to DEC-0046 that changes the selection (`params_sha`, or a code change it records as a change
    to the selection);
  - a change to the universe (`config/options_desk.yaml` `names`);
  - a change to the code that works out the card fields (DEC-0046 section 6: ceiling, floor, targets, bias);
  - an amendment to DEC-0035 that changes a card number;
  - a change to the frozen outcome rule (section 3);
  - a change to the analysis code of precondition 3 other than a defect fix made as section 10 allows.

  **Every early end closes the experiment with no verdict:** no statistic is worked out, whatever the counts. The five
  trials stay counted, and the date and cause go in EXP-0032's README. For section 9 an early end counts as
  inconclusive. A breach of section 8 makes the experiment unreadable instead, which also counts as inconclusive.

### 2. The unit

- **Every data-valid name on every counted session**: each of the twelve names that Stage 1 marks data-valid
  (DEC-0046 section 3, validity checks 1 to 5) and whose card fields are published for `S` (precondition 2). Each has
  card fields, so each can be scored by the same rule.
- **Counted, not scored**, each with its reason in the report:
  - a name not data-valid (its validity reason);
  - a name with `internal_error`;
  - a data-valid name without card fields (`no_card_fields`);
  - a name with a split ex-date on `S` in Alpaca's corporate actions (`split_on_session`: its raw bars are not in the
    units of its levels);
  - a name whose bars are not usable (`bars_incomplete`, section 3);
  - a name with neither side's level (`no_level`);
  - a name whose two sides trigger on one bar (`card_fault`, section 3).
- **Groups.** *Picked*: the Stage 1 picks for `S` (the first `min(4, eligible)` eligible names by final rank,
  DEC-0046 R6) that are scored. A pick that cannot be scored is missing, never replaced. *The rest*: the Stage
  1-eligible scored names that were not picked. Stage 2 never swaps a pick (DEC-0046 section 5), so the groups are
  Stage 1's. A pick keeps its group whatever its Pass B status. Ineligible scored names (`earnings_gap`) and unranked
  data-valid scored names (`benchmark_missing`) are in neither group. They are reported descriptively only (section
  7).

### 3. The outcome: the ledger's rule, verbatim

The outcome of a name is the ledger's own rule at commit `8130c7c460ffa08cb2d54af49d1c05ab89c215b3`, applied by the
same functions (`card.derive_levels`, `score.score`, policy `card`) to every scored name with the same bars. At the
read every outcome is recomputed from the saved predictions and the saved bars with the code of that commit, and
compared with the stored outcome; a mismatch is listed and the recomputed value is used.

**The card plan's numbers** (`ledger/card.py` lines 3 to 5, 16, 24 to 32), frozen here under DEC-0035 section 3 (not
an amendment):

> entry = level +/- 0.01 ATR, stop = level -/+ 0.1 ATR, T1 = entry +/- 2R, T2 = the card's named target.

```
NO_ENTRY_WINDOWS_ET = [["09:30", "09:35"], ["11:30", "13:00"]]
    level = item["breakout_above"] if side == "call" else item["hold_above"]
    entry = _r2(level + sg * 0.01 * atr)
    stop = _r2(level - sg * 0.1 * atr)
    t1 = _r2(entry + sg * 2 * abs(entry - stop))
```

`_r2(x)` is `round(x + 0.0, 2)`; `sg` is +1 for the call side and −1 for the put side; `atr` is the card's `atr`. A
side whose level is null has no prediction (`card.py` lines 54 to 55: "no level on that side ... the card shows no
plan for it").

**The rule** (`ledger/score.py` lines 3 to 9, scorer version 1.1):

> - Trigger: first bar CLOSE beyond the level.
> - Fill: a later bar touches the entry (call: low <= entry; put: high >= entry) and closes back on the
>   trade side of the level ("then a dip holds it" / "then a bounce fails under it"), outside the card's
>   no-entry windows (stored in New York time). A close through the stop before any valid retest kills the setup.
> - Stop: a bar CLOSE through the stop. Target: the bar's high/low reaches it.
> - Same bar reaches T1 and closes through the stop: flagged, scored as a stop (conservative).

and for the exit policy used here (line 11):

> card       T1 (exit at T1) or stop (exit at that close) or the session close.

**The governing lines of code** (`ledger/score.py`):

```
 29      return any(a <= hm < b for a, b in windows)                       # _blocked: bar start, New York
 36      risk = abs(entry - stop)
 51          stop_hit = i > fi and sg * (stop - c) > 0
 52          tgt_hit = target is not None and fav >= abs(target - entry)
 58          if tgt_hit and stop_hit:
 59              conflict = True
 60              return c, i, "stopped", ...
 61          if tgt_hit:
 62              return target, i, ... "target1", ...
 63          if stop_hit:
 64              return c, i, "stopped", ...
 67      return B["close"][-1], n - 1, "session_close", ...
 88      ti = next((i for i in range(n) if sg * (C[i] - lvl) > 0), None)
 94          touched = L[i] <= entry if sg > 0 else H[i] >= entry
 95          if touched and sg * (C[i] - lvl) >= 0:
 96              if _blocked(T[i], windows):
 98                  continue
101          if sg * (stop - C[i]) > 0:
102              o["result"] = "failed_before_retest"
111                       "r": round(sg * (px - entry) / risk, 2), ...
119      o["r"] = pol["card"]["r"]
```

In words, exactly as the code does it, for one side:

- **Trigger.** The first bar of the session (09:30 included, no window applies) whose close is strictly beyond the
  level: above it for the call side, below it for the put side. None: `no_trigger`, R null.
- **Fill.** From the bar after the trigger, the first bar that touches the entry (call: low ≤ entry; put: high ≥
  entry) and closes at or beyond the level on the trade side, and whose start time (New York) is not in [09:30, 09:35)
  or [11:30, 13:00). A touching bar inside a window is skipped and counted. If, before a fill, a bar closes strictly
  through the stop, the result is `failed_before_retest`; if the session ends first, `no_fill`. The ledger gives both
  a null R: no entry was made.
- **After the fill**, bar by bar from the fill bar itself: target 1 is reached when the bar's high (call) or low (put)
  reaches T1; the stop is hit when a bar *after* the fill bar closes strictly through the stop. **When one bar does
  both, the stop is assumed first** (`stopped`, exit at that bar's close, flagged `same_bar_conflict`). Target 1 alone:
  `target1`, exit at T1. Stop alone: `stopped`, exit at that close. Neither by the last bar: `session_close`, exit at
  the last bar's close.
- **R** = `round(sg × (exit − entry) / |entry − stop|, 2)`, on the stock, before any option cost. A target-1 exit is
  exactly +2 by construction (up to the rounding of entry, stop and T1); a stop exit is about −1 or worse, since it
  exits at a close beyond the stop.
- **Bias** (`score.py` lines 123 to 130), used only descriptively: "support" is right if the day's low stayed at or
  above the floor; "breakout" if the session closed above the ceiling; "range", or a null floor or ceiling, makes no
  call.

**Which side is the name's outcome, and the name's R.** The ledger scores each side on its own. Here the name's side
is **the side whose trigger comes first** (the earlier `trigger_time`). The other side is ignored, whatever it does
later. Then:

- a name with no trigger on either side is **not triggered**: it has no R and counts toward the trigger rate;
- a name whose first-triggering side filled is **entered**: its R is that side's card-policy R;
- a name whose first-triggering side did not fill (`no_fill`, `failed_before_retest`) is **triggered without an
  entry**: for this experiment its R is **0**, since no trade was made (the ledger's stored R stays null). It counts
  toward the entry rate.

"R per triggered side" below is the mean of this R over the triggered names (entered or not). Both sides cannot
trigger on the same bar unless the floor is above the ceiling; such a name is counted as `card_fault` and not
scored.

**The bars** (replacing the ledger's IBKR bars for this experiment, precondition 1):
- **Source.** Alpaca SIP, the consolidated tape: 1-minute bars with `feed=sip` and `adjustment=raw` named on the
  request, for regular hours. Only 1-minute bars whose start is at or after 09:30 and before 16:00 New York (13:00 on
  a half day, as `dashboard/src/lib/market-calendar.json` `half_days` gives it) are kept. A bar starting at 16:00
  (13:00), which can carry the closing auction, is dropped.
- **The fetch.** The bars of all scored names are fetched together, at least 30 minutes after the close (16:30, or
  13:30 on a half day), paged to the end and saved with their SHA-256. The first complete fetch is the one used and
  is never replaced; a failed fetch may be retried until 23:59 New York on `S`.
- **Joining into 2-minute bars.** The saved 1-minute bars are joined into 2-minute bars, so that the rule runs on the
  bar size it was written for (`bar_seconds` 120, `approximate` false). A 2-minute bar starts at 09:30 + 2k minutes,
  k = 0 to 194 (0 to 104 on a half day). It takes the first open, the highest high, the lowest low, the last close
  and the summed volume of the 1-minute bars whose start falls in it. A 2-minute slot with no 1-minute bar has no bar.
- **Usable bars.** Bars are usable when the first 2-minute bar starts at 09:30, the last starts at 15:58 (12:58 on a
  half day), and at most 5 of the session's 2-minute slots (195, or 105 on a half day) have no bar; otherwise
  `bars_incomplete`.
- **The session close** is therefore the close of the last 1-minute bar starting before 16:00 (normally 15:59; 12:59
  on a half day), not the closing auction (`bars.py` keeps 09:30 to before 16:00, line 22).

### 4. What is recorded per name, and when

Per name and session, written by the ledger and pushed to its default branch before 09:30 New York on `S`, never
edited: the card fields and the two side predictions; `picked`; the Stage 1 `score` and final rank; `eligible` and
its reason; `params_sha`, `picker_ref` and `bundle_sha`. The Pass B status is recorded once Pass B is published, as
its own append-only record. After the close: the bars and the two side outcomes, as the ledger's outcome schema holds
them, append-only. Recorded is not shown: see section 8.

### 5. Primary: HYP-0051, picked against the rest

- **Per session**: `D_s` = the mean R per triggered side of the picked names, minus the same for the rest (section 3:
  an entered name's card-policy R, 0 for a triggered name without an entry). A session where either group has no
  triggered name is excluded from the statistic and counted.
- **Statistic**: the mean of `D_s` over the included sessions, each session weighted equally.
- **Range**: 5,000 bootstrap resamples of the included sessions, with replacement, and the mean of `D_s` in each. The
  generator is mulberry32 seeded **20261147**, and the 2.5th and 97.5th percentiles are taken by numpy's linear rule
  (EXP-0032 `config.yaml` gives every step).
- **Halves**: the included sessions in date order. The first half is the first `floor(n / 2)` sessions and the
  second half is the rest; the mean of `D_s` is worked out in each.
- **Supported** only if the 2.5th percentile is above 0 **and** the mean of `D_s` is above 0 in both halves, with at
  least 30 included sessions. **Falsified**: the minimums met and the condition not met. **Inconclusive**: fewer than
  60 counted or 30 included sessions.
- **Beside every label** (no test): the point estimate, its 2.5th and 97.5th percentiles and the mean in each half.
  Also each group's trigger rate (scored names with a trigger ÷ scored names), each group's entry rate (entered names
  ÷ triggered names) and the counts of every exclusion.

### 6. Secondary and co-primary tests: HYP-0052 to HYP-0055

Each gives a one-sided p, `p = (1 + the number of resampled statistics ≤ 0) / 5,001`, from its own 5,000 session
resamples (mulberry32 reseeded with 20261147 for each).

- **HYP-0053 is co-primary for section 9 only.** It is tested on its own: **supported** only if its p, unadjusted,
  is at most 0.025 **and** its statistic is above 0 in both halves.
- **HYP-0052, HYP-0054 and HYP-0055 are Holm-adjusted across the three** at a family level of 0.025 one-sided. A test
  that is inconclusive enters with p = 1. Each is **supported** only if its adjusted p is at most 0.025 **and** its
  statistic is above 0 in both halves.
- Each of the four is **falsified** when its minimums are met and its supported condition is not. It is
  **inconclusive** below its minimums: at least 60 counted and 30 included sessions, and for HYP-0055 at least 30
  triggered names in each group. Each is reported with its point estimate, range and halves beside its label.

The four tests:

- **HYP-0052, picked against random draws.** Per session, `k` = the number of scored picks. A draw is `k` names taken
  without replacement from that session's Stage 1-eligible scored names, picks included, with 1,000 draws per
  session.
  - Each draw is a partial Fisher-Yates shuffle that starts from the names in symbol order.
  - The draws use one mulberry32 generator seeded **20261152** once, with sessions in date order and draws 1 to 1,000
    in order.
  - `D_s` = the picked names' mean R per triggered side, minus the mean, over the draws that hold at least one
    triggered name, of each draw's mean R per triggered side.
  - Excluded and counted: a session whose picks have no triggered name, or whose draws have none. The generator runs
    on through excluded sessions.
- **HYP-0053, picked against a fixed rule.** The fixed set is chosen before the open from the Stage 1-eligible names.
  - It holds SPY and QQQ, each when Stage 1-eligible, plus the two single names (of the other ten) with the highest
    Stage 1 ATR% (ATR14 ÷ close, rounded to 6 decimals) among the Stage 1-eligible ones. Ties go by symbol, A to Z.
  - A member that cannot be scored is missing and is not replaced. A name in both sets counts in both.
  - `D_s` = the picked names' mean R per triggered side, minus the same for the fixed set.
  - Excluded and counted: a session where either has no triggered name.
- **HYP-0054, Stage 1 rank against R.** Per session, the Spearman correlation `ρ_s` between the final rank and R over
  the ranked **eligible** scored names that triggered (average ranks for ties, then Pearson's correlation of the
  ranks).
  - Rank 1 is first, so the session statistic is `−ρ_s`, positive when better-ranked names do better.
  - Excluded and counted: a session with fewer than 3 such names, or with every R or every rank equal.
  - The statistic is the mean of `−ρ_s`.
- **HYP-0055, Pass B `confirmed` against `no_longer_qualifies`.** Over the Stage 1-eligible scored names of the
  included sessions, pooled: the mean R per triggered side of names whose Pass B status was `confirmed`, minus that of
  names whose status was `no_longer_qualifies`.
  - Resamples draw sessions, each bringing all its names. A resample with an empty group is discarded, and drawing
    continues until 5,000 are kept.
  - The halves split the included sessions in date order; a half with an empty group fails.
  - A session is **`unclassified`** when its Pass B was published before the amendment that freezes Stage 2's four
    thresholds (DEC-0046 section 5), carries a status outside DEC-0046's four (`confirmed`, `caution`,
    `not_confirmed`, `no_longer_qualifies`), or is missing or late (not published by 09:25 New York). Every name of
    an unclassified session is `unclassified`; those sessions are excluded from HYP-0055 and counted.
  - `caution` and `not_confirmed` names are in neither group and are counted.

### 7. Descriptive only, no test and no claim

Reported at the read, overall and for the picked names and the rest:
- SPY and QQQ against the ten single names (mean R per triggered side, trigger rate);
- among entered names, the share whose exit was `target1`, as target1 ÷ (target1 + stopped);
- how often the bias label was right: the ledger's `bias_correct` of the call side's record, or of the put side's
  when the call side has no level, over the names where it is not null.

Also reported, with no test:
- the ineligible and unranked scored names (mean R per triggered side, trigger rate, entry rate);
- the lag-1 autocorrelation of HYP-0051's `D_s` in date order;
- a 5-session moving-block bootstrap range for HYP-0051 as a sensitivity check, worked out as EXP-0032
  `config.yaml` says. It changes no label.

### 8. Blind until the read

- **The rule.** The ledger records the picked flag, the score, the rank, the eligibility and the Pass B status.
  Before the read, **no outcome of a name that was not picked is shown to anyone**, singly or in total, for any
  session from the start. An outcome here is the stock R, result, trigger or fill a ledger record holds, or anything
  worked out from EXP-0032's bars.
  - The picked names' records and totals may be shown, and so may the clone's results and the owner's own trades:
    they say nothing about the rest.
  - **No page, report, edition or script compares picked with not-picked names, or totals any outcome by rank,
    score, eligibility or Pass B status**, before the read.
  - The owner can still watch the other names' charts: informal judgement cannot be sealed. What protects the result
    is the fixed read date, early ends with no verdict and the fixed pre-set action.
- **The two tests that enforce it**, built with the ledger change, before the first counted session:
  - `tests/test_blind_until_read.py` in the ledger repository: for sessions on or after the start, no derived or
    published file (scorecard, report, edition) carries an outcome of a name that was not picked, and none carries a
    comparison of picked with not-picked names or a total by rank, score, eligibility or Pass B status;
  - `dashboard/test/ledger-blind.test.ts` here: the dashboard's ledger edition schema (`stocksdelta/ledger`) and the
    page that renders it accept no outcome of a name that was not picked and no total keyed by those fields.

  DEC-0046 section 7 already requires that the gate script (`scripts/select_gate.py`, with
  `tests/unit/test_select_gate.py`) reads no outcome.
- **A breach** is such a result computed or shown, by anyone, before the read. It makes the experiment unreadable:
  no test result is worked out, the five trials stay counted, and the date and what was seen go in EXP-0032's README.
  For section 9 an unreadable experiment counts as inconclusive. A new question then needs a new registration and new
  trials.

### 9. The pre-set action

If HYP-0051 or HYP-0053 is not supported (falsified, or inconclusive, which includes an early end and an unreadable
experiment), Stage 1's scoring is replaced by the fixed rule of HYP-0053. The fixed rule is SPY, QQQ and the two
Stage 1-eligible single names with the highest ATR%, under Stage 1's validity, eligibility and never-fill rules. The
replacement is made by a dated decision record written after the read. Only if both are supported does the scoring
stay. It is stated now so that the outcome cannot shape the response.

Replacing the scoring is the choice of the simpler rule when the more complex one has not been shown better. It is
not a finding that the fixed rule is better, and any claim about the fixed rule needs its own registration. The
other secondary and descriptive results inform no rule by themselves.

### 10. Preconditions for the first counted session

Nothing here is decided beyond these four, and no session counts until all four are met:

1. **The ledger change**, merged by the owner in `Algorythmos-AI/focus-card-ledger` and designed in its own pull
   request:
   - predictions for **every data-valid name** of the Stage 1 output, both sides where a level exists, from the card
     fields published for `S`. Today the ledger scores only the card's items (`card.py` line 51). The predictions are
     append-only and never `backfilled`, and the commit holding them reaches the ledger's default branch before 09:30
     New York on `S`. The push time is the time that counts, not the record's own `recorded_at`, which `validate.py`
     lines 37 to 41 check today;
   - per name: `picked`, the Stage 1 `score` and final rank, `eligible` and its reason, `params_sha`, `picker_ref`,
     `bundle_sha`, and the Pass B status as its own append-only record;
   - **the same consolidated bars for all names**: Alpaca SIP 1-minute bars, `feed=sip`, `adjustment=raw`, fetched
     and joined into 2-minute bars as section 3 says, saved with their hash and never overwritten. Today the bars are
     IBKR's 2-minute bars from `get_price_history` (`bars.py` lines 3 and 16), and a stored copy can be replaced by a
     "finer" one (lines 41 to 43);
   - outcomes append-only, like predictions (today `validate.py` line 4 guards only `predictions/`);
   - Alpaca's corporate actions read for each name and session, for `split_on_session`;
   - the scoring functions unchanged (`card.derive_levels`, `score.score`, scorer 1.1);
   - the blind rule of section 8 and its ledger test.
2. **The card fields of every data-valid name.** Stage 1's output (or the published edition) carries, for every
   data-valid name and not only the picks, the fields the ledger's functions read: `atr`, `breakout_above`,
   `hold_above`, `target_up`, `target_down`, `resistance.name`, `support.name`, `bias` and `close`. Stage 2 does not
   move them. These come from the card-field code of DEC-0046 section 6 (the copy of `focus.py`, proven by its parity
   test), which waits on a file the owner has not yet supplied.
3. **The analysis code, frozen.** This is the verdict script, the bar fetch and join, the usable-bars test, the
   first-trigger side rule and the R of a triggered name without an entry, the unit and group assembly, the
   generator, the bootstrap, Holm and the draws. Before the first counted session:
   - it is merged with unit tests on synthetic data only;
   - those tests include the generator's first outputs (mulberry32 seeded 20261147: 3209735247, 3386447078,
     1777139272; seeded 20261152: 2373859644, 3736099141, 333787253);
   - the dashboard blind test of section 8 is merged too;
   - the commit is written in EXP-0032's README, and the read runs at that commit.

   A defect found later is fixed only by a dated amendment written before the read. The amendment shows the defect on
   synthetic data and says that no outcome was viewed to find it. The verdict is then worked out by the amended code,
   and the report gives the result of the frozen code beside it. Any other change to this code is an early end.
4. **DEC-0048's switch**, which names the first session on which the edition's focus names are the Stage 1 picks.
   That session is written into EXP-0032's README.

## What the plan left open

The owner-approved plan of 2026-11-11 fixed the window, the unit, the outcome rule, the five hypotheses, what
"supported" means and the pre-set action. It left these choices open. The first author made each one first. The
blind editor kept each, changed it, or put it to the owner, as marked:

- **The R of a triggered side that never fills.** The first author gave it no R. The blind editor restored the plan's
  "per triggered side", with R = 0 (owner choice 1).
- **The bars.** SIP 1-minute bars joined into 2-minute bars, because the ledger's rule is written for 2-minute bars;
  usable when the first bar starts at 09:30, the last at 15:58 (12:58), with at most 5 empty slots. The blind editor
  kept this and fixed the window of kept bars at 09:30 to before 16:00 (13:00).
- **"The rest".** The first author included ineligible and unranked names. The blind editor restricted it to
  eligible names not picked (owner choice 2).
- **The sessions counted and the reasons for not counting.** Kept. The blind editor added the reason codes
  `no_stage1` and `other_params`, the push-time rule for predictions and the dated note for a revert.
- **Early ends and breaches.** The first author had early ends read at that point, and breaches with no consequence
  for section 9. The blind editor made both inconclusive with no verdict (owner choice 4). The blind editor also
  added the universe, the card-field code and the analysis code to the early ends.
- **Numbers.** Kept: at least 60 counted and 30 included sessions; for HYP-0055 at least 30 triggered names in each
  group; p = (1 + count ≤ 0) / 5,001; mulberry32, seeds 20261147 and 20261152; 1,000 draws per session by partial
  Fisher-Yates; halves split at `floor(n / 2)`. The level is one-sided 0.025, with the Holm family changed to three
  tests (owner choice 3).
- **HYP-0053's fixed rule.** Kept: ties by symbol, a missing name not replaced, a shared name counted in both. The
  blind editor moved the choice of the set to before the open, from eligible names, to match section 9.
- **HYP-0054's statistic.** Kept: minus ρ per session, at least 3 names. The blind editor restricted it to eligible
  names.
- **HYP-0055.** Kept: `confirmed` against `no_longer_qualifies`, pooled over names with session resampling,
  `caution` and `not_confirmed` in neither group, `unclassified` sessions excluded and counted. The blind editor
  restricted it to eligible names and corrected the count of DEC-0046's statuses to four.
- **The blind rule's scope.** The blind editor rewrote it (owner choice 5).
- **The read.** Who runs it and how, the frozen analysis code and the crash rule were added by the blind editor.
- **Descriptive items.** Added by the blind editor: the ineligible and unranked names, the lag-1 autocorrelation and
  the block bootstrap.

## Limits

- **R on the stock is not option P&L.** A name that does better in stock R may not do better in the owner's options
  (premium, spread, decay and the −25% option stop all differ). This experiment says nothing about option results.
- **Sessions are not independent of each other.** The same twelve names recur every session, picks persist from
  day to day, and a market-wide move touches all of them.
  - Taking the within-session difference and resampling whole sessions keeps each session's names together, so it
    respects the correlation inside a session.
  - It does not address dependence across sessions (trends and volatility regimes that last for weeks), so the range
    may be too narrow when such regimes dominate.
  - The halves condition is a partial guard against one regime carrying the result. The lag-1 autocorrelation and
    the block-bootstrap range are reported beside it.
- **120 sessions is a modest sample.** This is worked out from the rule's construction and from assumptions, with
  nothing that has been observed.
  - A triggered name's R is about −1 (or a little worse) on a stop, 0 with no entry, +2 at target 1, or something
    between on a session-close exit. One name's R therefore varies by roughly 1.2 to 1.5 R.
  - A session's group mean rests on a few names, so `D_s` varies by roughly 1 to 1.3 R. With about 100 included
    sessions the standard error of the mean is about 0.1 to 0.13 R.
  - To be shown with a probability of about 80% at a one-sided 2.5% level, a true difference must be about 2.8
    standard errors: **about 0.3 to 0.37 R per triggered side, roughly a third of an R**. With only 60 sessions it
    is about 0.4 to 0.5 R.
  - A smaller true edge will most likely not be shown. Under this record's labels it will most often read
    "falsified". **Here "falsified" means only that the registered condition was not met.** It is not evidence that
    the selection is no better than the rest. The point estimate and its range are reported beside every label, so
    the size of a difference can be read even when it was not shown.
- **The previous picker's history has been seen.** The owner has seen it, including the rebuilt 158 sessions, and so
  have those preparing this work (the disclosure above). There is no holdout. That is exactly why the test is
  forward-only from the switch: the affected P&L is the forward window, none of which exists yet.
- **Multiple tests.** HYP-0051 alone answers the question this record asks. HYP-0053 joins it only for the pre-set
  action, and requiring both is stricter than either. The other three secondaries are Holm-adjusted, and the
  descriptive items carry no claim.
- The rule fills at the entry price exactly and exits at T1 exactly; it ignores slippage, as the ledger does. Both
  groups are scored the same way, so the comparison is fair, but the levels of R are optimistic.

## What it does not do

- It changes no rule of DEC-0046, DEC-0035's card numbers or any other record's frozen value. It amends no record:
  the card plan's numbers are frozen under DEC-0035 section 3, which provides for this registration.
- It starts nothing until DEC-0048's switch, and reads nothing before its single read.
- DEC-0046 section 7 already says that no gate night runs, and that DEC-0048 is not proposed, before this record is
  accepted. It also says that nobody compares the outcomes of the old picks with the new ones before this record's
  single read. No comparison with the old picker's names is registered here; any such comparison needs its own
  registration.
- It adds no factor, weight or threshold, and no outcome is ever a reason to change one before the read.

## Consequences

- The Options page shows the measurement line ("Selection not yet measured: N of 120 sessions") until the read, N
  being the counted sessions of section 1. The ledger review panel may go on showing the picked names' records and
  totals. It shows nothing of the names that were not picked.
- The ledger change, the card fields of every data-valid name, the frozen analysis code and the blind tests must all
  ship before the first counted session. Until they do, sessions after the switch are not counted (they are listed
  with their reason).
- If the read does not support both HYP-0051 and HYP-0053, or the experiment ends early or is unreadable, the
  selection's scoring is replaced by the fixed rule, as section 9 says.
