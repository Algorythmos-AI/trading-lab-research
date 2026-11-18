# Options clone (DEC-0030)

The options clone is a paper bot. It buys one call or put at a time by the nine rules on the Trades page: a same-day contract, or the name's nearest listed expiry when none expires that day (DEC-0034). It always sells the same day. It runs as the job `paper-o` on the host:

| When (New York) | What it does |
|---|---|
| 09:00 | It starts |
| 09:25 | It arms |
| 10:00 to 14:30 | It may enter |
| 15:10 | It sells anything it holds |
| 15:20 | It checks that it is flat |
| After the close | It ends |

Its numbers are frozen in `config/options_clone.yaml` and `config/risk.yaml` key `O`.

## Where things are on the host

| What | Where |
|---|---|
| The record (hash-chained) | `data/live/options_journal.jsonl` |
| One decision per name per finished 2-minute bar; each signal's `reason` (the first gate that refused it, or the guard's or broker's code), `failed`, `why` (the numbers against it), `contract` (expiry, whether its greeks were modelled) and, when no contract passed, `contract_miss` (the refused contract nearest the stock: its reason and the number against that floor, whichever gate refused first) | `var/options/decisions/<date>.jsonl` |
| One plan file per trade | `var/options/plans/plan_<date>-O-<n>.json` |
| Loss latches | `var/options/latches/{day,week,drawdown}` |
| Log | `logs/paper_o_<YYYYMMDD>.log`; `journalctl -u wt-paper-o` shows only start and exit |
| Account | The clone's own paper account when `APCA_CLONE_KEY_ID` / `APCA_CLONE_SECRET_KEY` are set (`sudo wt-set-secrets`), otherwise the second paper account beside your hand trades |

## The dashboard

| Direction | What | How |
|---|---|---|
| In, at arm | The latest options edition's focus names (symbol, rank, bias) and its session | A signed `GET /api/focus` with the host's `DASHBOARD_KEY_ID` / `DASHBOARD_INGEST_SECRET`. On any failure, or a focus for another session, the clone trades SPY and QQQ; the Trades page then says "Fallback" under Names. From 2026-11-18 QQQ is also traded every session after the focus names, outside `max_names` (`names.standing`, DEC-0058); the `names` line lists it under `standing` |
| Out, after every trade event and at the close | `stocksdelta/options-clone` v1: names, entries, day result against the limit, latch, trades, feed medians, broker stop, decisions by gate, each hypothesis's figures | `wt.ops.publish.send` from a thread of its own, newest first. Drawn as "The clone" on the Trades page. A document that cannot be built or sent is journaled (`clone_doc_unsent`), never retried into a trade; `clone_doc` at the close counts what was sent |
| Out, every few minutes | `stocksdelta/paper-options` v1: every closed trade, with the arms' simulated trades and the hand-placed paper trades | `wt.options.paper_site`, from the `options-live` job, never from the runner. Drawn on the Paper page. See `paper-options.md` |

## Controls (owner)

| To | Run in `/home/wt/trading` as `wt` |
|---|---|
| Stop new entries (exits keep being managed) | `make kill DESK=options REASON="..."` (the stocks `KILL` file stops it too) |
| Allow entries again | `make unkill DESK=options` |
| Clear a loss latch, after reading the day's trades | `make reset-options-latch KIND=day\|week\|drawdown REASON="..."` (refused while a session runs) |
| Use the exact option feed after subscribing to Algo Trader Plus | `touch var/options/switches/opra` |
| Stop sending orders at all (it still arms and journals) | `orders: off` in `config/options_clone.yaml`, through a pull request and a decision record |

The option feed setting, `feeds.option` in `config/options_clone.yaml`, must be exactly `indicative` or `opra`, lower
case: anything else is refused before it is sent and the clone runs with no chains.

## Pages and what to do

