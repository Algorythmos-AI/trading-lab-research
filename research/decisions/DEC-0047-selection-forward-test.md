# DEC-0047: Whether the two-stage selection picks better names is measured once, forward, from the switch

- **Status: PROPOSED on 2026-11-12.** Drafted for the owner to change or accept. It becomes ACCEPTED only when the
  owner merges a pull request that says so in this line. Nothing below starts before that, and nothing starts before
  DEC-0048's switch either: no session is counted, no outcome is scored for this experiment and nothing is read.
- **Authority.** This is the registration DEC-0035 section 3 requires before the card plan is evaluated, and the only
  place a claim about the selection's accuracy may come from (DEC-0046's opening lines and section 8). The five-session
  gate of DEC-0046 section 7 is an operational release gate and is not evidence of accuracy.
- **Written before any affected P&L is viewed.** The affected P&L of this experiment is the forward window from the
  switch, and none of it exists yet: no session of the new selection has been picked, scored or read. The author ran
  no code of the ledger repository and computed nothing from any result. The ledger's source code and schemas were
  read at commit `8130c7c460ffa08cb2d54af49d1c05ab89c215b3` of `Algorythmos-AI/focus-card-ledger` to copy its outcome
  rule. **Disclosure, in full:** in that reading the author also opened three files that hold results of the previous
  picker, then stopped:
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
  the new selection exists. Nothing in it was used: the outcome rule below is copied from the source files only
  (`ledger/score.py`, `ledger/card.py`, `ledger/common.py`, `ledger/bars.py`), and every element of the design (the
  window, the unit, the outcome, the five hypotheses, what "supported" means, the pre-set action) was fixed in the
  owner-approved plan of 2026-11-11, before this drafting. The details the plan left open (the session and bar rules,
  the random draw, the Spearman summary, the seeds, the minimums, the Holm level) were chosen from first principles,
  without reference to any result.
- **Registers** EXP-0032 with HYP-0051 to HYP-0055: a new trial family F, total 5, counted apart from the global, C, O
  and M families (`config/trial_registry.yaml`, a `proposed` row until this record is accepted).
- **Amends DEC-0035 section 1 for EXP-0032 only**, as DEC-0045 did for EXP-0031: the verdict of this experiment reads
  the card plan's numbers, through the ledger's copy of the arithmetic (`ledger/card.py`), frozen here as DEC-0035
  section 3 requires, not taken from the display. The card plan's numbers do not change. **It changes no rule of
  DEC-0046** and amends nothing else.
- **Depends on:** DEC-0005, DEC-0032, DEC-0035, DEC-0042, DEC-0044, DEC-0045, DEC-0046, DEC-0049, DEC-0050.
- **Experiment:** EXP-0032. **Hypotheses:** HYP-0051, HYP-0052, HYP-0053, HYP-0054, HYP-0055.

## Why

DEC-0046 replaces the cloud picker with a replayable two-stage selection and says, in its opening lines, that passing
its gate proves only that the code runs. Whether the names it picks behave better than the names it leaves is a
separate question. It can only be answered on sessions nobody has seen yet, because the owner has seen the previous
picker's history and no holdout exists. So the window, the unit, the outcome, the tests and the response to each
result are fixed here first, and the results are read once.

## Decision

### 1. The window and the sessions counted

- **Start.** The first regular New York session `S` on which the edition's focus names are the Stage 1 picks, under
  the switch DEC-0048 makes (precondition 2 below). Forward only; never backfilled.
