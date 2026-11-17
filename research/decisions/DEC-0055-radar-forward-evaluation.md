# DEC-0055: Whether the pre-market Radar finds names that beat the market after it is published is measured once, forward

- **Status: PROPOSED on 2026-11-17.** The owner's merge of the pull request that changes this line to ACCEPTED, and
  the registry row to `accepted`, accepts it. Acceptance registers the experiment; it starts nothing before the
  preconditions of section 8 are met, and the registration lapses if they are not all met by 2027-02-28.
- **Why it exists.** The owner asked on 2026-11-17 whether the Radar really finds the best opportunities or only
  produces a shortlist, and chose that the Radar becomes the top of the selection funnel, measured first. The Radar's
  own scorecard cannot answer the question (section "Why"). This record is the registration AGENTS.md rule 2 asks for
  before any number of this evaluation is computed.
- **Registers** EXP-0038 with HYP-0065, HYP-0066 and HYP-0067: a new trial family R, total 3, counted apart from the
  global, C, O, M and F families (`config/trial_registry.yaml`, a `proposed` row until this record is accepted).
- **Depends on:** DEC-0046 and DEC-0047 (their blind rule, which this record must not breach); the dashboard's radar
  edition copies and their sealed daily listing (the receipt-time witness of section 1); the sealed evidence of
  `Algorythmos-AI/trading-options-funnel` (its `data` branch), which must be private before the first counted session
  (section 8).
- **Experiment:** EXP-0038. **Hypotheses:** HYP-0065, HYP-0066, HYP-0067.

## What has already been seen (not blind)

The author of this record saw results of the Radar before writing it. No figure is repeated here; what was seen:

- **The Radar routine's own scorecard notes** (`references/lessons.md` of the copied Radar skill, read on 2026-11-17):
  - DAILY RADAR against SPY, one session each, previous close to close, for most sessions from 24 September to
    9 November 2026, with the count of names that rose and the best name of the day;
  - SUPPORT PLAYS, the count of lines held; BREAKOUT WATCH, the count of lines cleared;
  - MEGA CAP OPTIONS against QQQ, with the lines held;
  - **SMALL CAP MOMENTUM against IWM** (the list and benchmark of HYP-0067);
  - INSTITUTIONAL CONVICTION's average and the count that rose;
  - one note that names removed from a list for breaking support rose the next day.
- **The dashboard's Radar page**, including its scorecard tiles of 13 November 2026.
- The author summarised some of these (a count of sessions ahead and behind for DAILY RADAR, and BREAKOUT WATCH's
  counts) in `docs/radar-method.md` of trading-options-funnel, which was public on GitHub on 17 November 2026.

All of them are the routine's own figures: one session each, from the previous close (before the report is written),
equally weighted, every name on the lists, desk names included. None is the measure registered here. **The choices made
after seeing them:** the entry at the open, the benchmarks (RSP; and IWM for small caps, chosen after the small caps'
results against IWM were seen), the windows, the minimums, the seeds and the read date. The owner made the two choices
listed under "What the plan left open". A reader should treat the design as written by someone who has seen results.

## Why

The Radar picks names editorially. Apart from three numeric gates (support within about 0-4%, resistance within about
0-2.5%, small caps priced $2-$20 with a catalyst), a cloud routine decides each morning which names go on which list,
from sources that change from day to day. It records no universe and no rejected names. Its scorecard:

- measures from the previous close, so a name picked because it is up before the open starts with a gain it never had
  to earn;
- covers one session, compares with SPY only, and is graded by the routine that picked;
- is kept as prose, with no history the dashboard can read.

Whether the Radar adds anything can only be answered forward: from the first edition the dashboard received before the
open, from the open, against a fixed fund.

## Decision

### 1. The sessions counted, and which edition is scored

- **The witness.** The dashboard keeps every radar edition it stores as a copy keyed by `edition_date`, with the
  store's own receipt time, and never replaces or deletes one (precondition 3). Every regular session the after-close
  routine's seal step, run by the routine and not by hand, seals that day's listing of the copies for `edition_date` S
  (store path, receipt time, sha256 of the stored bytes) as `data/radar-receipts/S.json` on the protected `data` branch.
