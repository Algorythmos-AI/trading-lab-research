# Trading Lab status dashboard

A private, read-only status page for the paper-trading research lab, built with Next.js and hosted on Vercel.
It shows the owner, on a phone or a laptop, whether last night's jobs ran, what the research says, how the paper
account is doing and whether anything needs attention. It cannot trade, stop, reset or change anything.

## Architecture

The dashboard never reaches into the Mac. The Mac pushes; Vercel stores and serves.

```
Mac (launchd job)                         Vercel project (Vercel Authentication on every deployment)
─────────────────                         ─────────────────────────────────────────────────────────
wt.ops.publish                            POST /api/ingest            (production only)
  collect  → sanitize (allowlist) ──────▶   size cap 3.5 MB → HMAC + ±300 s → schema + denylist
  sign HMAC-SHA256, POST with the           → compare with the stored run_id / as_of
  automation-bypass header                  → private Blob snapshots/latest.json   (ifMatch etag)
                                            → private Blob snapshots/history/YYYY-MM-DD/HH.json

                                          Pages (server components, never cached)
                                            read snapshots/latest.json (useCache: false)

                                          GET /api/cron/watchdog      (Vercel Cron, every 10 min)
                                            late / stopped / recovered pages during trading windows,
                                            one "Mac offline" note a day otherwise → ntfy
                                            alert state in private Blob alerts/state.json
                                            prunes history older than 90 days, once a day
                                            then the feed watch: every routine's document on time?
                                            → ntfy only with FEED_WATCH_ALERTS=on; state ops/feeds-alert.json

                                          GET/POST /api/desk/flags    (the Options page, laptop and phone)
                                            the owner's "done for today" flag → private Blob desk/flags.json
                                            (ifMatch etag; production only, memory elsewhere)

                                          GET /api/cron/desk          (Vercel Cron, every minute 13-21 UTC Mon-Fri)
                                            the desk's states for the last settled 2-minute slot, in shadow
                                            (DEC-0044): switch in private Blob desk/eval.json, one create-only
                                            record per slot → private Blob desk/log/YYYY-MM-DD/HHMM.json; sends nothing

                                          POST /api/desk/page-state   (the open Options page, while the switch is on)
                                            the page's own states for the same slot, create-only, first page wins
                                            → private Blob desk/log/YYYY-MM-DD/HHMM.page.json
                                          GET /api/desk/eval-status   (the Options page's rail)
                                            { eval, last_slot_end } only: "Server check paused since HH:MM NY"
                                          GET /api/desk/probe         (the owner, by hand; temporary)
                                            one New York day's snapshot-probe counts from desk/log/YYYY-MM-DD/HHMM.json
```

- **Contract.** `src/lib/snapshot.schema.json` is generated from the Python allowlist (`make schema`) and is
  read-only here. `pnpm gen:types` regenerates `src/lib/snapshot.types.ts` from it. Every field may be null or
  missing, and every page renders "—" for missing values instead of failing.
- **Ingest** (`src/lib/ingest.ts`): previews never accept writes. Accepted outcomes are `stored`, `duplicate`
  (same `run_id`) and `older` (409, `as_of` not newer than the stored one); an etag conflict is retried once.
  Every edition kind (radar, options, ledger, journal, options live, options clone, calendar) whose `as_of` is more
  than ten minutes ahead of the server's clock is refused (422 `ahead-of-clock`). Any value that carries a zone
  (`Z`, `z`, `+00:00`, `+0000`, with `T` or a space) is compared exactly; only a date alone or a wall time with no
  zone counts as ahead just when no zone on Earth has reached it, and is ordered as UTC. A stored edition whose
  ordering time is beyond the ten minutes gives way to the next valid one even though that one's `as_of` is
  "older" (logged `superseded-ahead`), so a stored document can refuse a true edition as older only while it is
  within the allowance. A refusal of an edition's content (`invalid`, `ahead-of-clock`) leaves a record at
  `ops/ingest-rejects/<kind>.json` with only the time, the kind, the outcome and the number of errors
  (`src/lib/ingest-reject.ts`); its write is best effort and never changes the answer. `readIngestRejectStatus`
  returns that record with the kind's latest.json upload time (the store's own metadata) and whether the refusal
  still stands, i.e. nothing of the kind was stored after it.
- **Radar** (`/radar`): the daily pre-market radar's editions, signed with key id `radar` and validated against
  `src/lib/radar.schema.json` (owned here; `pnpm gen:types` regenerates `radar.types.ts`). Stored at
  `radar/latest.json` plus `radar/editions/YYYY-MM-DD.json`, where a same-day refresh replaces that date's copy.
  Optional chart fields (`regime_word`, `gauges`, `scorecard`, `calendar`, and per ticker `evidence_grade`,
  `chart_grade`, `premarket_price`) draw the regime scale, the scorecard, the pick cards and the week strip; an
  edition without them still renders, with fewer pictures.
  It has no expected windows, so the watchdog never pages for it.