- **A session `S` is counted** when all of these hold:
  1. it is on or after the start, and the edition's focus names that day are the Stage 1 picks for `S` (a session on
     which the switch was reverted is not counted, and is counted as `not_switched`);
  2. a Stage 1 output for `S` exists (the session `D` it scored being the session before `S`), was published before
     09:30 New York on `S`, and carries the `params_sha` in force at the first counted session (DEC-0046 section 4;
     `08617613bced71e4c7b7b022ca1cc34070d885d5eae17c438f39e80284e88e23` unless a dated amendment changes it before
     the switch, and the value used is written in EXP-0032's README at the first counted session);
  3. the ledger holds a prediction, recorded before 09:30 New York on `S`, for every data-valid name of that output
     (precondition 1; otherwise counted as `no_prediction`);
  4. the session's SIP bars were fetched and saved as section 3 says. A session whose fetch never succeeded is not
     counted (counted as `no_bars`).

  A session that fails any of these is listed with its reason in the report and takes no part in any test.
- **Read once,** at the first of: the 120th counted session, or the end of the session of 2027-09-30. The read uses
  the counted sessions up to and including the 120th, or all counted sessions dated on or before 2027-09-30, and runs
  once after the last of their outcomes is recorded. Sessions after the 120th are not used.
- **Inconclusive by count.** With fewer than 60 counted sessions when the read is due, every hypothesis is
  inconclusive and no test result is worked out.
- **Early ends.** The window ends at the last session before any of these reaches production, and the read is then
  made at that point under the same rules (under 60 counted sessions, inconclusive): a dated amendment to DEC-0046 that
  changes the selection (`params_sha`, or a code change it records as a change to the selection); an amendment to
  DEC-0035 that changes a card number; a change to the frozen outcome rule (section 3). A breach of section 8 ends it
  as unreadable instead.

### 2. The unit

- **Every data-valid name on every counted session**: each of the twelve names that Stage 1 marks data-valid
  (DEC-0046 section 3, validity checks 1 to 5) and whose card fields are published for `S`. Each has card fields, so
  each can be scored by the same rule.
- **Counted, not scored**, each with its reason in the report: a name not data-valid (its validity reason); a name
  with `internal_error`; a data-valid name without card fields; a name with a split ex-date on `S` in Alpaca's
  corporate actions (`split_on_session`: its raw bars are not in the units of its levels); a name whose bars are not
  usable (`bars_incomplete`, section 3); a name with neither side's level (`no_level`).
- **Groups.** *Picked*: the Stage 1 picks for `S` (the first `min(4, eligible)` eligible names by final rank, DEC-0046
  R6). *The rest*: every other scored name, ineligible names (`earnings_gap`) and unranked data-valid names
  (`benchmark_missing`) included. Stage 2 never swaps a pick (DEC-0046 section 5), so the groups are Stage 1's.

### 3. The outcome: the ledger's rule, verbatim

The outcome of a name is the ledger's own rule at commit `8130c7c460ffa08cb2d54af49d1c05ab89c215b3`, applied by the
same functions (`card.derive_levels`, `score.score`, policy `card`) to every scored name with the same bars. At the
read every outcome is recomputed from the saved predictions and the saved bars with the code of that commit, and
compared with the stored outcome; a mismatch is listed and the recomputed value is used.

**The card plan's numbers** (`ledger/card.py` lines 3 to 5, 16, 24 to 32), frozen here for DEC-0035 section 3:

> entry = level +/- 0.01 ATR, stop = level -/+ 0.1 ATR, T1 = entry +/- 2R, T2 = the card's named target.

```
NO_ENTRY_WINDOWS_ET = [["09:30", "09:35"], ["11:30", "13:00"]]
    level = item["breakout_above"] if side == "call" else item["hold_above"]
    entry = _r2(level + sg * 0.01 * atr)
    stop = _r2(level - sg * 0.1 * atr)
    t1 = _r2(entry + sg * 2 * abs(entry - stop))
```

`_r2(x)` is `round(x + 0.0, 2)`; `sg` is +1 for the call side and −1 for the put side; `atr` is the card's `atr`. A
side whose level is null has no prediction (`card.py` line 54 to 55: "no level on that side ... the card shows no plan
for it").

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
  through the stop, the result is `failed_before_retest`; if the session ends first, `no_fill`. Both have R null: no
  entry was made.
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

**Which side is the name's outcome.** The ledger scores each side on its own. Here the name's side is **the side whose
trigger comes first** (the earlier `trigger_time`); its card-policy result and R are the name's. The other side is
ignored, whatever it does later. A name with no trigger on either side has no R and counts toward the trigger rate. A
name whose first-triggering side does not fill has no R, is counted as triggered without an entry, and is reported
with the entry rate. Both sides cannot trigger on the same bar unless the floor is above the ceiling; such a name is
counted as `card_fault` and not scored.

**The bars** (replacing the ledger's IBKR bars for this experiment, precondition 1): Alpaca SIP, the consolidated tape,
1-minute bars with `feed=sip` and `adjustment=raw` named on the request, regular hours 09:30 to 16:00 New York, fetched
for all scored names together, at least 30 minutes after the close (16:30, or 13:30 on a half day), paged to the end
and saved with their SHA-256. The first complete fetch is the one used and is never replaced; a failed fetch may be
retried until 23:59 New York on `S`. The saved 1-minute bars are joined into 2-minute bars, so that the rule runs on
the bar size it was written for (`bar_seconds` 120, `approximate` false): a 2-minute bar starts at 09:30 + 2k minutes
and takes the first open, the highest high, the lowest low, the last close and the summed volume of the 1-minute bars
whose start falls in it; a 2-minute slot with no 1-minute bar has no bar. Bars are usable when the first 2-minute bar
starts at 09:30, the last starts at 15:58 (12:58 on a half day), and at most 5 of the session's 2-minute slots (195, or
105 on a half day) have no bar; otherwise `bars_incomplete`. The session close is therefore the close of the 15:59 bar,
not the closing auction (`bars.py` keeps 09:30 to before 16:00, line 22).

### 4. What is recorded per name, and when

Per name and session, written by the ledger before 09:30 New York on `S` and never edited: the card fields and the two
side predictions; `picked`; the Stage 1 `score` and final rank; `eligible` and its reason; `params_sha`, `picker_ref`
and `bundle_sha`. The Pass B status is recorded once Pass B is published, as its own append-only record. After the
close: the bars and the two side outcomes, as the ledger's outcome schema holds them. Recorded is not shown: see
section 8.

### 5. Primary: HYP-0051, picked against the rest

- **Per session**: `D_s` = the mean R of the picked names that have an R, minus the mean R of the rest that have an R.
  A session where either group has no R is excluded from the statistic and counted.
- **Statistic**: the mean of `D_s` over the included sessions, each session weighted equally.
- **Range**: 5,000 bootstrap resamples of the included sessions, with replacement, the mean of `D_s` in each; the
  generator mulberry32 seeded **20261147**; the 2.5th and 97.5th percentiles by numpy's linear rule (EXP-0032
  `config.yaml` gives every step).
- **Halves**: the included sessions in date order, split at `floor(n / 2)`; the mean of `D_s` in each half.
- **Supported** only if the 2.5th percentile is above 0 **and** the mean of `D_s` is above 0 in both halves, with at
  least 30 included sessions. **Falsified**: the minimums met and the condition not met. **Inconclusive**: fewer than
  60 counted or 30 included sessions.
- **Beside it** (no test): each group's trigger rate (scored names with a trigger ÷ scored names) and entry rate
  (names with an R ÷ names with a trigger), and the counts of every exclusion.

### 6. Secondary: HYP-0052 to HYP-0055, Holm-adjusted across the four

Each gives a one-sided p, `p = (1 + the number of resampled statistics ≤ 0) / 5,001`, from its own 5,000 session
resamples (mulberry32 reseeded with 20261147 for each). The four p are Holm-adjusted together at a family level of
0.025 one-sided, the primary's level; a test that is inconclusive enters with p = 1. A secondary is **supported** only
if its adjusted p is at most 0.025 **and** its statistic is above 0 in both halves; **falsified** when its minimums are
met and that is not so; **inconclusive** below its minimums (at least 30 included sessions, and for HYP-0055 at least
30 names with an R in each group).

- **HYP-0052, picked against random fours.** Per session, `k` = the number of picks; 1,000 draws of `k` names without
  replacement from that session's Stage 1-eligible scored names, by a Fisher-Yates draw on the names in symbol order
  with mulberry32 seeded **20261152** once, sessions in date order. `D_s` = the picked names' mean R minus the mean,
  over the draws that hold at least one R, of each draw's mean R. Excluded and counted: a session whose picks have no
  R, or whose draws have none.
- **HYP-0053, picked against a fixed rule.** The fixed set: SPY and QQQ, each when it is scored and Stage
  1-eligible, plus the two single names (of the other ten) with the highest Stage 1 ATR% (ATR14 ÷ close, rounded to 6
  decimals) among those scored and Stage 1-eligible; ties by symbol A to Z. A name missing from the fixed set is not
  replaced. `D_s` = the picked names' mean R minus the fixed set's mean R; a name in both counts in both. Excluded and
  counted: a session where either has no R.
- **HYP-0054, Stage 1 rank against R.** Per session, the Spearman correlation `ρ_s` between the final rank and R over
  the ranked names with an R: average ranks for ties, then Pearson's correlation of the ranks. Rank 1 is first, so the
  session statistic is `−ρ_s`, positive when better-ranked names do better. Excluded and counted: a session with fewer
  than 3 such names, or with every R or every rank equal. Statistic: the mean of `−ρ_s`.
- **HYP-0055, Pass B `confirmed` against `no_longer_qualifies`.** Over all scored names of the included sessions,
  pooled: the mean R of names whose Pass B status was `confirmed` minus that of names whose status was
  `no_longer_qualifies`. Resamples draw sessions, each bringing all its names; a resample with an empty group is
  discarded and drawing continues until 5,000 are kept. Halves split the included sessions in date order; a half with
  an empty group fails. **`unclassified`**: a Pass B published before the amendment that freezes Stage 2's four
  thresholds (DEC-0046 section 5), a status outside DEC-0046's five, or a missing or late Pass B makes every name of
  that session `unclassified`; those sessions are excluded from HYP-0055 and counted. `caution` and `not_confirmed`
  names are in neither group and are counted.

### 7. Descriptive only, no test and no claim

Reported at the read, overall and by picked and the rest: SPY and QQQ against the ten single names (mean R, trigger
rate); the share of names with an R whose exit was `target1` rather than `stopped`; how often the bias label was right
(the ledger's `bias_correct` of the call side's record, or the put side's when the call side has no level, over the
names where it is not null).

### 8. Blind until the read

- The ledger records the picked flag, the score, the rank and the status. **No page, report, edition or script groups,
  filters or totals any outcome by picked, rank, score, eligibility or Pass B status** for any session from the start,
  before the read: no sum, mean, rate or count over more than one name-session so restricted. Per-name, per-session
  records may be shown; the owner knows the picks, so such views allow informal summing, and only the aggregate is
  sealed. The ledger's existing aggregates (its scorecard, weekly reports, and dashboard day totals over the card's
  names) take no session from the start.