- **Both must agree.** At the read the store is listed again. The store's copies for S, with their paths, receipt
  times and sha256, must be exactly the ones the sealed listing gives (`listing_mismatch` otherwise). A copy left out of
  the daily listing, or deleted from the store, takes the session out of the analysis; it cannot change which edition
  is scored.
- **The scored edition for session S** is the copy with the earliest receipt time in that sealed listing whose receipt
  time is after the close of the regular session before S (16:00 New York, 13:00 on a half day, by
  `dashboard/src/lib/market-calendar.json`) and before 09:30 New York on S. Copies outside that
  span are listed (`early`, `received_late`) and never scored; so are later copies inside it (re-sends, the pre-market
  refresh, corrections).
- **Its content** is read at the read from the dashboard's copy store; its sha256 must equal the sealed listing's. If the
  copy is gone or differs, the sealed radar folder whose `edition.json` has that sha256 is used; with neither, the
  session is `content_lost`.
- **Session S is counted** (decided every day, from the files sealed that day) when a sealed listing for S exists
  (`no_listing`), it has a scored edition (`no_edition`, `received_late` or `early`), and that day's sealed symbol
  directory exists and is readable (`no_directory`). The counted sessions alone set the last session that can count
  and the early end below.
- **Analysed** are the counted sessions that also pass the two checks made once, at the read: the store matches the
  listing (`listing_mismatch`) and the scored edition's content is available (`content_lost`). These checks only take
  sessions out of the analysis; they never move the read or end the experiment. The minimums of section 4 apply to the
  analysed sessions.
- **Start:** the first regular New York session after the date on which the last precondition of section 8 is written in
  EXP-0038's README. **Never backfilled.**
- **The last session that can count** is the 120th counted session, or 2027-06-30 if fewer are counted by then.
- **Read:** once, after the close of the fourth regular session after the last session that can count, so every
  five-session window it uses has closed. Fewer than 60 analysed sessions makes every trial inconclusive with no
  statistic worked out.
- **Ends early**, with no verdict and the three trials still counted, at the last session before any of these:
  - a change to the frozen analysis code, except a defect fix that comes with a synthetic test which fails before the
    fix and passes after it, both written in a dated note in EXP-0038's README before the read, and that changes no
    count already shown; a fix to a crash during the read is allowed on the same terms, written in the README, and the
    read is run again on the same sealed inputs;
  - 10 consecutive regular sessions that are not counted (by the daily rule above), whatever the reason.
- **The Radar is measured as it is run.** The routine edits its own notes every run and the owner may change its
  rules; neither ends the experiment. Each sealed radar folder records the sha256 of the Radar skill bundle it ran with
  (precondition 2), and the report lists every change of that hash, with dates.
- Every early end is written in EXP-0038's README with the artefact that triggered it.

### 2. The unit

- **The lists.** HYP-0065 and HYP-0066 use the first list in the scored edition whose name, with surrounding spaces
  trimmed, is `DAILY RADAR` (case as written); HYP-0067 the first that is `SMALL CAP MOMENTUM`. The report lists every
  day a list of that name is missing, beside the skill-hash changes.
- **Symbols** are upper-cased, stripped, `/` read as `.`, de-duplicated within the list, and must match
  `^[A-Z][A-Z0-9.]{0,9}$` (`unknown_symbol` otherwise).
- **The symbol directory.** Each session, before 09:30 New York, the radar seal step seals Nasdaq Trader's symbol
  directory files (`nasdaqlisted.txt` and `otherlisted.txt`) with the edition (precondition 2). Every decision below
  about a symbol on S is made from that day's sealed files, never from data fetched later. A symbol is found when it
  equals, after the normalisation above, the `Symbol` of `nasdaqlisted.txt` or the `ACT Symbol` or `CQS Symbol` of
  `otherlisted.txt`; rows with `Test Issue = Y` and each file's creation-time footer are ignored. A session whose
  directory is missing or unreadable is not counted (`no_directory`, section 1).
- **Taken out before any bar is fetched**, each with its reason:
  - **desk names** frozen on 2026-11-17: SPY, QQQ, AAPL, MSFT, NVDA, AMZN, GOOGL, META, TSLA, PLTR, AVGO, AMD
    (`desk_name`); a name in `config/options_desk.yaml` on `origin/main` at 09:30 New York on S that is not in that list
    (`desk_added`);
  - **desk share classes:** GOOG (`desk_proxy`);
  - **exchange-traded products:** a symbol the sealed directory marks `ETF = Y` (`exchange_traded_product`), RSP and
    IWM among them; leveraged and inverse single-stock funds on desk names fall here;
  - a symbol not in the sealed directory (`unknown_symbol`).