- **Options** (`/options`): the after-close options levels editions (support and resistance for the next session,
  close strength, expected move, optional recent daily bars for the level map, and the paper record of the probation
  entry rules), signed with key id `radar` and
  validated against `src/lib/options.schema.json` (owned here; `options.types.ts` is generated). Stored at
  `options/latest.json` plus `options/editions/YYYY-MM-DD.json`, one per session the levels are built for. Like the
  radar it has no windows and no watchdog.
  The edition has a second format (`schema_version: 2`), all of it optional: `market` (the VIX, whether the
  session is a half day, and whether the macro calendar is complete), `events` (macro releases and earnings as
  codes, dates and New York times, never headlines) and a `vol` block on each name (implied and realised vol as
  fractions, percentiles over 13 and 26 weeks, the day's change, option volume and its average). `/api/health`
  reports `accepts: 2` under `editions.options`, which is what a publisher reads before sending it; an edition in
  the first format validates as before and the page draws none of the new parts for it. On the desk the second
  format adds one line under the status bar (`src/components/options-day.tsx`) and four facts on a name. Three
  rules keep that line honest: an event code is drawn only as the name this site has for it (anything else reads
  "Other release", so a headline cannot arrive as a code); a day with no macro row reads "no scheduled release"
  only when the edition marks its calendar complete, and "releases not known" otherwise; and the session's hours
  come from the one half-day flag, the same one the countdown uses.
  The page opens on the **desk** (`src/components/client/options-desk.tsx`): one frame with every name in a sortable
  monitor beside the selected name's level map, rules and facts. Three views change the monitor's columns: Brief (the
  close and what options cost), Live (price against the levels) and Review (the paper record per name). The view
  follows the New York clock until one is chosen; the view and the name live in the address (`?view=live&s=NVDA`),
  so a reload lands in the same place. `J`/`K` move between names and `1` `2` `3` switch view while focus is inside
  the desk. Cmd K or Ctrl K opens a command palette (`src/components/client/desk-palette.tsx`) from anywhere on the
  page: type a ticker, a view, a map layer or a page; names can also be found by "strong", "weak", "rich" or
  "cheap". Below 640px the desk shows one pane at a time, the names or the selected name: choosing a name opens it,
  a bar held at the bottom of the screen switches panes and steps to the next or previous name, the name's price
  line stays at the top while the rest scrolls, and the open pane is kept in the address (`&pane=name`). The
  selected name's level map carries a crosshair (point at it to read a price against the close in
  dollars, ATRs and expected moves, and the zone it is inside) and its zones, candles, expected move and labels can
  each be switched off. The page as it was before stays at `?view=classic` for one release.
- **Option arithmetic** (`src/lib/bs.ts`, `src/lib/longopt.ts`; the contract pane below is built on it): the value of one
  long call or put, its sensitivities, the volatility a price implies, breakeven, and what an hour of waiting costs.
  Textbook Black-Scholes with a flat rate and yield, so an estimate for American options. The same arithmetic is in
  Python (`src/wt/options/`), and both are held to one file of vectors, `test/fixtures/bs.vectors.json`, written by
  `python scripts/gen_bs_vectors.py` (`--check` in the Python tests keeps it current).
- **Option quotes and the contract pane** (`/api/chain?s=SPY&px=780.43`, `src/lib/chain.ts`): calls and puts for one
  name from Alpaca's indicative feed, which runs 15 minutes behind the market, fetched on the server with the same
  keys as the live prices. It answers with the nearest four expiries and the first one a fortnight or more out, 21
  strikes each around the price given; a contract adjusted for a split or a merger is left out. With `&x=` and `&k=`
  (an expiry and a strike) the answer always carries that contract too, so one the reader holds stays quoted
  wherever the price and the calendar have moved. Each name's answer is shared for 20 s. The desk's **Contract** pane (`src/components/client/options-contract.tsx`, logic in
  `src/lib/contract.ts`) stays shut, and asks for nothing, until the reader opens it on a name: then it prices the
  call or put they choose (cost, breakeven, value now, delta, hourly decay) and what it would be worth with the
  stock at the nearest zones and a day's move either side, now, at the session's close and at expiry. The chosen
  contract is kept in the browser's own storage and nowhere else. While the market is open, by the clock, option
  quotes whose newest is more than 35 minutes old (105 for a contract that does not expire that day) are too old to
  price from, and the numbers are withheld; with the market shut the last quotes are simply the last quotes, and the
  stock's price is labelled "Last close" instead of "Now". Everything it shows is an estimate and it suggests nothing.
- **Paper option positions** (`stocksdelta/options-live`, schema `src/lib/options-live.schema.json`): the open option
  positions of the paper account kept for manual option trades, with open interest by strike, published by the
  trading host's `options-live` job through the same signed `POST /api/ingest`. Paper only by its schema
  (`paper: true` is required; an account number, a balance or buying power is an unknown key and refuses the whole
  document), and never from the research environment's key. Only the latest is kept. The desk draws a **Paper
  positions** pane under the list (`src/components/client/options-positions.tsx`, logic in `src/lib/positions.ts`):
  each contract, what was paid, the broker's mark and the open result; a position on one of the desk's names opens
  that name with the held contract loaded into the Contract pane. Read only. A document not renewed for half an
  hour while the market is open is shown with a warning; one older than a day and a half is not shown; until the
  job has published once there is no pane. `/api/health` reports the stored run under `editions.options_live`,
  and nothing of what it holds.
- **Trades** (`/trades`, `stocksdelta/journal`, schema `src/lib/journal.schema.json`; `journal.types.ts` is
  generated): the owner's own closed trades from their brokerage account, matched first in, first out from the
  broker's filled orders by the owner's research environment and published through the same signed
  `POST /api/ingest` with the `radar` key. Each trade is a symbol, call/put/stock, strike and expiry, quantity,
  open and close times, prices and its result in dollars, before fees; an account number, a balance or an order id
  is an unknown key and refuses the whole document. Only the latest is kept (`journal/latest.json`), and each
  edition carries the whole history, so a later one replaces it outright. The page (`src/app/trades/page.tsx`,
  `src/components/journal.tsx`, all arithmetic in `src/lib/journal.ts`, pure and unit-tested) filters by period,
  kind and ticker through the URL and shows tiles, the running total with its drawdown, months, best and worst
  days, a six-month calendar, patterns in the record (each comparing like with like, at least 8 trades a side),
  breakdowns by ticker, kind, hour, weekday, hold time, days to expiry and size, and every trade in a searchable
  table. Read only: it describes what happened and suggests nothing. An edition older than three and a half days
  is shown with a notice. `/api/health` reports it under `editions.journal`. Fixture mode reads the synthetic
  `test/fixtures/journal.v1.json`.