| Page | Meaning | What to do |
|---|---|---|
| Options clone entered / exited | A trade: the side (call or put) and, on exit, the result on premium in %. The name, the setup and the fill are in the clone journal's `filled` record, the level in the plan file, the exit reason in the `trade_closed` record; never on the phone (the topic is public) | Nothing |
| Options clone latched | The day ($100), week ($300) or drawdown ($500) latch is on; no new entries | The day latch clears itself next session. Week and drawdown latches wait for you: read the trades, then reset |
| Feed unfit, entries off | The option quotes were too old (median over 5 s in ten minutes) or entry fills too far from them (median over 3%) | Nothing today. If it repeats, consider Algo Trader Plus (exact OPRA quotes) and the `opra` switch |
| An exit has not filled | Three tries, or 60 s past the trigger | Watch the next page. The clone keeps trying |
| NOT FLAT | Something is still open at 15:20 | The clone keeps selling. Be ready to sell it by hand |
| **FLATTEN REQUIRED** | Something is still open at 15:25, the broker has been unreachable for five minutes with a position open, or a position no plan knows was found at arm | Sell it by hand in the Alpaca paper dashboard **before 15:30**: from 15:30 the broker processes expiring positions itself, and an in-the-money long option is exercised into stock. Entries stay off for the day |
| A lot was sold by hand | In a shared account, the account holds less of a contract than the clone bought | Nothing. The trade is booked `unresolved` and left out of the verdict. Prefer a dedicated account |
| Account cannot buy options | The options level is under 2 | Ask Alpaca to raise it on the paper account |

## What a stop guarantees

- **On paper:** $50 a trade and $100 a day are planned limits.
- **In the market:** a stop is a market sell after the trigger, so its fill can be worse. The journal records each exit's fill against the bid that triggered it.
- **Broker-side stop:** if the account accepts a stop order for options, a broker-side stop at -25% rests as well. The journal says `broker-stop: accepted` or `refused`.
- **Worst case:** if every exit fails, the loss is the premium paid, at most $200 a trade.

## The pipeline check (radar, options edition, focus names)

The host job `pipeline-check` runs at 08:55 New York (after the 08:50 focus refresh, before the clone arms) and at
18:30 (after the evening edition). It reads the stored radar and options editions back from the site (signed
`GET /api/editions/<kind>`, host keys only) and checks their claims against the consolidated tape and the option
listings:

| Check | Fails when |
|---|---|
| `data.reachable` | the daily bars or the option listings gave no usable answer: for the bars, no connection, a timeout, a dropped body or a 5xx/429 still failing after one retry (3 seconds later, or a 429's Retry-After up to 10 seconds), any other HTTP error or an unreadable body (not retried); for the listings, two names in a row failing that way, or no name answering at all. The checks that need them then warn "not verified". One name's own listing error, a lasting one included, is not this: it warns `options.listing.<SYM>` ("not verified") and the other names are checked as usual. Bar pages are followed to the end (at most 30) |
| `options.session`, `options.built_from` | the edition is not for the coming session, or not built from the last close |
| `options.close.<SYM>` | the edition's close is more than $0.02 from the tape's and more than 0.25 of its ATR14 (between the two: a warning, two vendors' prints) |
| `options.levels.<SYM>` | PDH, PDL, PWH, PWL, PMH, PML, MA20 or MA50 is more than $0.05 from the same level recomputed and more than 0.25 of its ATR14, or missing (between the two: a warning) |
| `radar.date`, `radar.fresh` (before the open) | the radar is not for today, or is more than 6 hours old |
| `radar.close.<SYM>` (before the open) | the radar's price is more than $0.02 from the last close |
| `calendar.macro.<type>` (both runs) | the last row of a recurring type in `config/events/macro_events.csv` (cpi, nfp, fomc_decision, fomc_minutes, quad_witching) is fewer than 35 days after the session, or the type has no row; it warns from 45 days. 35 leaves a week before the paper runner refuses to arm (it needs a row 30 days ahead). `fomc_emergency` is never required |
| `calendar.earnings.<SYM>` (both runs) | the latest row in `config/events/earnings.csv` of a desk single name (`config/options_desk.yaml` less SPY and QQQ) is more than 85 days old, or the name has no row; it warns past 75 days. Reports come about 91 days apart and are announced two to five weeks ahead, so 85 pages before the next report and after most companies have announced |
| `calendar.macro`, `calendar.earnings` | a calendar file is missing or unreadable or lacks a column, or the desk's names cannot be read. Pages at priority 4 (with the earnings file missing the clone makes no earnings skips at all); the run still exits 0 |
| `calendar.macro.rows`, `calendar.earnings.rows` | a row is malformed (the report names the line and what is wrong) and is not counted. A row is well-formed only in the exact form the clone matches as a string: the date exactly `YYYY-MM-DD` (no space, not `20270225`), the symbol exactly upper case, the type a bare lower-case code, the time exactly `HH:MM`. A date more than 120 days after the session (earnings) or three years (macro) is taken for a typo |
| `calendar.sessions` (both runs) | the exchange calendar in `wt.options.levels` (`CALENDAR_THROUGH`) ends fewer than 45 days after the session; it warns from 90 days |

Warnings, never a page: `focus.tradeable` (no focus name has a contract the clone may trade that session; one is
enough, the clone tops up with SPY and QQQ, DEC-0032), `focus.premarket` (the pre-open refresh is not for today, or
is in a shape this check does not read; always a warning, because the refresh passes are due after this 08:55 run and
the dashboard's own watcher pages on them), `focus.earnings.<SYM>` (a focus name reports, so the clone skips it),
`radar.premarket.<SYM>` (price moved more than 0.5% since the radar), `data.snapshot` (the pre-market prices were
unreachable, so that move is not checked).

Each run writes `var/pipeline-check/<session>-<slot>.json`. Any failed check pages once a day per run with counts per
check family only (for example `options.close: 2 failed`), the slot and the session date: never a symbol, price or
level, since ntfy is a public topic. The calendar checks are the exception to "per run": they read only the
checkout's files (no network, no share of the time budget, still judged when market data is unreachable), and their
page is sent before any network call, on a key of its own: `pipeline-check:calendar:` plus the failing families
(`macro`, `earnings`, `sessions`, with `-file` for a file-level failure; never a type or a symbol). An unchanged
condition pages at most once a New York day, from whichever run sees it first; a family that starts failing later
that day pages again. Priority 4 for a file-level failure, 3 for a calendar running short. The run's own page leaves
the calendar families out. The report has the ids and the detail. A failed check exits 0; a crash of the
job exits non-zero, and the job runner pings `wt-pipeline-check/fail` and alerts "pipeline-check failed". No call or
wait starts unless it ends within 540 seconds of the start, inside the job's 10-minute deadline. When the budget runs
out, what was fetched is kept: the names whose listing was not reached warn `options.listing.<SYM>` (budget), an
after-close wait round that would not fit is skipped and the tape checks say so, and the report's
`cut_short_by_budget` names what was cut.

When a calendar check pages (`calendar.macro` or `calendar.earnings` in the message), the report's `calendar.*`
details name the type or ticker and its last date. Add the next dates from the source each file's rule names: CPI and
the jobs report from the BLS release schedule (bls.gov/schedule), FOMC decisions from the Fed's calendar
(federalreserve.gov/monetarypolicy/fomccalendars.htm, minutes three weeks after), quad witching by the third-Friday
rule (the session before when that Friday is a market holiday), and an earnings date only from the company's own
announcement or a source named in the row's `source` (the header of `earnings.csv`; a wrong date is worse than a
missing one, so never guess). Regenerate the dashboard's calendar (`make schema`, which rewrites
`dashboard/src/lib/market-calendar.json`) in the same pull request.

The weekly economic calendar (`wt.ops.econ_calendar`) reads FOMC decisions from the Fed's page. When the Fed lists an
unscheduled, cancelled or conference-call meeting, the Fed source reports not ok and keeps the last good dates until
the reader (`parse_fed`) is taught the new row; that is by design. The job's log names the year and the row's shape.

Owner note, the end of the exchange calendar: `wt.options.levels.is_session` raises for any date after its
`CALENDAR_THROUGH` (2029-12-31). NYSE's own page listed 2026 to 2028, so the 2029 rows are marked `expected` in
`dashboard/src/lib/market-calendar.json`; Alpaca's trading calendar answered only to 2029-12-24, so Christmas 2029
(`rule`) and the sessions of 26, 27, 28 and 31 December 2029 rest on the exchange's rules alone (`checked_against`
says so). The first run to fail is the after-close pipeline check on Monday 2029-12-31 at 18:30 New York (it asks for
the next session); the after-close edition, the clone runner and `wt.options.live` hit the same wall. The first day
lost is New Year's Day 2030: the dashboard's feed watch takes a weekday past the file as an assumed session, shows it
as assumed and never pages on it. `calendar.sessions` warns from Tuesday 2029-10-02 (after the close) and pages from
Friday 2029-11-16, once a New York day. The fix is to extend the exchange holiday list (`HOLIDAYS`, `HALF_DAYS`) and
`CALENDAR_THROUGH` in `wt.options.levels`, and `START, END` in `scripts/build_market_calendar.py` (then
`make schema`), once NYSE publishes the next year; the tests in `tests/unit/test_market_calendar.py` tie the two
lists together day by day.

Owner note: pages raised before this change and still spooled on the host can carry check ids with symbols, and are
sent when ntfy next accepts them. To look: `grep -l "Pipeline check" /home/wt/trading/var/alerts/spool/*.json`
(each file is one message); deleting a file drops that message.
Read the report: `cat /home/wt/trading/var/pipeline-check/$(date +%F)-pre-open.json`.