- **The test that enforces it**, built with the ledger change and the gate script, before the first counted session:
  `tests/test_blind_until_read.py` in the ledger repository (no derived file, page or edition carries an aggregate of
  outcomes from the start keyed or filtered by those fields) and `tests/unit/test_select_gate.py` here (the gate
  script `scripts/select_gate.py` reads no outcome file).
- **A breach** (such a grouped result computed or shown, by anyone, before the read) ends the experiment as
  unreadable: no test result is worked out, the five trials stay counted, and the date and what was seen go in
  EXP-0032's README. A new question then needs a new registration and new trials.

### 9. The pre-set action

If HYP-0051 or HYP-0053 is falsified or inconclusive, Stage 1's scoring is replaced by the fixed rule of HYP-0053 (SPY,
QQQ and the two Stage 1-eligible single names with the highest ATR%, under Stage 1's validity, eligibility and
never-fill rules), by a dated decision record written after the read. Only if both are supported does the scoring
stay. It is stated now so that the outcome cannot shape the response. The secondary and descriptive results inform no
rule by themselves.

### 10. Preconditions for the first counted session

Nothing here is decided beyond these two, and no session counts until both are met:

1. **The ledger change**, merged by the owner in `Algorythmos-AI/focus-card-ledger`, designed in its own pull request:
   - predictions for **every data-valid name** of the Stage 1 output, both sides where a level exists, recorded before
     09:30 New York on `S` and append-only, from the card fields published for `S` (today it scores only the card's
     items, `card.py` line 51);
   - per name: `picked`, the Stage 1 `score` and final rank, `eligible` and its reason, `params_sha`, `picker_ref`,
     `bundle_sha`, and the Pass B status as its own append-only record;
   - **the same consolidated bars for all names**: Alpaca SIP 1-minute bars, `feed=sip`, `adjustment=raw`, fetched and
     joined into 2-minute bars as section 3 says, saved with their hash and never overwritten (today the bars are
     IBKR's 2-minute bars from `get_price_history`, `bars.py` lines 3 and 16, and a stored copy can be replaced by a
     "finer" one, line 41 to 43);
   - Alpaca's corporate actions read for each name and session, for `split_on_session`;
   - the scoring functions unchanged (`card.derive_levels`, `score.score`, scorer 1.1);
   - the blind rule of section 8 and its test.