- **Calendar** (`/calendar`, `src/app/calendar/page.tsx`, the grid in `src/components/client/calendar-year.tsx`, all
  arithmetic in `src/lib/market-calendar.ts`, pure and unit-tested): the US market year, 2026 and 2027 (`?y=`), Monday
  to Friday with weekends narrow. Open days, holidays and 1 pm closes come from `src/lib/market-calendar.json`, which
  `scripts/build_market_calendar.py` (`make schema`) builds from the `exchange_calendars` XNYS calendar for a fixed
  range; `tests/unit/test_market_calendar.py` fails when the file drifts from the script, from NYSE's published list
  (`tests/fixtures/nyse/`) or from the Options desk's `wt.options.levels`. Nothing is typed by hand and a day past
  the range says so. The same file carries the repo's own `config/events/macro_events.csv`, `earnings.csv` and the
  Options names, as dates and codes only; event codes are drawn through `EVENT_LABEL`. Each session's open and close
  are shown in Sydney time, with the daylight-saving switches in both places found from the zones themselves. Your
  results are worked out at render time from the journal, exactly as on Trades (`daily()`, by the New York close
  day, before fees), and each day's "!" is the Overview strip's day-rule test (`judgeDay()` in `src/lib/overview.ts`);
  nothing of them is stored. A journal that is missing, unreadable or corrupt costs only the results.
- **Economic calendar** (`stocksdelta/calendar`, schema `src/lib/calendar.schema.json`; `calendar.types.ts` is
  generated): the release dates the Calendar page shows, published once a week (Fri 21:30 New York) by the trading
  host's `econ-calendar` job (`src/wt/ops/econ_calendar.py`) through the same signed `POST /api/ingest`, never with
  the radar key; a shadow host's copy is dropped. FRED's release calendar is the primary for CPI, PPI, jobs, JOLTS,
  retail sales, GDP and PCE (`FRED_API_KEY`); the Fed's FOMC page gives the decision days; the BLS schedule
  (asked only with `WT_CONTACT_EMAIL`, its policy) and the BEA schedule check them, and stand in where FRED is not
  set up. Dates, codes from a fixed list and source ids only. A month after a release's last published date is
  "not yet announced"; a month where two sources disagree carries both. Each source keeps its last good rows on the
  host, so a page that cannot be read, or whose future dates suddenly halve, never empties the calendar: the job
  exits 1 and its unit alerts. Only the latest is kept (`calendar/latest.json`), checked against the schema again
  when read. The page prefers these dates to the repo's `macro_events.csv`, month by month, and says where that
  file (what the paper runners trade around) differs from the official dates; it never changes it. `/api/health`
  reports it under `editions.calendar`. Fixture mode reads `test/fixtures/calendar.v1.json` (the job's own output on
  the recorded sources); `calendar-off`, `calendar-stale` and `calendar-poison` bend it.