- **Counted, not scored:** no daily bar on S (`no_bars`); a spin-off with an ex date in the window (`corporate_action`).
- **Included** in a trial: an analysed session with at least one scored name on that trial's list and the benchmark's
  daily bar on S (`no_list`, `no_names` or `no_benchmark` otherwise).

### 3. The outcome

- **Bars:** Alpaca SIP daily bars (`timeframe=1Day`, `feed=sip`, `adjustment=all`), as served: their `o` and `c`, not
  claimed to be the auction prints. Fetched once, at least 30 minutes after the close of the last session the read uses,
  saved with their sha256, never replaced.
- **One session (HYP-0065, HYP-0067):** a name's return is `c(S) / o(S) - 1`. A half day uses its shorter session.
- **Five sessions (HYP-0066):** `c(S+4) / o(S) - 1`, S+4 the fourth regular session after S
  (`dashboard/src/lib/market-calendar.json`). A name with no bar after some session of the window (halted, delisted,
  merged, acquired) uses its last close in the window: it stays in, so the result keeps the names that went away.
- **Corporate actions:** Alpaca's corporate actions for the scored names and the window, fetched and sealed with the
  bars. Only a spin-off with its ex date in the window takes a name out; splits and dividends are already reflected by
  `adjustment=all`, and mergers, cash mergers and delistings keep the name at its last close.
- **Benchmark:** RSP (equal-weight S&P 500) for HYP-0065 and HYP-0066; IWM for HYP-0067; the same formula and window.
- **Per session:** `D_S = the mean of the scored names' returns - the benchmark's return`, each name weighted equally.

### 4. The hypotheses

| Trial | Hypothesis | List | Window | Benchmark | Role |
|---|---|---|---|---|---|
| RADAR-DAILY-1D | HYP-0065 | DAILY RADAR | open to close of S | RSP | primary: decides section 7 |
| RADAR-DAILY-5D | HYP-0066 | DAILY RADAR | open of S to close of S+4 | RSP | secondary |
| RADAR-SMALL-1D | HYP-0067 | SMALL CAP MOMENTUM | open to close of S | IWM | secondary |

- **Bootstrap:** 5,000 resamples; numpy linear percentiles; mulberry32 as EXP-0032 defines it, one seed per trial
  (HYP-0065 20261155, HYP-0066 20261156, HYP-0067 20261157).
  - HYP-0065 and HYP-0067: draw n included sessions with replacement, index floor(u x n); the statistic is the mean of
    their `D_S`.
  - HYP-0066 (overlapping windows): over the m counted sessions in date order, draw block starts floor(u x m) and take
    5 consecutive counted sessions from each, wrapping at the end; keep the included sessions among them in the order
    drawn until n are kept, the last block cut there; the statistic is the mean of those n `D_S`.
- **HYP-0065 supported:** at least 40 included sessions, the 2.5th percentile of the bootstrap means above 0, and the
  mean of `D_S` above 0 in both halves of the included sessions in date order (the first floor(n/2), then the rest).
- **HYP-0066 and HYP-0067 supported:** at least 40 included sessions each; one-sided p = (the number of bootstrap means
  at or below 0, plus 1) / 5,001; Holm over both trials at 2.5%, an inconclusive trial's p taken as 1; and the mean of
  `D_S` above 0 in both halves.
- **Fewer than 40 included sessions** for a trial makes that trial inconclusive.
- **Reported beside every verdict:** the point estimate and range, the counts of counted, included and excluded sessions
  and names by reason, the number of scored names per session, a name-weighted check (every scored name's excess return
  pooled), the share of `D_S` carried by the single largest name each session, and every change of the skill bundle's
  hash.
- **What it can detect** (a guess made with no data): if a session's `D_S` varies by about 1.2 percentage points, 60
  included sessions resolve a mean of about 0.3 points a session; a smaller true edge will most likely read
  inconclusive.

### 5. Blind until the read

- Before the read, **nobody computes EXP-0038's statistics** (`D_S`, its mean, its bootstrap, the name-weighted check)
  for any session of the window, and no page or script shows them. Counts of sessions, names and reasons may be shown.
