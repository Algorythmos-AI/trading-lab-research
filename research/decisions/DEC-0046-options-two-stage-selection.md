# DEC-0046: The Options desk picks its names in two stages, after the close and before the open

- **Status: PROPOSED on 2026-11-12.** Drafted for the owner to change or accept. It becomes ACCEPTED only when the
  owner merges a pull request that says so in this line. The pull request that carries this draft also carries the
  Stage 1 scoring code (`src/wt/options/select.py`), which scores a saved input bundle and nothing else: no job runs
  it and nothing reads its output before this record is accepted.
- **The five-session switch is an operational release gate.** It proves that the code runs correctly on real data.
  Passing it is not evidence that the selection is better than the one it replaces. Any claim of accuracy is made
  only by the registered forward experiment (to be DEC-0047), read once. Until that read the page shows facts, never
  a claim of skill.
- **Written before any affected P&L is viewed.** No P&L, no outcome of any pick and no backtest of this selection
  was viewed or run in writing it. The scoring code has run only on synthetic bars in the unit tests. The author read
  no result, ledger or journal file. What the author did read is listed below.
- **Starts no trial.** The forward experiment is DEC-0047. It is not written yet, because its outcome is the
  ledger's rule copied verbatim, and the owner has still to supply that rule. No hypothesis, experiment or row of
  `config/trial_registry.yaml` is added here.
- **Amends nothing.** It does not amend DEC-0035: the card's ceiling, floor, target and bias rules stay exactly as
  they are. It does not decide the board's data feed and does not start, end or change any experiment; the status
  of EXP-0031 and the board's feed are governed by DEC-0049 and the records that follow it.
- **Depends on:** DEC-0005, DEC-0032, DEC-0035, DEC-0038, DEC-0042, DEC-0044, DEC-0049.

## Why

The after-close edition carries four focus names. Today they are picked by a cloud routine outside this repository,
whose inputs are not saved beside its output, so a night cannot be replayed. A name can look current when its data is
stale, the overnight gap is not checked before the open, and the page shows four names when fewer may be valid.

This record fixes a selection that can be replayed from saved inputs, in two stages: a score of all twelve names
after the close (Stage 1), and a confirmation of each name before the open (Stage 2). Every rule, limit and weight is
written here, or in a file this record names by its hash, before the selection runs on real data. Nothing in it is
tuned on results.

## What has already been seen

- The approved plan for this programme (revision 5, 2026-11-12), which sets out the rules below.
- The records DEC-0032, DEC-0035, DEC-0042, DEC-0044, DEC-0045 and DEC-0049, and the repository's code for the levels
  engine (`src/wt/options/levels.py`), the edition (`src/wt/options/edition.py`), the event calendar readers
  (`src/wt/risk/events.py`) and the desk's names (`config/options_desk.yaml`).
- **No outcome.** No pick of this selection exists. No session was scored on real bars, and no result of any picker,
  card, clone trade or owner trade was read.

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
   dated after `D`; in the window, a bar without high ≥ low > 0, an open or close not above 0, or a negative volume; or
   a rangeless window, whose ATR14, ATR5 or ATR20 is zero. These are data faults. The plan names no code for them;
   `bad_bar` is that code.
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
| F3 | Support and resistance | `−d / ATR14`; `d` is the distance from the close to the nearest edge of the nearest zone of weight ≥ 5, the zones being `levels.merge_zones` of the levels of `L = levels.levels_for(window, D+1)` without the prior close's own level: `merge_zones([x for x in L["levels"] if x.name != "PDC"], close)`; `d = 0` when the close is inside a zone (edges included); no such zone gives `no_zone` |
| F4 | The day's high and low | `max(c, 1 − c)`, `c = (close − low) / (high − low)` of the bar of `D` (`levels.close_strength`); `c = 0.5` when high = low |
| F5 | Relative strength | `abs(ret(5) − benchmark ret(5)) / (ATR% × √5)`; the benchmark is SPY, or QQQ when the name is SPY |

- **Why `PDC` is left out of F3's zones.** In `levels_for(window, D+1)` the `PDC` level is the close of `D`: it sits
  exactly on the close being scored. The close's own level is not support or resistance for the close. Left in, it
  would put the close inside whatever zone it joins (distance 0), lift a zone of weight 4 over the floor, and change
  how its neighbours merge, which can also give a false `no_zone`. So the zones are merged again without it. Taking
  the edition's zones and only subtracting `PDC`'s weight is not the same rule and is not used: the bounds and the
  merging would still carry it.
- **What F3 depends on in `levels.py`, frozen by reference** at its values on 2026-11-12. A change to any of these
  moves F3 and needs an amendment to this record first; a unit test reads them from the code and fails until then.
  - Merging (`merge_zones`): a level joins the current zone when its low is within 0.5% (`pct = 0.005`) of that zone's
    lowest member; no chaining; a zone's weight is the sum of its members' weights.
  - Level weights (`levels_for`): PDH, PDL, PDC 1; PWH, PWL 2; WTDH, WTDL 1; PMH, PML 3; 52WH, 52WL 3, over the last
    252 bars; MA20 1, MA50 2, MA200 3 (`WEIGHTS` holds day 1, week 2, month 3, 52w 3, ma 1, sd 2); at least 30 finished
    sessions.
  - Supply and demand (`supply_demand`): a lookback of 120 bars, starting no earlier than bar 16; a strong day has a
    range above 1.5 times the ATR14 before it and a close in the top quarter (0.75) above its open (demand) or the
    bottom quarter (0.25) below its open (supply); its base is up to 3 bars just before it with a range under 0.7 times
    that ATR, else the one bar before; a zone is dropped once a later close goes through it; weight 2.