- **Live prices** (`/api/quote?s=SPY,QQQ`, read by the Options page every 2 s while it is open, one poll shared by the
  glance strip, the level maps' live dot and the state chips; a quote older than 30 s shows as stale): last trades from
  Alpaca's stock feed named by `ALPACA_FEED` (`src/lib/alpaca-feed.ts`; the free IEX feed by default), fetched on the
  server so the page keeps `connect-src 'self'` and never sees the keys. Every answer names its feed (`feed`), and the
  session bars (`/api/bars`) and the server's shadow check (`desk-run.ts`, which writes on each slot's record the feed its reads answered from, null when nothing was read)
  read the same one. IEX is one exchange, a small share of US volume, so a high or low printed elsewhere can be
  missing from it. At most
  60 symbols (as many as one options edition may carry), each cached 1.5 s per instance on its own, so two pages
  asking for different names share what overlaps; 503 until the keys are set (the page then stops asking), 429 when Alpaca
  rate-limits us, 502 when Alpaca fails otherwise. After a failure the page tries again in 2 s, then 4, 8, 16 and at most
  30 s (`src/lib/backoff.ts`), at 30 s straight away after a 429, and back to every 2 s on the first answer; while it
  waits the board says so, with the seconds left and a Retry now button, and a tab shown again tries once at once. The
  session bars and the option chain wait the same way, capped at their own 30 s interval.
  **What the page says about them.** The page asks for prices every 2 s; it is not sent each trade. The board's feed
  line (and the classic view's glance) says so, names the feed the last answer reported ("IEX" or "SIP"; nothing at
  all for an answer that names none, never a guess), and gives two ages apart (`src/lib/feed-provenance.ts`): **last
  trades N to M ago**, the newest and the oldest last trade across the names (one value for one name, or when both
  ends read the same), from Alpaca's own trade times measured on the server's clock (the board's `serverNow`), so a
  phone whose clock is minutes out reads the same ages and one busy name never makes a quiet one look fresh; and
  **checked N ago**, when the page last got an answer. A name with no trade today is left out of the spread and said
  apart ("1 name with no trade today"). A price checked a second ago can still be a trade from a minute ago: the
  first grows while the second stays small. The spread turns to the warning colour once its oldest end passes 120 s
  and the answer once it passes 20 s, the board's own limits, where the rows and the board pause; the per-name stale
  marks are unchanged. The last-trade ages can read up to about 1.5 s younger than they are, since the server shares
  each name's answer for 1.5 s and the board's clock is set from that answer's time. Fixture mode answers from
  the options fixture with no keys and no network. Research only: the keys are market-data keys and nothing here
  can trade.
- **Watchdog** (`src/lib/watchdog.ts`, pure and unit-tested): in a window a snapshot older than 35 min is late
  and older than 90 min is stopped (both priority 4); a fresh snapshot after an alert sends "recovered"
  (priority 2). Outside every window nothing pages. The alert state is committed with `ifMatch` before paging,
  so a double cron fire pages once. Page text carries R and % only, never currency amounts.
- **Feed watch** (`src/lib/feed-watch.ts`, pure; `src/lib/feed-watch-run.ts`, the tick): one table of every
  document a cloud routine or the desk's own cron must publish (`FEEDS`): its store path, how to read which session
  it is for, its schedule in the zone the routine's cron really uses, a grace, and whether it pages. A new feed is one
  more row: the runner reads its path, evaluates it and pages for it, and the pages' loader (`loadPageFeeds`) reads
  whatever the rows a page asks for need, with no other change (unit tests add one). Drawing a new row on a page is
  that page's choice: the strip lists its chips (`STRIP_FEED_IDS`) and the panel its cards.

  | Feed | Due | Zone | Grace | Wants | Pages |
  |---|---|---|---|---|---|
  | Options edition | 21:52 Mon–Fri | UTC (runbook) | 60 min | `session` = the next session | yes |
  | Pre-open refresh | 08:50 Mon–Fri, until the close | New York (runbook) | 15 min (by 09:05) | `focus.premarket.as_of` on today's New York date | yes |
  | Trade journal | :24 hourly 09:24–15:24 before the close; 21:38 | New York; UTC (runbook) | 45 min; 60 min (only the evening run's own read counts: at most 10 min before 21:38 UTC; the last live run reads until about 16:20:30 New York). The evening rule is **assumed** (how the routine stamps and how early it may fire cannot be checked here): a missed evening sync is shown, not paged | `as_of` at or after the run | after two missed runs |
  | Card ledger, morning | 09:11 | New York, **assumed** | 60 min | `session` = the last session | no (display only) |
  | Card ledger, after close | 16:21 | New York, **assumed** | 60 min | `session` = today | no (display only) |
  | Radar edition | 11:12 Mon–Fri | UTC (runbook) | 60 min (stamp may be 60 min early) | `as_of` at or after the run | yes |
  | Server check | every settled slot in the session, switch `desk/eval.json` exactly `log` | the exchange calendar | 10 min without a record | a record under `desk/log/<day>/` | yes |
  | Refusals | a refusal at `/api/ingest` with nothing newer stored (`readIngestRejectStatus`) | — | — | — | options, journal, radar; the rest display only |

  Runs exist only on market days of the exchange calendar (`market-calendar.ts`): weekends, holidays and a half day's
  afternoon never expect anything, "the next session" comes from the session list, and every New York time goes
  through `nyInstant` (both clock changes, New York and UTC schedules alike). Past the calendar file's end a weekday
  is assumed and the page and the alert say so. States: `on_time`, `waiting` (the run's grace is still open),
  `late`, `failed` (a refusal still stands), `not_expected` and `unknown` (the store could not be read: never late,
  never on time). Episodes mirror the snapshot watchdog's: one page per feed per incident, one "back on time", nothing
  repeated, a new incident only after a recovery or on a new session day; the journal and the ledger only after two
  runs in a row are missed; a refused edition pages once as "refused", not again as "late"; "unknown" pages only after
  three runs in a row (20 to 30 minutes: one failed read clears itself, three is an outage). Its state is one Blob
  document, `ops/feeds-alert.json`. Unlike the snapshot watchdog (whose `commitThenSend` is unchanged) the feed
  watch keeps a two-phase record: every page it decides goes into an outbox in the state as `pending`, and the attempt
  is claimed (attempts + 1, this tick, this run) in the same ifMatch commit, before anything is sent; a write whose
  reply is lost is confirmed by reading the state back; a lost race is decided again once on the other run's state,
  then skipped (never reported as a store failure). The claimed pages are then sent and each outcome recorded. A page
  still pending (its record was lost, the run died, the send failed) is sent again by a later run, no sooner than the
  next tick. Only recorded failed sends count as tries (a claim whose run never sent, for want of time or of a
  confirmed commit, uses none): 3 quick tries, one a tick; then the page is `sent_failed` (logged as
  `feed-watch.outbox` with the feed id, and said on the Operations page's card: "An alert about this feed could not be
  sent to your phone") and tried again once every 30 minutes until it is 2 hours old (3 more, 6 tries in all). A page
  that reaches 2 hours or 10 claims unsent is marked `sent_failed` and logged, never dropped silently. **Guarantee:**
  while the store works a decided page is never lost: it goes out, or it is recorded and shown as not sent. It is
  sent at most 10 times (one per stored claim) even if every record of a send were lost; normally at most 6 tries. A
  recovery meets the page it answers: one never claimed is dropped with it; one that could not be sent is replaced
  by a single "was late for N min, now back on time" page; one claimed (perhaps delivered) is kept and the recovery
  sent too. The remaining case: a late page delivered and then a recovery that fails all its tries leaves the owner
  with the late page only; the Operations card says an alert could not be sent. Pages still pending from before an
  off-to-on switch go out with the switch-on summary if they are under 2 hours old; older ones are marked
  `sent_failed`. The run's answer and log list only what was actually sent. When the alert state cannot be
  read (two tries, 500 ms apart) or a decision cannot be confirmed, the run sends no feed page at all. Instead, with
  alerts on, a run in either of the first two 10-minute ticks of each 2-hour UTC block (tick index mod 12 is 0 or 1,
  from the run's execution time: Vercel's cron sends no scheduled time) sends "Feed watch cannot read its store": a
  total outage pages within 2 hours 10 minutes even if one of those runs is skipped, at most 2 per block (4 hours, 24
  ticks: 4, and up to 4 per block if the cron delivers both of those ticks twice: on a public topic a 12-hour outage
  can send 12 to 24; the rule stays stateless on purpose), and an incident paged before the outage is never paged
  again after it. In the cron (`cron-watchdog.ts`) the feed watch's tick starts at once beside the desks' ticks, so
  a hanging store in a desk's tick cannot starve it; the desks run one after another, each one's budget (14 s, over
  ntfy's 10 s send timeout plus two writes) deciding when the next may start; no started tick is abandoned: the reply
  waits for all of them up to 55 s and hands any still running to Next's `after()` (Vercel's waitUntil), inside the
  route's 60 s. The feed watch's own run keeps a 25-second budget.

  **Refusals.** One refusal record covers a whole kind, and the pre-open refresh posts a whole edition under the
  `options` kind, so a refusal quietens a document row's lateness page only for the run it belongs to: refused at or
  after that run's time and before the row's next run (`refusalForSlot`). That run is shown "failed" and pages once, as
  "refused", on its refusal row; every later missed run (the evening build, the next morning's refresh) pages as late
  in its own right. Each refusal (a new refusal time) is a new incident; a good store after it sends one "back on
  time". A storage outage ("cannot be checked") is its own incident beside a late one: it never replaces it, so a feed
  already paged late is not paged late again when the store reads again; one "back on time" closes both.

  **Display only until the owner says so.** Pages are sent only when `FEED_WATCH_ALERTS` is exactly `on` (the owner
  sets it in Vercel; nobody else). Off, every run still reads, evaluates and stores its incidents, marked unsent, and
  the pages show everything; the state records `alerts: "off"`. At switch-on (the first run with it on after a run
  with it off, read from `ops/feeds-alert.json`, not from memory) exactly one summary page lists the incidents still
  open by feed name, and they are marked sent; each then pages "back on time" when it recovers, and every new incident
  pages on its own. Nothing open: nothing sent. Off and on again later: the same, one summary of what opened while it
  was off. Recoveries while off are not sent. A summary that fails to send is sent again on the next run. `make feed-watch-drill` runs the real tick offline through late and recovered
  and prints both pages.

  **Division of labour with the host's pipeline check** (`src/wt/options/pipeline_check.py`, 08:55 and 18:30 New
  York): the feed watch owns timeliness (did the document for the right session arrive by its time); the pipeline
  check owns content (closes, levels, expiries against the market's own data). A missing or late edition also fails
  the pipeline check's `options.present`, `options.session` or `options.built_from`: when the feed watch has paged
  the options edition late or refused for that session, those ids in a pipeline-check page are the same incident;
  only its content ids (`options.close.*`, `options.levels.*`, `focus.*`) are new. The edition's deadline is 22:52
  UTC, 17:52 New York in winter (before the 18:30 check) and 18:52 in summer (after it, so in summer the pipeline
  check reports a missing edition first). The pre-open refresh's `focus.premarket` is only a warning there, so only
  the feed watch pages for it.

  The Operations page's "Your feeds" panel and the Options page's health strip (`components/client/feed-strip.tsx`:
  the edition, the pre-open refresh, the live prices, the session bars, the journal and the server check, each with
  its state and age, fixed-size chips) are drawn from the same table and evaluator. Both show the journal by the
  board's own day check (`trade-rules.ts` `journalCurrent`, read only), so a page never gives two answers; the
  two-missed-runs rule decides only whether to send an alert. The strip runs on the server render's time moved on by the browser's
  monotonic clock since that time arrived, re-anchored by every refresh (each server time keeps its first anchor, and
  the shown time never goes backwards), never the device's wall clock; it is read once a second. It runs behind true
  time by the age of the server render when it arrived (render, transfer and hydration: usually under a few seconds,
  more on a slow connection) plus at most a second of sampling. When no new server time has come for 3 minutes, or the
  wall and monotonic clocks disagree by over 30 seconds (the machine slept, the clock was changed), the chips that read
  well (on time, not due, waiting) read "Checking" until the layout's refresh brings one; a late or failed chip keeps
  its warning. A failure (prices off, failing, being retried) always wins over "not due". `feeds.ts` keeps the constants
  and `journalCheck` the shadow evaluator's engine reads (it is inside `gen:engine`'s hash), unchanged; the feed
  watch imports from it and is outside the engine's import closure.
- **Health** (`src/lib/health.ts`) and the top-of-page **summary** sentence (`src/lib/summary.ts`) are pure
  functions of the snapshot and the current time.

## Desks

The site shows three desks. The header's switch moves between them, and each has its own snapshot, its own
freshness pill and its own watchdog state (ADR 0005). Ingest files a snapshot by the `schema` id inside the signed
body, never by a header.

| Desk | Pages | `schema` id | Schema file in `src/lib/` | Latest snapshot | Watchdog state |
|---|---|---|---|---|---|
| Stocks | `/` and every page outside another desk's prefix | `trading-lab/snapshot` | `snapshot.schema.json`, generated from the Python allowlist (`make schema`) | `snapshots/latest.json` | `alerts/state.json` |
| Crypto (closed, DEC-0036) | `/crypto`: one static page | `trading-lab/crypto-snapshot` (still accepted; the desk no longer publishes) | `crypto.schema.json`, frozen since `wt.crypto` left the tree (ADR 0005 addendum) | `snapshots/crypto/latest.json` | `alerts/crypto-state.json` (not watched: the desk is closed) |
| HFT | `/hft` | `hft-lab/snapshot` | `hft.schema.json`, a copy of the contract owned by `Algorythmos-AI/hft-lab`, pinned by `hft.contract.lock.json` | `snapshots/hft/latest.json` | `alerts/hft-state.json` |

- **One entry per desk.** A desk is an entry in `src/lib/desk.ts` (label, first page, storage paths), a contract
  in `src/lib/validate.ts` (keyed by schema id: the validator and the slot come from the same entry), a loader in
  `src/lib/snapshot.ts`, a watchdog entry in `src/lib/watchdog-run.ts` and a section list in
  `src/components/client/nav-tabs.tsx`.
- **The HFT desk lives in another repository** (ADR 0006). This repository holds no code for it; the dashboard
  only shows what it publishes. Until its first snapshot arrives, `/hft` is an empty state with no numbers, its
  watchdog tick is skipped and `/api/health` reports `desks.hft.snapshot` as `missing`.
- **Who may publish a desk** (`src/lib/ingest-scope.ts`). By default the key id named by `PRIMARY_HOST` (the
  `default` key when unset) is the primary publisher of every desk, and any other valid key's snapshot is filed in
  the desk's shadow slot, which nothing reads. `DASHBOARD_INGEST_SCOPES` changes that per key: a JSON map
  `{"<key id>": {"desks": ["hft"]}}`. A key id listed there is the primary publisher of exactly those desks,
  whatever `PRIMARY_HOST` says, and may send nothing else: another desk's snapshot, a research edition or the
  options live document signed with it is refused with 403 (logged as `key-scope`) and nothing is stored. A key id
  not listed behaves as before, except that it is no longer primary for a desk a listed key owns: its snapshot for
  that desk goes to the shadow slot. Unset or `{}` changes nothing. The key's secret still comes from
  `DASHBOARD_INGEST_KEYS`, and the signature is checked before any of this.
  A value that is not exactly that shape (not JSON, an unknown desk, an empty desk list, a field beside `desks`,
  a key id outside the key-id pattern, the id `radar`, or one desk given to two keys) is not applied at all. Every
  other key then follows `PRIMARY_HOST` alone, and every word of the value that could be a key id is refused
  with 503 (`key-scope-config`) until the value is fixed, so a key that was meant to be limited never becomes
  unlimited through a typing mistake. Each signed request logs `ingest.scopes` with a reason code while it lasts.
- **Taking a new version of the HFT contract.** Copy the schema from `hft-lab` over `src/lib/hft.schema.json`, run
  `pnpm gen:types`, and put the file's SHA-256 and the source commit in `src/lib/hft.contract.lock.json`.
  `pnpm test` fails while the hash and the file disagree. `make schema` does not produce this file. Deploy the
  dashboard before the publisher that sends the new fields: ingest refuses fields it does not know.
- **When the HFT desk is watched.** Like every desk, inside the `expected_windows` of its own latest snapshot.
  Currencies are closed at weekends, so each snapshot must list the window that is open or the next one to open;
  when every listed window has ended, the watchdog falls back to US equity weekday hours.
- **Fixture mode** serves `test/fixtures/hft.v1.json`. The `fx` cookie's `empty` and `error` variants (below) also
  put `/hft` into its not-yet-published and storage-down states.

## Local development

```sh
pnpm install
DASHBOARD_FIXTURE=1 pnpm dev        # serves test/fixtures/snapshot.json, no storage or secrets needed
```

| Script | What it does |
|---|---|
| `pnpm dev` / `pnpm build` / `pnpm start` | Next.js development server, production build, production server |
| `pnpm lint` | ESLint (Next.js core-web-vitals + TypeScript rules) |
| `pnpm typecheck` | `tsc --noEmit` in strict mode |
| `pnpm test` | Vitest unit tests: HMAC vectors, schema and denylist, health, summary, watchdog, ingest |
| `pnpm test:e2e` | Playwright in fixture mode: a smoke test of every page (`smoke.spec.ts`), the Options desk's layout, views, keyboard, sorting, failure states, live updates, phone layout and contract pane (`desk.spec.ts`), the same failure states on the classic Options page (`states.spec.ts`), and an axe accessibility scan of every stocks page in both themes (`a11y.spec.ts`) and of the Options desk at a phone's width (`a11y-phone.spec.ts`). CI only: it needs `pnpm build` first and a browser installed by the workflow (`pnpm exec playwright install --with-deps chromium`) |
| `pnpm gen:types` | Regenerate every `src/lib/*.types.ts` from its schema. CI fails when any of them differs from what is committed |

Fixture mode is refused on production deployments, and the page shows a banner whenever it is on.

**Fixture variants.** In fixture mode only, the `fx` cookie bends the fixtures into the states a pane must survive
(`src/lib/fixture-variants.ts`): `empty` (nothing published), `error` (storage down), `partial` (a valid but sparse
edition), `poison` (a stored edition that no longer matches its schema), `quotes-off`, `quotes-error` and
`quotes-tick` (the live price flips by a cent every three seconds), `quotes-flaky` (the first quote answers, the next
three fail, then every one answers; counted per browser in the `fxflaky` cookie), and `feeds-ok`, `feeds-late`,
`feeds-failed`, `feeds-unknown` (the feed watch's inputs only, for the health strip and the feeds panel). Join several
with a dot:
`fx=partial.quotes-tick`.
Outside fixture mode the cookie is never read.

**One pane fails alone.** Each pane of the Options page sits in a `PaneBoundary`
(`src/components/client/pane-boundary.tsx`). A pane that cannot be drawn shows a short notice with a retry; the
other panes keep working.

## Environment variables

| Name | Where | Purpose |
|---|---|---|
| `BLOB_READ_WRITE_TOKEN` | Vercel **production only** (added when the private Blob store is connected) | Read and write snapshots and alert state. Previews must not hold it: they run with `DASHBOARD_FIXTURE=1` |
| `DASHBOARD_INGEST_SECRET` | Vercel production + the Mac's `~/trading/.env` | Shared HMAC key for `/api/ingest` |
| `DASHBOARD_INGEST_KEYS` | Vercel production (optional) | JSON map `{"<key id>": "<secret>"}`: one HMAC key per publisher, chosen by the `x-wt-key-id` header (ADR 0004) |
| `PRIMARY_HOST` | Vercel production (optional) | The key id whose snapshots are the visible ones; default `default`. Every other key's go to the shadow slots |
| `DASHBOARD_INGEST_SCOPES` | Vercel production (optional) | JSON map `{"<key id>": {"desks": ["hft"]}}`: that key is the primary publisher of those desks and may publish nothing else (see Desks). Holds no secret |
| `RADAR_INGEST_SECRET` | Vercel production + the radar's cloud environment | HMAC key for key id `radar`. It may only publish research editions (`stocksdelta/radar`, `stocksdelta/options`, `stocksdelta/journal`); unset means the radar key is refused |
| `ALPACA_API_KEY_ID`, `ALPACA_API_SECRET_KEY` (or Alpaca's own `APCA_API_KEY_ID`, `APCA_API_SECRET_KEY`) | Vercel production only | Alpaca paper-account keys, used only for the market data behind `/api/quote` and `/api/bars` (the feed is `ALPACA_FEED`'s); unset means the Options page shows live prices as off |
| `ALPACA_DATA_URL` | Vercel (optional) | Market-data base URL, default `https://data.alpaca.markets` |
| `ALPACA_FEED` | Vercel (optional) | The stock feed for the live prices, the session bars and the shadow check: `iex` (default when unset or empty; free, one exchange) or `sip` (every US exchange). Case and surrounding spaces are ignored. `sip` needs a paid Alpaca market-data plan and is the owner's decision alone. Any other value is refused: `/api/quote` and `/api/bars` answer 503 `not-configured` (in fixture mode too), so the page drops its prices and shows them as off until it is reloaded, the shadow check logs `bars-off`, and one log line `alpaca.feed` gives the bad value's length, never the value. With `sip` on a plan that does not include it, Alpaca answers 403: the routes then answer 503 `not-configured` with `why: "plan"`, the page shows the prices as off and says SIP is not on this data plan, the shadow check logs `bars-off`, and one `alpaca.feed` line with outcome `plan` is logged (a 403 on `iex`, or a 401, stays a 502 failure). The option chain's feed is separate and not set by it |
| `CRON_SECRET` | Vercel production | Bearer token Vercel Cron sends to `/api/cron/watchdog` and `/api/cron/desk` |
| `NTFY_TOPIC` | Vercel production and preview + the Mac | Secret, random ntfy topic for pages; unset means log and skip |
| `NTFY_SERVER` | Vercel (optional) | ntfy server, default `https://ntfy.sh` |
| `FEED_WATCH_ALERTS` | Vercel production (the owner sets it) | Exactly `on`: the feed watch sends its pages. Unset or anything else: display only (state still kept, nothing sent) |
| `DASHBOARD_FIXTURE` | Local, CI and Vercel preview | `1` serves the fixture snapshot (ignored in production) |
| `DASHBOARD_INGEST_URL` | The Mac | `https://lab.algorythmos.com/api/ingest` |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | The Mac | Lets the publisher through Vercel Authentication |

`scripts/provision_secrets.sh` creates or rotates all of these in one go, for the owner to run once. It never
prints a secret; it prints only the ntfy topic and how to subscribe to it.

## Security model

- **Vercel Authentication on all deployments.** Only the owner's Vercel login can open the site. The only
  exception is the automation bypass secret, which only the Mac's publisher holds.
- **Signed writes.** `/api/ingest` accepts only production writes signed with HMAC-SHA256 over
  `"<timestamp>.<body>"` with a ±300 s window, compared in constant time. Bodies are capped at 3.5 MB.
- **Schema plus denylist.** Every snapshot is validated against the JSON Schema (`additionalProperties: false`
  everywhere), and a server-side denylist refuses restricted keys (decision titles, hypothesis names and
  statements, spec title and open items, headlines, review URLs, subjects, statements) even if a future schema
  allowed them. Validation errors name paths, never values.
- **Read-only UI.** No page has a control that trades, kills or resets anything. The buttons switch the colour
  theme, copy a command to the clipboard, and set the owner's own "done for today" flag (below), the one thing the
  browser writes.
- **The done-for-today flag** (`/api/desk/flags`, `src/lib/desk-flags-run.ts`). One private Blob document,
  `desk/flags.json`: `{ "v": 1, "done": { "day": "<New York day>", "at": "<instant>" } | null }`. It counts only on
  the New York day it names, so it clears itself at the next day with no job; Undo is allowed for 60 s after it is
  set, then the day stays done. What protects the write:
  - Vercel Authentication, which covers `/api/*` exactly as it covers the pages (`src/proxy.ts` gates nothing: it
    only sets the pages' script policy, which is why it skips `/api/`).
  - Same origin only: POST needs `Content-Type: application/json` (else 415) and an `Origin` whose host is the
    request's own, or `Sec-Fetch-Site: same-origin` when there is no Origin (else 403). No CORS headers are sent.
  - Any request presenting Vercel's protection bypass is refused (403): the `x-vercel-protection-bypass` header or
    query parameter, or `x-vercel-set-bypass-cookie` as a header or query parameter (`presentsBypass`, shared by
    `/api/desk/flags`, `/api/desk/page-state`, `/api/desk/eval-status` and `/api/desk/probe`). The cookie Vercel then
    sets is not read: its documentation does not name it, and guessing could refuse the owner's own login cookie.
    So the publisher's bypass secret can never set or clear the flag.
  - A body of at most 256 bytes (413), exactly `{"action": "done" | "undo"}` (400), 405 for other methods, a fixed
    path, and error answers that are codes only: nothing from the request is echoed.
  - Writes are conditional on the store's etag; a conflict (the other device's tap first) re-reads and re-applies
    once, then answers 409. Nothing is shown as saved before the server answers.
  - In fixture mode and anywhere but production it never touches Blob: the flag lives in the server process's
    memory and every answer says `"memory": true`.
  - A read that fails counts as done for the server's alerts (`doneForAlerts`), so a failed read never lets an entry
    alert out; the page says "Could not check" instead.
- **The server's shadow check of the Options desk** (DEC-0044; `src/lib/desk-eval.ts`, `desk-run.ts`,
  `desk-page-run.ts`). It works out the desk's states on the server by calling the page's own functions
  (`boardRows`, `boardMode`, `boardDay` over `trade-state.ts`) for the last settled 2-minute slot, and logs them. It
  sends nothing: no alert, push or message, and no order. Its Blob documents, all private:
  - `desk/eval.json`, the switch: exactly `{ "v": 1, "eval": "off" | "log" }`, read every run and by both page
    routes; missing or anything else is off, so it is off until the owner writes it, and a change needs no deploy.
  - `desk/log/YYYY-MM-DD/HHMM.json` (New York day, slot end), one per slot, create-only and never overwritten: a
    second run in the slot (or a double fire, or a late retry) finds it and stops. Enum values, booleans, symbols and
    instants only (`v`, `engine`, `status`, `reason`, `slot_end`, `evaluated_at`, `session`, the edition's session
    and build time, `board`, `rows: [{ symbol, side, state, bar_end }]`, `gap_symbols`, `day: { journal_current,
    break_today, day_limit_used, done, half_day, gap, broke_earlier, stale }`, `degraded_names`, `snapshot_ok`):
    no price, level, amount, journal trade or free text. After the engine's fields come `feed` and `probe`, the
    log-only snapshot probe (`src/lib/quote-probe.ts`; temporary evidence for the board's bad-data guards, read at
    `GET /api/desk/probe?day=YYYY-MM-DD`; see docs/runbooks/dead-man-switches.md): enums, ages in seconds and
    distances in basis points per focus name, never a price. It reads the settled bars and the same snapshot the
    page's quote route reads (the last trade's time for staleness, the more extreme high and low). A wrong-day edition logs
    `wrong-day`; a bars or snapshot failure or timeout logs `degraded` with its reason and no rows; a name with a gap
    from its break on (the page's own test) is listed in `degraded_names` with no state, the others keep theirs.
    `ENGINE_VERSION` is generated by `pnpm gen:engine` from the engine's code (a unit test fails when it is stale).
  - `desk/log/YYYY-MM-DD/HHMM.page.json`, a visible page's states for the same slot: as of the slot's close
    (`rows`, `as_of`, `bars_delayed`) and when sent at settle (`rows_at_settle`); create-only, first visible page
    wins. A hidden page's record goes to `HHMM.page-hidden.json`, so it can never take a visible page's place.
  - `desk/guards.json`, the bad-data guards' switches (`src/lib/quote-guards.ts`, `desk-guards.ts`): exactly
    `{ "v": 1, "on": [...] }` with any of `bar-high-below-low`, `bar-open-outside-range`,
    `price-far-from-prior-close`, `quote-crossed`; missing, malformed or unreadable is every guard off, so all are off
    until the owner writes one on, and `{ "v": 1, "on": [] }` turns them off again. Read every evaluated run, by the
    Options page's render and by the page every minute while its board is live (`GET /api/desk/guards`, hardened like
    `/api/desk/eval-status`, answers `{ on, status }` only); no deploy. A guard that is on and trips reads "paused:
    check your platform" with its reason on the page and on the server alike. After `probe` the server record carries
    `guards` (how the switches read, which were on, and per focus name the guards that would pause it whatever the
    switches say, and whether its row was paused and why) and `http_429` (the run's 429 answers); a page record names
    the guards it ran with (`guards`) only when any was on, and the shadow numbers compare a slot only when both
    sides ran with the same ones. `GET /api/desk/probe` adds their counts per feed (`guards`).

  What protects each route:
  - `GET /api/cron/desk`: the bearer `CRON_SECRET`, compared in constant time exactly like the watchdog (401
    otherwise), `no-store`. Idle with no store call outside the New York session (the exchange calendar's
    weekends, holidays and half days).
  - `POST /api/desk/page-state`: hardened like `/api/desk/flags` (same origin, JSON only, the bypass refused
    as there, no CORS, `no-store`), a 2 KB body, POST only, and a strict schema: `{ slot_end, engine, as_of,
    bars_delayed, rows, rows_at_settle }` (each row `{ symbol, side, state }`) or `{ slot_end, engine, hidden: true }`,
    the symbols today's focus names, the states the engine's words, `as_of` inside the slot's grace window, the slot
    one of today's that has just settled, the engine the server's own; refused while the switch is off.
  - `GET /api/desk/eval-status`: GET and HEAD only, cross-site refused, the bypass refused as for `/api/desk/flags`
    (its header and query forms; no cookie is read), `no-store`; answers `{ eval, last_slot_end }` only, from at
    most five head() calls (never a listing).
  - `GET /api/desk/probe?day=YYYY-MM-DD` (`src/lib/quote-probe-run.ts`): GET and HEAD only, cross-site refused, the
    bypass refused as for eval-status, `no-store`, the day a real `YYYY-MM-DD` (400 otherwise; today in New York when
    left out). Unlike eval-status it **lists** a day's records: one listing of `desk/log/<day>/` and one read per
    server record (`HHMM.json` only, at most 256, 8 at a time; page records are never read). It answers counts,
    enums and numbers per name only, grouped by the record's feed (`quote-probe.ts` summariseProbe), never a
    record's text, and `503 read-failed` without detail when the listing fails. A HEAD answers from validation
    alone and reads nothing. A past day's summary is kept in the instance's memory (at most 5 days; never today,
    never a day with an unreadable record or an empty listing). Read only when the owner opens it; dry (no store
    call) in fixture mode and anywhere but production.
  - The Options page's server render reads the switch; while it is off the browser makes no request about the check
    at all. While it is on, the page reads the status at most once a minute and posts once per settled slot.
  - In fixture mode and anywhere but production none of them touches Blob: the switch reads as off.
- **No secrets client-side.** Storage, HMAC and cron checks run only in server code; nothing secret is sent to
  the browser. Logs are one JSON line per event and never include bodies, headers or secret values.
- **Headers.** `vercel.json` sets a strict Content-Security-Policy, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, a restrictive `Permissions-Policy`,
  `X-Robots-Tag: noindex, nofollow` and `Cache-Control: no-store` on pages and APIs; `robots.txt` disallows all.

## Data classes

The repository is restricted (see `AGENTS.md`). The dashboard only ever receives what the publisher's allowlist
lets through, and the ingest denylist is a second line of defence:

- **Restricted** material (specifications, decision and hypothesis prose, reports, setup names, news headlines,
  the knowledge base) is never published. Registries appear by ID, status and date only.
- **Private** material (paper account balances, host details, log lines, commit subjects) is shown only behind
  the owner's login, already redacted by the publisher.
- **Safe** material (counts, IDs, statuses, dates, R-multiples and statistics) makes up the rest.

## Deployment notes

- Set the Vercel project's root directory to `dashboard/` and connect a **private** Blob store.
- The watchdog cron runs every 10 minutes, which needs a Vercel plan that allows sub-daily cron jobs.
- CI: run `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`,
  `DASHBOARD_FIXTURE=1 pnpm build`, then install Chromium and run `pnpm test:e2e`.