- The Radar routine's own scorecard keeps being published as it is. It is not this measure, and seeing it is not a
  breach of this record; the report says so beside the verdict. This record makes no ruling on DEC-0047 section 8,
  which defines its own outcomes.
- A breach (these statistics computed or shown before the read) makes the experiment unreadable: no verdict, the trials
  stay counted, and the date and what was seen go in EXP-0038's README.

### 6. What is not claimed

- Nothing here measures the desk's focus names, the board, the clone or the owner's trades, or any option.
- A supported trial says that the scored names beat the fund from the open over that window, on the sessions counted.
  It does not say why, and nothing about names the Radar did not list.

### 7. The pre-set action

- **HYP-0065 supported:** a further decision record may propose the Radar as a source of candidate names beyond the
  desk's 12 (the funnel plan's Phase 3), with its own registration.
- **HYP-0065 not supported** (falsified, inconclusive, an early end, a lapse or unreadable): the Radar is used only for
  information and event-risk vetoes (Phase 2), never to pick or rank names for the desk, until a new registration says
  otherwise.
- The secondary trials inform; they change nothing by themselves.

### 8. Preconditions for the first counted session

Each is written in EXP-0038's README, dated, by the pull request or note that records it.

1. `Algorythmos-AI/trading-options-funnel` is private (the owner).
2. The radar seal step runs in the routine "Radar edition to dashboard" (its `docs/routine-steps.md`); each sealed radar
   folder records the sha256 of the Radar skill bundle in its provenance and holds that day's Nasdaq Trader symbol
   directory files; the first one verifies.
3. The dashboard keeps every radar edition it stores as its own copy, keyed by `edition_date`, with the store's receipt
   time and the run it replaced, never replaced or deleted; a signed read of the research key lists a date's copies
   (path, receipt time, sha256); and the after-close routine's seal step seals that listing every regular session as
   `data/radar-receipts/S.json`.
4. The `data` branch of trading-options-funnel refuses deletion and force pushes (a ruleset, the owner).
5. The analysis code (inputs, unit and window assembly, `D_S`, bootstrap, Holm, report) is merged in
   trading-options-funnel with synthetic-data tests and the generator vectors of EXP-0038's `config.yaml`; its commit is
   written in the README. A re-run after a crash uses the same sealed inputs.
6. This record is accepted.

If they are not all met by 2027-02-28, the registration lapses with no session counted: a new record is needed.

## What the plan left open, and who chose

- **Desk names excluded:** the owner (17 November 2026, asked directly).
- **Records written in this public repository:** the owner (17 November 2026, asked directly).
- **Everything else in sections 1 to 8:** the author, after the results listed above were seen.

## Limits

- The Radar's picks are not a fixed procedure: a routine chooses them each day and changes its own notes as it goes. The
  experiment measures what that routine did over the window, not a rule that will repeat.
- Leaving the desk names and the funds out removes the names the Radar lists most often; the result speaks for the rest
  of its names only.
- RSP and IWM are fixed benchmarks, not the names the Radar looked at and passed over: a supported result can still come
  from sector or size exposure rather than selection.
- The scored edition is the first the dashboard received between the previous close and the open. A run that missed
  its schedule and was started by hand counts if it arrived in that span; nobody can see the session's outcome before
  the open, so the choice to run it cannot follow the result.
- Whether a session is included depends on bars and lists, which are public; the rules for that are fixed here and
  decided from sealed files, so nobody can change them after the session.
- A person could stop the after-close seal step on a day, after its outcome is known: that session is then not counted
  (`no_listing`), though it cannot change which edition is scored on any day. The step runs in the routine, every
  missing day is listed in the report, and ten in a row end the experiment.
- The directory's ETF flag does not mark every fund-like product (exchange-traded notes, closed-end funds); those stay
  in when the directory lists them as ordinary issues.
- The sample is small for single-day stock returns; inconclusive is a likely outcome.

## Consequences

- The Radar keeps running as it does. The dashboard keeps showing its own scorecard, which remains not evidence.
- trading-options-funnel adds the skill bundle's hash and the symbol directory to the radar seal, seals the daily
  receipt listing and builds the analysis code; the dashboard keeps radar edition copies and lists them to the research
  key (preconditions 2, 3 and 5).