- **Shown, never scored:** ATR14, ATR%, the close, the close against its 20, 50 and 200-bar averages (above, below,
  at), the direction (the sign of `ret(20)`), and the 30-day historical volatility `hv30`: the sample standard
  deviation (n − 1) of the last 30 daily log returns, `ln(close / previous close)`, times √252. The IV percentile is not
  in Stage 1's output: the bundle holds no option data.

**Ranking.**

- R1. Every factor value is rounded to 6 decimals, then each factor ranks every name that has all five factors,
  event-ineligible names included, so an event never moves another name's rank. Rank 1 is first; ties share the
  average rank.
- R2. Score = the sum of the five ranks; lower is first.
- R3. Ties on the score go, in order, to: the smaller F3 distance (`d / ATR14`, rounded); the larger median of close ×
  volume over the last 20 bars (rounded); the symbol A to Z. Every name ranked gets a final rank, eligible or not.
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
- R5. **Missing data.** A name that is not data-valid, or has a factor that cannot be worked out, is listed unranked
  with its reason: `bad_bar`, `stale_bar`, `short_history`, `missing_session`, `suspect_split`, `no_zone` (F3),
  `benchmark_missing` (F5, when the benchmark's bars are not data-valid), or `internal_error`. When F3 and F5 both fail, `no_zone` is given. A
  factor is never given a default value. The benchmark's return is used whenever its bars are data-valid, whatever its
  own eligibility or its own factors.
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
- The command's exit codes: 0, the output is written and no name has `internal_error`; 1, the output is written and a
  name has `internal_error`; 2, the bundle cannot be read or is not in the documented shape; 3, the parameters file
  cannot be read, is not YAML, or holds what the code does not implement; 4, the output cannot be written. Each
  failure prints one line, never a traceback, and writes no output.

### 4. The frozen parameters

The numbers above live in `config/options_select.yaml`, and the code refuses a file that holds any value, code or rule
it does not implement. Its `params_sha` is `b0c745efd62f1e3a69b54e55a96cb189647e9843ed3d932efe56f9979b1d7c00`.

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
- **Reserves.** A reserve is a Stage 1-eligible name ranked 5th or lower whose Stage 2 status is `confirmed`. Up to two,
  in Stage 1 rank order, in their own panel and their own list, never among the picks. Nothing is swapped or promoted;
  zero reserves is valid ("No reserve qualifies"). A reserve that appears or disappears at Pass B is marked. Reserves
  show levels, live price and distance only, and are not on the board.

### 6. What does not change

- **The card.** Each data-valid name's ceiling, floor, targets, bias and the names of its levels come from a copy of
  the part of today's `focus.py` that works them out, proven identical by a parity test over at least 10 saved nights.
  Entry, stop and target 1 stay in `focus-plan.ts`. DEC-0035 is not amended.
- **The board and its experiment.** Nothing here changes the board's engine, its feed or EXP-0031. Those are governed
  by DEC-0042, DEC-0044, DEC-0045, DEC-0049 and the records that follow them.
- **What the switch will touch, decided later.** The switch (DEC-0048) will change which names are focus names, and
  with them the `not_focus` label of the owner-trade experiment (DEC-0045 point 3) and the per-focus-name state log of
  the server evaluator (DEC-0044 point 1). This record decides none of that. Before it is accepted, DEC-0048 must say
  what the switch does to each experiment then running: an early end, a separate stratum, or no effect and why.
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

## Not verified yet

- The scoring has not run on real bars. The first real night is a gate night, not a result.
- What the snapshot's daily bars hold before 09:30; which keys the host holds and that they carry the plan; how late
  Alpaca's corporate actions appear; how much a finished session's bars change by the next day; what a halted name's
  snapshot looks like.
- The ledger's exact outcome rule, which DEC-0047 needs.
- **How often `no_zone` occurs.** A name with no qualifying zone is unranked. Synthetic walks in the review suggest
  this happens more for volatile names. Before this record is accepted, the owner may ask for a count of how often
  each reason code, `no_zone` among them, would occur per name on saved daily bars. That is a status frequency and
  reads no outcome. If the owner then changes the rule, this record is amended before it is accepted. He has two
  readings to choose from: unranked, as written; or ranked last on F3 (the name keeps its other four ranks). Only the
  first is built.
- No reason code's frequency is a reason to change a rule after the gate starts: a change needs an amendment, written
  before it is viewed.

## Consequences

- Some nights will show fewer than four names, and some none. That is the rule, not a fault.
- The Stage 2 release waits for the threshold amendment, and the host jobs wait for the owner to install their units.
- A selection can pass the gate and still fail DEC-0047. What follows then is for DEC-0047 to fix before it is read;
  the gate cannot prevent it and does not try to.
