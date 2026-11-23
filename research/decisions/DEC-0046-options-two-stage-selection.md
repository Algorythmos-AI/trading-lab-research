# DEC-0046: The Options desk picks its names in two stages, after the close and before the open

- **Status: ACCEPTED on 2026-11-12.** approved_by: owner. Proposed on 2026-11-12 (#400) and accepted by the owner's
  merge of the pull request that changed this line. Acceptance fixes the rules below; it starts no job. The Stage 1
  scoring code (`src/wt/options/select.py`) scores a saved input bundle and nothing else, and no job runs it yet. It
  has run on synthetic bars for everything, and on real bars only for the count recorded under "The count on saved
  bars". Stage 2's four thresholds are still to be set by a dated amendment, and no gate night runs before DEC-0047
  is accepted (section 7).
- **The five-session switch is an operational release gate.** It proves that the code runs correctly on real data.
  Passing it is not evidence that the selection is better than the one it replaces. Any claim of accuracy is made
  only by the registered forward experiment (to be DEC-0047), read once. Until that read the page shows facts, never
  a claim of skill.
- **Written before any affected P&L is viewed.** No P&L, no outcome of any pick and no backtest of this selection
  was viewed or run in writing it. On real bars only the validity checks and F3's zone distance were run, for a count
  of status frequencies (below); no pick, rank, score, eligibility, forward return or result was computed or read. The
  author read no result, ledger or journal file. What the author did read is listed below.
- **Starts no trial.** The forward experiment is DEC-0047. It is not written yet, because its outcome is the
  ledger's rule copied verbatim, and the owner has still to supply that rule. No hypothesis, experiment or row of
  `config/trial_registry.yaml` is added here.
- **Amends nothing.** It does not amend DEC-0035: the card's ceiling, floor, target and bias rules stay exactly as
  they are. It does not decide the board's data feed and does not start, end or change any experiment; the status
  of EXP-0031 and the board's feed are governed by DEC-0049 and the records that follow it.
- **Depends on:** DEC-0005, DEC-0032, DEC-0035, DEC-0038, DEC-0042, DEC-0044, DEC-0045, DEC-0049.

## Why

The after-close edition carries four focus names. Today they are picked by a cloud routine outside this repository,
whose inputs are not saved beside its output, so a night cannot be replayed. A name can look current when its data is
stale, the overnight gap is not checked before the open, and the page shows four names when fewer may be valid.

This record sets a selection that can be replayed from saved inputs, in two stages: a score of all twelve names
after the close (Stage 1), and a confirmation of each name before the open (Stage 2). Every rule, limit and weight is
written here, or in a file this record names by its hash, before the selection runs on real data. Nothing in it is
tuned on results.

## What has already been seen

- The approved plan for this programme (revision 5, 2026-11-12), which sets out the rules below.
- The records DEC-0032, DEC-0035, DEC-0042, DEC-0044, DEC-0045 and DEC-0049, and the repository's code for the levels
  engine (`src/wt/options/levels.py`), the edition (`src/wt/options/edition.py`), the event calendar readers
  (`src/wt/risk/events.py`) and the desk's names (`config/options_desk.yaml`).
- **The count on saved bars** (recorded below): how often each validity reason and `no_zone` would occur, per name,
  on 250 past nights. Status frequencies only.
- **No outcome.** No pick of this selection exists. No session was scored or ranked on real bars, and no result of any
  picker, card, clone trade or owner trade was read.

## Decision

### 1. The universe

The desk's twelve names, as `config/options_desk.yaml` `names` holds them on 2026-11-12: SPY, QQQ, AAPL, MSFT, NVDA,
AMZN, GOOGL, META, TSLA, PLTR, AVGO, AMD (AVGO and AMD since DEC-0038). The Stage 1 job takes the list from that file
and writes it into the input bundle; the scoring reads the bundle's list, so a replay of an old bundle scores the
names it was built for.

### 2. Data

- **Source.** Alpaca's consolidated tape (SIP), on the owner's Algo Trader Plus plan. Every request names its feed
  (`feed=sip`); a request without a feed is a defect (the test merged in #388).
- **Adjustment.** Stage 1's daily bars are split-adjusted (Alpaca `adjustment=split`), as the options clone, the
  host's options job and the pipeline check already read daily bars for levels. The input bundle records the
  adjustment its bars carry (`"adjustment": "split"`), and the scorer refuses a bundle that does not say `split`. Stage
  2's prior close (G1) stays the raw daily close.
  - The adjustment is **trusted** from that key, not verified. The `suspect_split` backstop catches only a one-day
    close ratio outside 0.5 to 2.0, so a missed 3:2 or 5:4 split (a ratio of about 0.67 or 0.8) would pass it.
  - `adjustment=split` does not adjust for dividends. An ex-dividend drop therefore enters the returns, the true range
    and the levels as a price move. The effect is small for these names but systematic: it falls on every ex-date.
- **Numbers.** A bundle holding a NaN or an infinite number anywhere is not in the documented shape and is refused (exit
  code 2). An integer too large for a float in one name's bar is that name's `bad_bar`; the other names are scored as
  usual.
- The selection's own data (Stage 1's daily bars, Stage 2's pre-market checks) is SIP, named on every request,
  independent of the board's feed.
- **Where it runs (owner decision, 2026-11-12).** Stage 1 and Stage 2 run as host jobs, not cloud routines. The numbers
  come from the repository's code; the input bundle is saved beside each output; the keys stay on the host. The jobs
  publish through the existing signed ingest. Their units are installed by the owner, so that release waits for him.
- **Replay.** Each run saves its input bundle. A replay reads only the bundle and never fetches again: late and
  corrected prints can change a bar after the fact.

### 3. Stage 1: after the close, all twelve names

The session `D` is the finished session (`edition.finished_session`); the next session is `D+1` from the session
calendar (`levels.next_session`), never from the clock. The code is `src/wt/options/select.py`, the command
`python -m wt.options.select stage1 --bundle <file> --out <file>`.

**Data validity.** The window is a name's last 260 daily bars. The checks run in this order and the first that fails
gives the reason:

1. `bad_bar`: a bar that cannot be read; dates not strictly increasing (a duplicate or an out-of-order date); a bar
   dated after `D`; in the window, a bar without high ≥ low > 0, a bar whose open or close lies outside its own
   high-low range (`not (low ≤ open ≤ high and low ≤ close ≤ high)`; exactly at the high or the low is inside), or a
   negative volume; or a rangeless window, whose ATR14, ATR5 or ATR20 is zero. These are data faults. The plan names no
   code for them; `bad_bar` is that code. The range rule is the coordinator's decision of 2026-11-12, the owner
   informed: the count found no such bar in 6,612 (below). It keeps F4 between 0.5 and 1.
2. `stale_bar`: no bar, or the last bar dated before `D`. A name with no bars in the bundle is `stale_bar`.
3. `short_history`: fewer than 260 bars. Exactly 260 is enough.
4. `missing_session`: the window's 260 dates are not the 260 exchange sessions ending at `D`, walking back from `D`
   with the session calendar (`levels.prev_session`). A missing session, or a bar dated on a day that is not a session
   (a Saturday in place of a Friday), fails here.
5. `suspect_split`: in the window, a close divided by the close of the bar before it is below 0.5 or above 2.0. A ratio
   of exactly 0.5 or exactly 2.0 is not suspect. With split-adjusted bars this should never fire: it is a backstop, and
   when it fires the adjustment was missed.

A factor or shown value that is not a finite number is also a data fault, given as `bad_bar`.

**ATR and returns.** ATR is `levels.atr(bars, n)`: the plain mean of the last `n` true ranges, the function the levels
and the card already use. `ATR% = ATR14 / close`. `ret(k)` = the close on `D` ÷ the close `k` bars before it, minus 1.

**The five factors.** Larger ranks first. No sign depends on a trend switch.

| Id | Covers | Definition |
|---|---|---|
| F1 | Trend and momentum | `abs(ret(20)) / (ATR% × √20)` |
| F2 | Range expansion | `ATR5 / ATR20` |
| F3 | Support and resistance | `−d / ATR14`; `d` is the distance from the close to the nearest edge of the nearest zone of weight ≥ 5, the zones being `levels.merge_zones` of the levels of `L = levels.levels_for(window, D+1)` without the prior close's own level: `merge_zones([x for x in L["levels"] if x.name != "PDC"], close)`; `d = 0` when the close is inside a zone (edges included). With no such zone F3 has no value: the name stays ranked, takes the last places on F3 and carries the caution `no_zone` (owner decision, 2026-11-12) |
| F4 | The day's high and low | `max(c, 1 − c)`, `c = (close − low) / (high − low)` of the bar of `D` (`levels.close_strength`); `c = 0.5` when high = low |
| F5 | Relative strength | `abs(ret(5) − benchmark ret(5)) / (ATR% × √5)`; the benchmark is SPY, or QQQ when the name is SPY |

- **Why `PDC` is left out of F3's zones.** In `levels_for(window, D+1)` the `PDC` level is the close of `D`: it sits
  exactly on the close being scored. The close's own level is not support or resistance for the close. Left in, it
  would put the close inside whatever zone it joins (distance 0), lift a zone of weight 4 over the floor, and change
  how its neighbours merge, which can also give a false `no_zone`. So the zones are merged again without it. Taking
  the edition's zones and only subtracting `PDC`'s weight is not the same rule and is not used: the bounds and the
  merging would still carry it.
- **A name with no zone is ranked last on F3, not removed** (owner decision, 2026-11-12). This softens the plan's rule
  that a factor is never defaulted: for F3 alone, a missing value is ranked last (the most conservative placement)
  rather than removing the name, because the count below showed the unranked rule would have kept some names out of
  contention on up to half of all nights for a reason that comes from how levels cluster. Every other factor still
  makes the name unranked when it cannot be worked out. In the output F3's value is null and the name carries the
  caution `no_zone`; with `n` ranked names of which `k` have no zone, each of the `k` takes the F3 rank
  `(n − k + 1 + n) / 2`, the average of the last `k` places. A null never enters a sum, a comparison or a rounding.
- **F3 and F4 partly count one fact, known and accepted.** Levels set by `D`'s own bar stay in F3's zones: the prior
  day's high and low are `D`'s high and low, and the week, month and 52-week extremes include `D`. When `D` closes at
  an extreme, such a level can put the close inside a zone (a small `d`), which is also when F4 is at its best. So the
  two factors partly count one fact. This is known and, as written, accepted (the coordinator's decision of
  2026-11-12, the owner informed). Leaving such levels out of F3 would be a different selection, not a correction: it
  would change the picks on most nights and raise `no_zone`.
- **What F3 depends on in `levels.py`** (the merge width, the level weights, the windows and the supply and demand
  rules) is frozen by reference at its values on 2026-11-12, listed in the appendix.
- **Shown, never scored:** ATR14, ATR%, the close, the close against its 20, 50 and 200-bar averages (above, below,
  at), the direction (the sign of `ret(20)`), and the 30-day historical volatility `hv30`: the sample standard
  deviation (n − 1) of the last 30 daily log returns, `ln(close / previous close)`, times √252. The IV percentile is not
  in Stage 1's output: the bundle holds no option data.

**Ranking.**

- R1. Every factor value is rounded to 6 decimals, then each factor ranks every name that has all five factors,
  event-ineligible names included, so an event never moves another name's rank. Rank 1 is first; ties share the
  average rank. On F3, names with no zone share the average of the last places, as above.
- R2. Score = the sum of the five ranks; lower is first.
- R3. Ties on the score go, in order, to: the smaller F3 distance (`d / ATR14`, rounded; a name with no zone sorts
  after every name with a distance, and among no-zone names this key is equal and the next decides); the larger median
  of close × volume over the last 20 bars (rounded); the symbol A to Z. Every name ranked gets a final rank, eligible
  or not.
- R4. **Events**, from the bundle's rows of `config/events/earnings.csv` and `config/events/macro_events.csv`. A row
  the repository's readers call malformed (`events.earnings_row_problem`, `events.macro_row_problem`) takes no part and
  is counted in the output; a malformed earnings row naming a desk name gives that name the caution
  `earnings_row_unreadable`.
  - A report released after the close of `D` and up to the close of `D+1` makes the name ineligible (`earnings_gap`):
    dated `D` after the close; dated on a day between `D` and `D+1` (a weekend or a holiday), at any time; or dated
    `D+1` before the open or during the session. A row of quality `expected` counts as a date, as a `confirmed` row
    does.
  - A report after the close of `D+1`, dated up to 6 calendar days after `D+1` (the edition's event window,
    `edition.EVENT_DAYS`), leaves the name eligible with the caution `earnings_later`.
  - A single name (not SPY or QQQ) with no row on or after `D` and no row in the last 75 days
    (`events.earnings_gaps`, `EARNINGS_MAX_AGE_DAYS`) has an unknown date inside the window where its next report is
    due: it stays eligible with the caution `earnings_date_unknown`.
  - A high-severity macro row dated `D+1` is a market-wide note, `macro_high_next_session`, with the event types. It
    makes no name ineligible. A half day on `D+1` is the note `next_session_half_day`.
- R5. **Missing data.** A name that is not data-valid, or has a factor other than F3 that cannot be worked out, is
  listed unranked with its reason: `bad_bar`, `stale_bar`, `short_history`, `missing_session`, `suspect_split`,
  `benchmark_missing` (F5, when the benchmark's bars are not data-valid), or `internal_error`. Such a factor is never
  given a default value; F3 with no zone is ranked last, as above. The benchmark's return is used whenever its bars
  are data-valid, whatever its own eligibility, its own factors or its own `no_zone`.
- **`internal_error`.** An unexpected exception while one name is scored is that name's `internal_error`, with the
  exception's class name only (never its text); the other names are scored as usual, and the run's status is
  `internal_error`, which fails the gate.
- R6. **Never fill.** The picks are the first `min(4, eligible)` eligible names by final rank. Fewer than four gives
  fewer cards and the counts of names, valid, ranked and eligible. None gives "No selection tonight: data incomplete"
  and an alert.

**Output.** Per name: validity, reason, each factor's value and rank, the score, the final rank, eligibility and its
reason, cautions, and the shown values; for the night: the picks, the counts, the market notes, the count of
unreadable event rows, `params_sha`, `picker_ref` and `bundle_sha`.

- `picker_ref` is `s1-` and the first 12 hex digits of SHA-256 over the Python tokens (comments and blank lines
  dropped) of `select.py`, `levels.py` and `events.py`: it names the code that scored, and holds no clock time or git
  state.
- `bundle_sha` is SHA-256 (hex) of the input bundle's canonical form: the parsed bundle written as JSON by the same
  rule as `params_sha` below. It names the input an output came from; the key order and spacing of the saved file do
  not change it, any value does.
- The same bundle and code give byte-identical output.
- **The calendar's range.** The session calendar covers 2024-01-01 to 2029-12-31 (`levels.HOLIDAYS`,
  `levels.CALENDAR_THROUGH`). A session whose 260-session window starts before 2024-01-01, or whose next session is
  past 2029-12-31, is refused with its own message: its sessions cannot be checked.
- The command's exit codes: 0, the output is written and no name has `internal_error`; 1, the output is written and a
  name has `internal_error`; 2, the bundle cannot be read or is not in the documented shape (a NaN or infinite number
  included); 3, the parameters file cannot be read, is not YAML, or holds what the code does not implement; 4, the
  output cannot be written; 5, the session lies outside the calendar's range; 6, a usage error (a missing or unknown
  argument or command). Each failure prints one line, never a traceback, and writes no output.

### 4. The frozen parameters

The numbers above live in `config/options_select.yaml`, and the code refuses a file that holds any value, code or rule
it does not implement. Its `params_sha` is `08617613bced71e4c7b7b022ca1cc34070d885d5eae17c438f39e80284e88e23`.

- The hash is SHA-256 (hex) of the parsed file written as JSON with keys sorted, separators `,` and `:`, ASCII only,
  YAML integers as JSON integers and YAML floats in Python's float repr, so 2.0 stays 2.0
  (`select.canonical_json`). Comments and layout do not enter it.
- The same value written in the other form (260.0 for 260, or 2 for 2.0) would change the hash without changing the
  selection, so the loader refuses it: a whole-number setting must be written as an integer and the two split bounds
  as decimals. `version: true` is refused too.
- A unit test fails when the file's hash differs from the one named here.

- The weights are equal (each factor's rank counts once) and fixed before the selection has run on real data.
  Nothing is tuned on results.
- Changing any value is a change to the selection: a dated amendment to this record first, giving the old and new
  value and saying that no outcome was viewed to choose it.

### 5. Stage 2: before the open, all twelve names, two passes

Not built by the pull request that carries this record. Its rules are fixed here.

- **Pass A** at 08:50 New York, published by 08:56; **Pass B** at 09:20, published by 09:25, recomputing everything and
  marking what changed since Pass A. Stage 1's levels never move between passes; only the pre-market high and low can
  widen, and that is shown. Each document's `as_of` is its assessment time, so a late Pass A never replaces Pass B.
  Each pass re-emits the Stage 1 block unchanged, checked by a hash over the items, the ranking and `params_sha`;
  Stage 1 refuses to re-run for a session that already has a confirmation. From 09:30 the card says the check was
  pre-market and the board is live; if Pass B has not arrived by 09:27 the card says so and shows Pass A's age.
- **Gap rules**, all on SIP with the feed named. Each pass fetches at `T` + 60 s, pages every answer to its end and saves
  the raw answers in its bundle.
  - G1. Prior close = the close of the last raw daily bar dated before the session, "before" from the session
    calendar. The snapshot's previous daily bar is a cross-check only. When Alpaca's corporate actions show an
    ex-date on the session for the name, the gap is worked out from the adjusted close (a split by its ratio) and the
    card is marked `close_adjusted`. A missed action shows as a large gap and falls to caution or fail, never to a pass.
  - G2. Reference price = the close of the last finished 1-minute SIP bar, valid only if that bar ended at most 120 s
    before `T`. Otherwise the bid/ask midpoint when both sides have a price and a size above zero and the spread is
    within the limit (the card says "mid"). Otherwise none. The raw last trade and its age are shown as evidence only.
  - G3. `gap_pct = ref / prior_close − 1`; `gap_atr = (ref − prior_close) / ATR14`.
  - G4. Pre-market volume = the sum of 5-minute bars with start ≥ 04:00 and end ≤ `T` (New York). A missing bar is zero
    volume; a bar still forming at `T` is dropped. `T` is the pass's scheduled time.
  - G5. Relative volume = that sum ÷ the median of the same window over the previous 20 sessions of the session
    calendar (half days included). Fewer than 10 complete sessions gives "not available", a neutral mark. One shared
    function with the market-intelligence plan's baseline.
  - G6. Pre-market high and low come from the same 5-minute bars, never from the daily bar. They join the level set.
    Position is one of: past upper target 1, above the ceiling, between, below the floor, past lower target 1.
- **Status, one per name, the first matching rule wins:**

  | Order | Status | Rule |
  |---|---|---|
  | 1 | `no_longer_qualifies` | The stream reports the name halted (when that state is available and fresh); earnings released since Stage 1 |
  | 2 | `not_confirmed` | The entitlement probe did not pass, or an answer did not come from a request naming `feed=sip`; no reference price (G2); data older than the limit; the request budget or a rate-limit answer cut the fetch short |
  | 3 | `no_longer_qualifies` | Spread above the limit; `abs(gap_atr)` at or above the fail limit |
  | 4 | `caution` | Opened beyond the ceiling or floor (past target 1 adds "that side: missed"); `abs(gap_atr)` at or above the caution limit; relative volume at or above the limit; earnings or a macro event today; `close_adjusted`; "possibly halted" |
  | 5 | `confirmed` | None of the above |

- **Halt.** Alpaca's REST answers carry no halt state. Each card carries `halt: halted | not halted | unknown` with its
  source and age. Without the stream it is "halt unknown", said on the card, never a silent pass. A name is marked
  "possibly halted" (a caution, rule 4, never a disqualifier) when it normally trades pre-market, shows no trade in the
  15 minutes before `T` and has a one-sided or empty quote.
- "Not available" values (relative volume, the news count) are neutral marks. News is a count of items since the last
  close; no headline text is stored or shown. When more than half the names are `not_confirmed` the pass is degraded
  and an alert is sent.
- **Thresholds.** Stage 2's four thresholds (the spread limit, the two gap limits and the relative-volume limit) are
  **not set by this record**. They are frozen by a dated amendment to it, before the gate starts, from how often each
  status would occur on at least 10 saved sessions of pre-market quotes: status frequencies only, never outcomes.
- **Open for Stage 2, not built here.** On a split ex-date, Stage 1's ATR14 and levels are in pre-split units while G1
  adjusts the prior close, so the gap in ATR units and the ceiling and floor would be wrong by the split ratio. Stage 2
  must either scale them by that ratio or give the name `not_confirmed`; the choice is made in the Stage 2 pull
  request's amendment to this record, before it is built. What "the adjusted close" means for a dividend is not yet
  defined either.
- **Reserves.** A reserve is a Stage 1-eligible name ranked 5th or lower whose Stage 2 status is `confirmed`. Up to two,
  in Stage 1 rank order, in their own panel and their own list, never among the picks. Nothing is swapped or promoted;
  zero reserves is valid ("No reserve qualifies"). A reserve that appears or disappears at Pass B is marked. Reserves
  show levels, live price and distance only, and are not on the board.

### 6. What does not change

- **The card.** Each data-valid name's ceiling, floor, targets, bias and the names of its levels come from a copy of
  the part of today's `focus.py` that works them out, proven identical by a parity test over at least 10 saved nights.
  Entry, stop and target 1 stay in `focus-plan.ts`. DEC-0035 is not amended.
- **The board and its experiments.** Nothing here changes the board's engine, its feed, EXP-0031 or EXP-0033. Those
  are governed by DEC-0042, DEC-0044, DEC-0045, DEC-0049, DEC-0050 and the records that follow them.
- **What the switch will touch, decided later.** The switch (DEC-0048) will change which names are focus names, and
  with them the `not_focus` label of the owner-trade experiments (DEC-0045 point 3, and EXP-0033's labels under
  DEC-0050) and the per-focus-name state log of the server evaluator (DEC-0044 point 1). This record decides none of
  that. DEC-0048 cannot be accepted unless it states, for each experiment running at the switch, one of: an early end,
  a separate stratum, or no effect and why.
- **The options clone follows the new names.** DEC-0032 takes the edition's focus names in rank order, up to six, keeps
  those it can trade that day (a contract expiring that day and readable levels), and tops up with SPY then QQQ until
  two can be traded. It adds no trial for a rule that changes only the set of names each day, and its verdict reads
  every trade together, whatever its name. So once the switch is made the clone trades the names this selection picks,
  under its own frozen rules, and HYP-0029 and HYP-0030, their trials and their `since`, are untouched.

### 7. The switch and the gate

The old picker keeps running beside the new one. The switch is one config value, reversible, made by DEC-0048 after
five consecutive gate passes.

- **Order.** No gate night runs, and DEC-0048 is not proposed, before DEC-0047 is accepted.
- **No early comparison.** Nobody compares the outcomes of the old picks with the new ones, formally or informally,
  before DEC-0047's single read. Gate criterion 8 records the two lists of names only.

The gate: `scripts/select_gate.py` prints pass or fail per criterion per night, reads no price
outcome, and any failure resets the count.

1. Stage 1, Pass A and Pass B each published on time and schema-valid.
2. All twelve names appear in each, fully worked out or with a reason code; `internal_error` fails.
3. Neither pass is degraded; the entitlement probe passed at both passes; at least 10 of 12 names have a SIP reference
   price inside its age limit in each.
4. Replaying the saved input bundle (daily bars, pre-market bars, snapshots, corporate actions, news counts, halt state,
   `T`) reproduces the output exactly, ignoring `as_of` and `run_id`.
5. Card fields equal the old picker's for every name both produce, and the Python and TypeScript readings of position
   against levels agree.
6. Each pass re-emitted the Stage 1 block unchanged.
7. No feed-watch alert for the selection's feeds.
8. The old picker's four names are logged beside the new four (record only).

Fault drills pass on staging first, each with a stated expected status and alert. The list is complete; a drill added
later is a dated amendment here:

1. a stale bar;
2. a missing name;
3. a missing benchmark;
4. a halt;
5. a delayed feed;
6. a wide spread with a fresh trade;
7. a late Pass A after Pass B;
8. Pass B never arriving;
9. a Stage 1 re-run after Pass A;
10. a 403 on SIP (the subscription lapsed);
11. a 401 (the key was revoked);
12. a burst of rate-limit (429) answers;
13. a split or ex-dividend on the session;
14. a snapshot whose daily bar is not the day expected.

### 8. Accuracy

Accuracy is a question for DEC-0047 alone: a forward-only experiment from the switch, read once. Until it is read, no
page or report groups any outcome by picked, rank or status, and the Options page shows the measurement line
("Selection not yet measured: N of 120 sessions") instead of any rate or percentage.

## The owner's decisions

- **2026-11-11.** A Stage 2 failure is flagged and reserves are shown, with no swap. The go-live is side by side for
  five sessions. The paper clone follows the new names. The card's ceiling, floor and target rules stay exactly as
  they are.
- **2026-11-12.** The data is Alpaca SIP on the Algo Trader Plus plan. Stage 1 and Stage 2 run as host jobs.
- **2026-11-12, from the count below.** A name with no qualifying zone is not unranked: it takes the last places on F3
  and carries the caution `no_zone`.
- **2026-11-12, the coordinator's, the owner informed.** A bar whose open or close lies outside its own high-low range
  is `bad_bar`. Levels set by `D`'s own bar stay in F3; the overlap with F4 is known and accepted.

## Not verified yet

- The scoring has not run on real bars. The first real night is a gate night, not a result.
- What the snapshot's daily bars hold before 09:30; which keys the host holds and that they carry the plan; how late
  Alpaca's corporate actions appear; how much a finished session's bars change by the next day; what a halted name's
  snapshot looks like.
- The ledger's exact outcome rule, which DEC-0047 needs.
- No reason code's frequency is a reason to change a rule after the gate starts: a change needs an amendment, written
  before it is viewed.

## The count on saved bars (2026-11-12)

These are status frequencies. No outcome was read. The owner's decision on `no_zone` and the two decisions on bars
above were taken from them.

- **What was run.** On 2026-11-12, the record's own validity and F3 functions, unmodified, at `params_sha`
  `b0c745ef…` (the version before the `no_zone` decision), on Alpaca SIP daily bars with `adjustment=split`: 551 bars
  per name from 2024-09-03 to 2026-11-11; 250 nights from 2025-11-13 to 2026-11-11; the twelve names; 3,000
  name-nights. One read-only request. No pick, rank, score, eligibility, forward return or result was computed or
  read.
- **Validity.** Every name was data-valid on all 250 nights: zero `bad_bar`, `stale_bar`, `short_history`,
  `missing_session`, `suspect_split`, `benchmark_missing` and `internal_error`. Every name's dates matched the exchange
  calendar exactly. No bar had its open or close outside its own high-low range (0 of 6,612).
- **`no_zone` nights of 250, per name:**

  | SPY | QQQ | AAPL | MSFT | NVDA | AMZN | GOOGL | META | TSLA | PLTR | AVGO | AMD |
  |---|---|---|---|---|---|---|---|---|---|---|---|
  | 1 | 30 | 13 | 40 | 27 | 74 | 33 | 116 | 88 | 125 | 73 | 84 |

  Total 704 of 3,000 (23.5%); first half 388 of 1,500, second half 316 of 1,500.
- **F3 distance in ATR14 units, where worked out** (2,296 name-nights):

  | Exactly 0 | 0 to 0.25 | 0.25 to 0.5 | 0.5 to 1 | Over 1 |
  |---|---|---|---|---|
  | 169 (7.4%) | 347 (15.1%) | 243 (10.6%) | 363 (15.8%) | 1,174 (51.1%) |

## Consequences

- Some nights will show fewer than four names, and some none. That is the rule, not a fault.
- The Stage 2 release waits for the threshold amendment, and the host jobs wait for the owner to install their units.
- A selection can pass the gate and still fail DEC-0047. What follows then is for DEC-0047 to fix before it is read;
  the gate cannot prevent it and does not try to.

## Appendix: what F3 depends on in `levels.py`

Frozen by reference at the values of 2026-11-12. A change to any of these moves F3 and needs an amendment to this
record first. The numbers below are pinned by a test that reads them from the code; the comparisons are not, except
the two boundaries the tests hold (a level exactly at the merge width merges; a later close exactly at a demand zone's
low does not break it), and `picker_ref` changes with any code change.

- Merging (`merge_zones`): a level joins the current zone when its low is within 0.5% (`pct = 0.005`) of that zone's
  lowest member; no chaining; a zone's weight is the sum of its members' weights.
- Level weights (`levels_for`): PDH, PDL, PDC 1; PWH, PWL 2; WTDH, WTDL 1; PMH, PML 3; 52WH, 52WL 3, over the last
  252 bars; MA20 1, MA50 2, MA200 3 (`WEIGHTS` holds day 1, week 2, month 3, 52w 3, ma 1, sd 2); at least 30 finished
  sessions.
- Supply and demand (`supply_demand`): a lookback of 120 bars, starting no earlier than bar 16; a strong day has a
  range above 1.5 times the ATR14 before it and a close in the top quarter (0.75) above its open (demand) or the
  bottom quarter (0.25) below its open (supply); its base is up to 3 bars just before it with a range under 0.7 times
  that ATR, else the one bar before; a zone is dropped once a later close goes through it; weight 2.

## Amendment 1 (PROPOSED 2026-11-12; it takes effect when the owner merges the pull request that carries it; nothing above is changed except where this amendment says so)

Written before Stage 2 was run on any real data, in the pull request that carries the Stage 2 code, as section 5
requires ("the choice is made in the Stage 2 pull request's amendment to this record, before it is built"). No
outcome, P&L, pick, ledger, journal or result was read in writing it, and no Stage 2 status was counted on real
data. It changes no Stage 1 rule and no value or hash of `config/options_select.yaml` (`params_sha` stays
`08617613bced71e4c7b7b022ca1cc34070d885d5eae17c438f39e80284e88e23`). It starts no job: no unit, timer or schedule
runs Stage 2. Stage 2's own numbers from section 5 live in `config/options_select_stage2.yaml`, whose hash each
output records as `stage2_params_sha`.

Each rule below settles a point section 5 leaves open or does not state. Each is the conservative reading: toward
`not_confirmed`, a caution, or a mark that cannot pass silently.

1. **Split ex-date on the session.** The name is `not_confirmed` (reason `split_ex_date`). Nothing is scaled; its gap
   in ATR units is not reported and its position reads "not available". Reason: Stage 1's ATR14 and levels are in
   pre-split units, and a scaled copy would be a new calculation no saved night has checked.
2. **Dividend ex-date on the session.** The raw prior close is used and the name carries the caution
   `close_adjusted`; no adjusted close is computed. Reason: section 5 leaves the dividend adjustment undefined, and a
   caution shows the day without inventing one.
3. **Any other corporate action effective on the session** (a name change, a merger, a spin-off, or any type other
   than a split or a cash dividend, by its ex-date, effective date or process date): `not_confirmed` (reason
   `corporate_action_not_handled`). Reason: no rule here says how such an action changes the prior close or the
   levels.
4. **The spread** is measured in basis points of the midpoint, `(ask - bid) / ((ask + bid) / 2) x 10,000`. A crossed
   quote (ask below bid) has no midpoint and no spread. A zero price or a zero size on a side makes the quote
   one-sided. Reason: section 5 names a spread limit without a unit; the plan's L3 note reads a zero side as
   one-sided, not crossed.
5. **"Normally trades pre-market"** means every desk name. Reason: all twelve are among the most traded names in the
   pre-market; the reading lets the "possibly halted" caution apply to any of them, and it never disqualifies.
6. **Entitlement** is established by the fetch's own evidence, in place of a separate probe. It passes only when every
   market-data request named `feed=sip`, every answer was 200, the requests that reach inside the last 15 minutes
   before `T` (the 1-minute bars and the snapshots) were answered, and every data answer carried `X-RateLimit-Limit`
   with the smallest at least 1,000; otherwise it fails. A missing header is a failure. The 1,000 comes from the
   approved plan's lapse rule ("`X-RateLimit-Limit` under 1,000 is treated as a lapse"). Reason: the probe section 5
   refers to is not built, and a lapsed plan shows in exactly these facts.
7. **Further rule 2 reasons**, each `not_confirmed`:
   - `bad_data`: one of the session's own bars, the quote, the snapshot or the corporate actions cannot be read;
   - `stale_prior_close`: no raw daily bar is dated the session before (by the calendar);
   - `stage1_atr_missing`: the Stage 1 block gives the name no ATR14;
   - `internal_error`: an unexpected error while the name was checked, given by its class name only;
   - `fetch_cut_short`, with its cause: the fetch did not finish (a 401, a 403, a rate-limit answer that could not be
     honoured, a server error, a timeout, the request budget, the time budget, or a fetch that began after the pass's
     publish-by time). A fetch that does not finish still saves what it fetched, marked incomplete, so the pass is
     scored, every name is `not_confirmed` and the pass is degraded.
   Reason: each is data the gap rules cannot be worked out from, and section 5's "data older than the limit" does not
   name them.
8. **Further cautions** (rule 4): `earnings_row_unreadable`, an earnings row naming the name that the repository's
   reader calls malformed; `halt_report_stale`, a "halted" report older than the freshness limit, which is a caution,
   never silently ignored. Reason: neither may pass as a clean confirmation.
9. **A macro row of any severity** dated on the session counts as "a macro event today". Reason: section 5 names no
   severity.
10. **A relative-volume baseline whose median is zero** reads "not available", a neutral mark. Reason: no ratio can be
    taken.
11. **Position without card fields.** While the card code (section 6) does not exist, the "opened beyond the ceiling or
    floor" check is not neutral: it is undetermined, and the name reads `unclassified` (reason `card_fields`) until
    the card code exists. Reason: a check that cannot be made must not read as passed.
12. **Two limits are not set by this amendment.** They join the four thresholds, to be frozen later by a dated
    amendment from status frequencies, never outcomes: the maximum age of a quote used for the midpoint, the spread
    test or the halt heuristic (`quote_max_age_s`), and the freshness limit of a halt report (`halt_max_age_s`, moot
    until a stream source exists). While one is absent, every check that needs it is undetermined. Reason: section 5
    uses both ("data older than the limit"; "when that state is available and fresh") without giving a number.
13. **Times after `T` are not "at `T`".** A quote or a halt report stamped after the assessment time is treated as
    stale. Reason: a pass's statuses must not depend on how late its fetch ran.

While a rule above, or a threshold, leaves a name's deciding check undetermined, that name's status is
`unclassified`, with the checks and limits that left it open, and every measured value is still reported, so the
frequencies the thresholds will be frozen from can be counted. Reserves are not classified while the thresholds are
not set.

## Note on DEC-0070 (added 2026-11-23)

DEC-0070, accepted on 2026-11-23, amends section 1 and section 3's timing:
- **The universe for S** is the desk's 12 followed by at most 8 Radar names that pass its gate. While the gate's
  thresholds are unset, it is the 12.
- **Stage 1 for S runs at 06:45 New York on S**, after the Radar's build, on the bundle for D.

Every Stage 1 rule, weight, tie-break and frozen value, `config/options_select.yaml` and its params_sha are unchanged.