2. **DEC-0048's switch**, which names the first session on which the edition's focus names are the Stage 1 picks, and
   the session that date is written into EXP-0032's README.

The published edition (or Stage 1's output) must also carry the card fields of every data-valid name, not only the
picks, for precondition 1 to be possible.

## Limits

- **R on the stock is not option P&L.** A name that does better in stock R may not do better in the owner's options
  (premium, spread, decay and the −25% option stop all differ). This experiment says nothing about option results.
- **Sessions are not independent of each other.** The same twelve names recur every session and a market-wide move
  touches all of them. Resampling whole sessions keeps the names of one session together, so it respects the
  correlation inside a session; it does not address dependence across sessions (trends and volatility regimes that
  last for weeks), so the range may be too narrow when such regimes dominate. The halves condition is a partial guard
  against one regime carrying the result.
- **120 sessions is a modest sample.** By construction a name's R runs from about −1 (or a little worse) to +2, so one
  name's R varies by about an R, a session's group mean rests on a few names, and many names have no R. Only a large
  difference, of the order of a third of an R per entry or more, would be likely to show as supported; a smaller true
  edge would most likely read as inconclusive or falsified. This is a statement about the design, worked out from
  nothing that has been observed.
- **The previous picker's history has been seen** by the owner, and summaries of it by those preparing this work
  (above). There is no holdout. That is exactly why the test is forward-only from the switch: the affected P&L is the
  forward window, none of which exists yet.
- **Multiple tests.** The four secondaries are Holm-adjusted; the descriptive items carry no claim. The primary alone
  answers the question this record asks.
- The rule fills at the entry price exactly and exits at T1 exactly; it ignores slippage, as the ledger does. Both
  groups are scored the same way, so the comparison is fair, but the levels of R are optimistic.

## What it does not do

- It changes no rule of DEC-0046, DEC-0035's card numbers or any other record's frozen value.
- It starts nothing until DEC-0048's switch, and reads nothing before its single read.
- DEC-0046 section 7 already says no gate night runs, and DEC-0048 is not proposed, before this record is accepted;
  and that nobody compares the outcomes of the old picks with the new ones before this record's single read.
- It adds no factor, weight or threshold, and no outcome is ever a reason to change one before the read.

## Consequences

- The Options page shows the measurement line ("Selection not yet measured: N of 120 sessions") until the read, N
  being the counted sessions of section 1.
- The ledger's change and the blind test must ship before the first counted session; until they do, sessions after
  the switch are not counted (they are listed as `no_prediction` or `no_bars`).
- If the read does not support HYP-0051 and HYP-0053, the selection's scoring is replaced by the fixed rule, as section
  9 says.
