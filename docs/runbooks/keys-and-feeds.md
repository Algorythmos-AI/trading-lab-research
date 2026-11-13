# Keys and feeds

You'll need this page when the Alpaca data plan changes or lapses, when a tool answers HTTP 401, when the Options page
says live prices are off because of the data plan, or before a change that adds a market-data request.

## Why every request names its feed

Per Alpaca's documentation (not verified by a call here), a market-data request that leaves `feed` out gets "the best
one the subscription allows": IEX on the free plan, SIP (the consolidated tape) on Algo Trader Plus, and IEX again if
the subscription lapses. A request without a feed would change its data source with the plan, with no code change and
no record. So every request here names its feed, and these guards fail on one that does not:

- Python, at run time: `wt.data.feeds.require_feed`, called before anything is sent by `AlpacaREST.get` (and
  `AlpacaREST.get_response`, the one-request form the selection's fetcher uses to read statuses and headers) and by the
  request helper of each module with its own HTTP session: `AlpacaFeeds._get` in `wt.live.runner_o` (a refusal is a
  `TransportError`, a failed data read: a refusal while preparing the levels turns entries off for the day; one on a
  chain, quote or minute-bar read skips that entry or makes the tape read as stalled; exits are managed in every
  case), `OptionsAccount._get` in `wt.options.live`
  (a `BrokerFault`: the extra it was for is left out and named in `problems`, the positions still go) and
  `_alpaca_get` in `wt.options.pipeline_check` (unusable market data: `data.reachable` fails and pages, exit 0).
  Each refusal also writes "a market-data request named no feed" to the job's log.
- Python, in the tests: `tests/unit/test_feed_named.py` (the scan is `tests/unit/feed_scan.py`) checks every request
  call in `src/`, `scripts/` and `deploy/`, and every use of an alpaca-py data request class (the SDK leaves
  `feed=None` out of the query: `self.model_dump(exclude_none=True)` in `NonEmptyRequest`).
- Python, every call site: `tests/unit/test_feed_call_shapes.py` runs each request the code sends today against a
  fake session (or copies it, for two hand-run scripts) and checks it with `require_feed`.
- `wt.live.runner_o`, `wt.options.live` and `wt.options.pipeline_check` use their own HTTP session: they are covered
  by the scan and by `require_feed` in their request helpers; `test_feed_call_shapes.py` checks that every request
  those helpers send leaves unchanged with the guard in place.
- Dashboard: every data URL is built by `alpacaDataUrl` (`dashboard/src/lib/alpaca-data-url.ts`), which throws
  without a feed; `dashboard/test/alpaca-data-url.test.ts` fails on a data request built anywhere else.

Both tests keep a list of known exceptions (requests awaiting the owner's decision). Both lists are empty. Each test
states the cases it cannot catch.

## Inventory (2026-11-12)

Every place the repo asks Alpaca for market data. "Host": a scheduled job on the cloud host. "Site": the dashboard on
Vercel. "Hand": run by hand. No module uses the alpaca-py data clients or streams; the SDK is used only for the
trading API (`TradingClient`).

"Bound by" names the record that fixes the feed. "Described in" names a record or runbook that mentions the feed
without fixing it. Read the records themselves for what they decide.

| Consumer | What it reads | Feed | Where the feed is set | Bound by | Described in |
|---|---|---|---|---|---|
| Owner's board, live prices (site, `/api/quote`) | stock snapshots | `ALPACA_FEED`, default iex; sip on production by DEC-0050 once the owner sets it | `ALPACA_FEED` on Vercel (`alpaca-feed.ts`) | DEC-0042, DEC-0050 | DEC-0049, board-feed and feed-agreement runbooks |
| Owner's board, session bars (site, `/api/bars`) | 2-minute stock bars | `ALPACA_FEED`, default iex; sip on production by DEC-0050 once the owner sets it | the same | DEC-0050 | DEC-0044, DEC-0049, feed-agreement runbook, board-feed runbook |
| Shadow evaluator (site, `/api/cron/desk`) | 2-minute bars and snapshots | `ALPACA_FEED`, default iex; sip on production by DEC-0050 once the owner sets it | the same | DEC-0050 | DEC-0044, DEC-0049, EXP-0031, feed-agreement runbook, board-feed runbook |
| Owner-trade labeller (EXP-0031 labels; not built yet) | settled 2-minute bars | iex, asked for by name, never from `ALPACA_FEED` | its own pull request | DEC-0049 | EXP-0031 |
| Owner-trade labeller (EXP-0033 labels; not built yet) | settled 2-minute bars | sip, asked for by name, never from `ALPACA_FEED` | its own pull request | DEC-0050 | EXP-0033 |
| Contract pane and chain (site, `/api/chain`) | option snapshots | `ALPACA_OPTION_FEED`, default indicative; opra on the owner's setting (check the site's setting) | `ALPACA_OPTION_FEED` on Vercel (`option-feed.ts`) | DEC-0050 (point 6) | none |
| Manage card's live option value and ticket price check (site, `/api/contract`) | option snapshots of the named contracts (latest quote and trade) | `ALPACA_OPTION_FEED`, read as for the chain; the page shows a live value only on opra. The journal names a contract by name, kind, strike and expiry only, so an adjusted contract (another root, such as AAPL1) and SPX beside SPXW cannot be told apart from those fields: a value is given only when the name is itself the root and the contract is listed once in the chain | `ALPACA_OPTION_FEED` on Vercel (`option-feed.ts`) | DEC-0050 (point 6) | none |
| Entitlement probe (site, `/api/health` and the Feeds page) | SPY's latest stock quote; one SPY option snapshot | sip and opra, asked for by name, never from `ALPACA_FEED` or `ALPACA_OPTION_FEED` | literals in `entitlement.ts` | none | none |
| Feed agreement (hand, `make feed-agreement`) | 2-minute stock bars | iex and sip | literal per run (`barsUrl`) | none | feed-agreement runbook |
| Feed comparison sampler (site, `/api/cron/feeds`) | stock snapshots of the focus names and SPY | iex and sip, one request each a minute | literals in `feed-compare-sample.ts` (`askFeed("iex")`, `askFeed("sip")`), never `ALPACA_FEED` | DEC-0050 | feed-agreement runbook, "Server comparison" |
| Feed comparison report (site, `/api/cron/feeds-report`) | the session's 2-minute and settled 1-minute stock bars of the focus names | iex and sip | literals in `feed-compare-report.ts` (`fetchSessionBars("iex")` / `("sip")` through `barsUrl`; `fetchMinuteBars("iex")` / `("sip")` through `minuteBarsUrl` in `feed-compare-bars.ts`), never `ALPACA_FEED` | DEC-0050 | feed-agreement runbook, "Server comparison" |
| Flow data (site, `/api/flow`) | stock snapshots and today's 2-minute bars with volume, of the allowed names only (today's focus names, SPY and QQQ; EXP-0032) | sip | literal in `flow-route.ts`, never `ALPACA_FEED` | DEC-0050 | none |
| Signal log (site, `/api/cron/desk`, the signal step after the shadow evaluator) | stock snapshots and today's 2-minute bars of the focus names, SPY and QQQ (`/api/flow`'s own read, in process); option snapshots (the chain) of each focus name | sip and opra, asked for by name, never from `ALPACA_FEED` or `ALPACA_OPTION_FEED` | literals in `flow-route.ts` (`serverFlow`) and `signal-run.ts` (`fetchChain(..., "opra")`) | DEC-0051 (section 4) | EXP-0034 |
| Flow baseline (site, `/api/cron/flow-baseline`) | split-adjusted 2-minute bars of the previous 20 full sessions, for the same names (today's bars in `/api/flow` stay raw) | sip | literal in `flow-baseline-run.ts`, never `ALPACA_FEED` | DEC-0050 | none |
| Paper runner B, signal bars (host, `paper-b`) | 1-minute bars | iex | literal default in `runner_b.py` | DEC-0037 | none |
| Paper runner B, latest quotes (host) | latest quote of the signal and trade names | iex | literal | none | DEC-0024 |
| Paper runner B, sigma (host) | 1-minute bars of the 14 prior sessions | sip | literal | none | none: set in code |
| Options clone, stock minute bars (host, `paper-o`) | 1-minute bars of its names and SPY | iex | literal in `runner_o.py` | set in code, no record binds it | DEC-0031 |
| Options clone, levels (host) | daily bars | sip | literal | none | DEC-0033 |
| Options clone, option quotes and chains (host) | option snapshots | indicative, or opra | `feeds.option` in `config/options_clone.yaml`; the file `var/options/switches/opra` selects opra | DEC-0030 section 4 | none |
| Paper positions (host, `options-live`) | stock snapshots (last close) | iex | literal in `options/live.py` | none | none |
| Paper positions, rules and hourly blocks (host) | daily and 30-minute bars | sip | literal | none | EXP-0023 |
| Pipeline check (host) | daily bars; snapshots | sip; iex | literals in `pipeline_check.py` | none | none |
| Pre-market routine (host, `routine`) | 1-minute bars, news | hybrid: sip to 16 minutes ago, iex after | `HybridFeed` names both; `--feed` overrides | DEC-0023 | none |
| Forward test (host, `forward`) | daily and 1-minute bars | sip | `AlpacaREST.bars` default argument `feed="sip"` | DEC-0009 | none |
| Selection bundles (`python -m wt.options.select_fetch`; no job runs it yet) | Stage 1: split-adjusted daily bars. Stage 2: raw daily bars, 1-minute bars, split-adjusted 5-minute bars, snapshots; corporate actions and news (counts only) take no feed | sip | literal in `select_fetch.py` | DEC-0046 | none |
| Research scripts (hand: `build_pool`, `scan`, `r2_`, `r3_`, `g1_`, `exp*`, `options_replication`, `options_clone_dry_run`) | bars, quotes, trades | sip | literal, or the `bars` default | not reviewed per script here | - |
| News (`AlpacaREST.news`), option bars (`options_clone_dry_run`) | news; historical option bars | none: these endpoints take no feed | - | - | - |

Every request names its feed, so a plan change does not change any request's source. Two settings outside the code
choose a feed. Check them after any plan change: `ALPACA_FEED` on Vercel (unset or `iex` keeps the board, its bars
and the evaluator on IEX), and whether `var/options/switches/opra` exists on the host (it switches the clone's option
quotes to OPRA). The clone's `feeds.option` in `config/options_clone.yaml` must be exactly `indicative` or `opra`, lower
case: anything else is refused before it is sent and the clone runs with no chains
(`tests/unit/test_feed_call_shapes.py` fails on a committed value outside `wt.data.feeds.OPTION_FEEDS`).

Per Alpaca's documentation, not verified by a call here: on Algo Trader Plus, SIP is not refused for the last 15
minutes. The routine's `HybridFeed` still cuts at 16 minutes by the clock. Its fallback to IEX on a SIP 403 would not
fire while such a plan lasts, and would again after a lapse.

## Keys, by name and location

Values never go in a file in the repo, a log, an issue or a chat. For rotation see `secret-rotation.md`.

| Where | Names | Who reads them | Precedence |
|---|---|---|---|
| Vercel (production only) | `ALPACA_API_KEY_ID` / `ALPACA_API_SECRET_KEY`, or `APCA_API_KEY_ID` / `APCA_API_SECRET_KEY`; `ALPACA_FEED`; `ALPACA_DATA_URL` | the site's quote, bars, chain and contract routes, the entitlement probe and the desk cron | the `ALPACA_` pair first, then the `APCA_API_` pair |
| Host: `/run/wt-secrets/env` (tmpfs, written by `wt-fetch-secrets` / `wt-set-secrets`, systemd `EnvironmentFile`, also named by `WT_ENV_FILE`) | `APCA_API_KEY_ID` / `APCA_API_SECRET_KEY` (required); `APCA_OPTIONS_KEY_ID` / `APCA_OPTIONS_SECRET_KEY`; `APCA_CLONE_KEY_ID` / `APCA_CLONE_SECRET_KEY` | `APCA_API_`: runner B, routine, forward test, pipeline check, deploy gate. `APCA_OPTIONS_`: options-live. The clone: `APCA_CLONE_` when both are set, else `APCA_OPTIONS_` | the job's environment (from the file) wins; `wt.core.config` then loads the checkout's `.env` and `WT_ENV_FILE`, both with `override=False` |
| A checkout's `.env` (the console Mac's `~/trading/.env`) | the same `APCA_` names | hand-run Python tools; `make feed-agreement` | a name already in the environment wins over `.env` |
| The shell (a profile's `export`) | whatever it exports | every Python tool started from that shell | wins over `.env` for Python tools; loses to the env file for `make feed-agreement` |
| Hand-run `make feed-agreement` | `ALPACA_API_` or `APCA_API_` pair | the feed agreement | the env file's pair (`ENV_FILE`, default `.env`) wins over the shell's; it prints which source it used |

Warnings:

- **A paper-account reset revokes the key pair.** Every consumer that shares the pair stops at once with 401: the
  host's jobs, the site if it holds the same pair, and hand-run tools. Regenerate the pair, then update every
  location above that holds it.
- **An exported shell variable overrides `.env` for Python tools.** `load_dotenv` never replaces a name that is
  already set, even to an empty string. `make keys-check` shows which pair a Python tool will use, without showing a
  value.
- **An omitted feed follows the subscription.** The guards above stop new omissions in this repo. A request from
  outside it (a cloud routine, a notebook) is not covered.

## `make keys-check`

Offline and read only. For each pair above it reports:

- whether the shell sets the names;
- whether `.env` (and `WT_ENV_FILE`, when set) defines them, or is missing, not a regular file, or cannot be read;
- whether the definitions are the same or different;
- which one a Python tool will use ("the shell's pair differs from .env's: Python tools will use the shell's").

A file that cannot be read is one a Python tool would fail on, and the report says so. The check prints no value, no
part and no hash of a value, makes no network call and always exits 0. `make keys-check KEYS_ENV_FILE=<path>` shows
another file for comparison. The tools in a checkout still load that checkout's own `.env`.

## Request budget

Per Alpaca's documentation, not verified by a call here: the market-data limit is 200 calls a minute on the free
(Basic) plan and 10,000 on Algo Trader Plus. Every data answer carries `X-RateLimit-Limit`. The feed agreement
records it and stops when SIP's is under 1000. Each page of a paged answer is one call. Counts are from the code as
of 2026-11-12, assuming each answer fits on one page.

| Consumer (key pair) | Rhythm | Data calls per rhythm | Calls per minute | Worst case |
|---|---|---|---|---|
| Runner B (`APCA_API_`) | one poll every 20 s (`poll_s=20.0`), 09:30 to the close | bars 1 + trade quote 1 + signal quote 1 when a signal is on the newest bar | 3 polls x 3 = **9** | at arm (about 08:30 New York), 14 sigma reads once (one of its two branches, never both); its own limiter caps it at 150/min |
| Routine (`APCA_API_`) | 4 stages before the open (08:00, 08:30, 09:00, 09:15 ET), then `1131_signals` at 11:31 | per stage: the universe's 1-minute snapshot in batches of 200 names (in hybrid mode twice, SIP then the IEX tail), pre-market bars of the kept names, news; at 11:31: the Tier-2 names' bars 09:30 to 11:31, SIP plus the IEX tail | before the open, capped at **30** (`AlpacaREST(per_minute=30, shared=True)`); at 11:31, about **2** | 30, while a stage runs; the shared file limiter also holds every shared process to 180 together |
| Forward test (`APCA_API_`) | once, after the close | bars for every candidate | capped at **150** (`per_minute=150`) | 150 (own limiter only; it does not join the shared one) |
| Pipeline check (`APCA_API_`) | 08:55 and 18:30 ET | bars (1 or more pages) + 1 snapshot; contracts go to the trading host | about 2 to 3 a run | bars pages up to 30, inside a 540 s budget |
| Options clone (`APCA_CLONE_` or `APCA_OPTIONS_`) | one step every 10 s (`feeds.poll_s: 10`) | minute bars 1 + position quote 1 + shadow-arm quotes 1 | 6 steps x 3 = **18** | plus a chain read (up to 12 pages) per name with a signal; no limiter |
| Paper positions (`APCA_OPTIONS_`) | every 5 minutes in the US session; every 15 minutes otherwise | daily bars 1 + 30-minute bars 1 (rules) + 30-minute bars 1 (hourly); closes 1 every 6 h | in the session 3 / 5 = **0.6**; otherwise 3 / 15 = **0.2** | bars up to 12 pages each |
| Site, live prices (site's pair) | each open page every 2 s (`POLL_MS`); 1.5 s cache per name per instance | 1 call for all due names | 60 / 2 = **30 per open page** | N pages on N instances: 30 x N |
| Site, session bars | each open page every 30 s; 10 s cache | 1 call (pages up to 20) | **2 per open page** | 40 per page if every answer pages to 20 |
| Site, chain | each viewed name every 30 s; 20 s cache | 2 calls (3 with a held contract), up to 3 pages each | **4 to 6 per name** | 9 pages x 2 = 18 per name |
| Site, contract quotes (`/api/contract`) | while a manage card holds a contract the journal names, or a ticket names a listed strike and expiry, every 2 s while visible; nothing while hidden; 3 s cache per contract per instance | 1 call (option snapshots of the due contracts, up to 20, one page) | **15 per contract quoted** by one page (the 3 s cache makes every other 2 s poll a cache hit); pages on one instance asking for the same contract share it, at most 20 a minute | a card and a ticket on different contracts ask apart (30); one more call each time opra is refused (retried once on indicative, then indicative for 10 minutes) |
| Entitlement probe (site's pair) | at most once every 10 minutes per instance, when `/api/health` or the Feeds page is read (`/api/health` never waits more than 300 ms for it) | 2 calls (SIP latest quote, one OPRA snapshot); a failed answer is kept for the same 10 minutes | **0.2 per instance** | 2 per instance in any 10 minutes |
| Shadow evaluator (site's pair) | every minute, 13:00 to 21:59 UTC on weekdays | bars 1 + snapshots 1 | **2** | 21 if the bars page to 20 |
| Signal log (site's pair; `desk/signal.json` at `dry`, `log` or `show`) | once per settled slot, only in the run that wrote the slot's shadow record (about 194 a session); nothing at `off`. The switch is read only by a run that can write, not every run | flow: snapshots 1 + 2-minute bars 1 (one page for up to 6 names); chain (`fetchChain`): 2 calls per focus name (the near and the far expiries), each up to 3 pages (`MAX_PAGES`), plus a third call of up to 3 pages for a name with a followed contract (`log` only). `dry` and `log` read the same: every focus name's chain every slot, since Amendment 1 counts the contract check on every focus-name slot whatever the board's state (DEC-0051 section 2). With 4 focus names and one page each: 2 + 8 = 10 a slot | **5** (10 in the minute a slot is worked out) | about 20 with 4 names when some answers page; the true upper bound is 1 + 20 bars pages (`MAX_BAR_PAGES`) + 4 x 3 calls x 3 pages = 57 in one run, inside the step's own 5 s budget |
| Feed agreement (hand) | once after a session | 2 feeds x pages | capped at **180** (`ALPACA_CALLS_PER_MIN`) | 180 |
| Selection fetch (`APCA_API_`; no job runs it yet) | Stage 1 once after the close; Stage 2 Pass A from 08:51 and Pass B from 09:21 ET (T + 60 s) | Stage 1: 1 (daily bars, one page). Each Stage 2 pass: 26 (daily 1, 1-minute 1, pre-market 5-minute 21, snapshots 1, corporate actions 1, news 1) plus 1 per further page | **26** in the minute a pass runs; it joins the shared limiter (`AlpacaREST(shared=True)`) | a pass stops at 100 requests (Stage 1 at 20), each retry counted (a 429 after its `Retry-After` or `X-RateLimit-Reset`; a 5xx or a timeout once); Stage 2 stops 60 s before the pass's publish-by time (08:55, 09:24), Stage 1 after 540 s. A Stage 2 fetch that stops early still saves its bundle, marked incomplete. Corporate actions are asked for by process date, 10 days before to 5 days after the session |
| Feed comparison sampler (site's pair) | every minute in the regular session, 13:00 to 21:59 UTC on weekdays (`* 13-21 * * 1-5`), runs only from the open to the close | snapshots 1 on iex + snapshots 1 on sip, never cached, never paged; a 400 is asked once more on that feed | **2** (4 at most) | 2 (one run a minute; a second run in the same minute finds the sample and asks nothing) |
| Feeds page live book (site's pair, `/api/feeds/live`) | while a signed-in Feeds page is open and visible, every 5 s; nothing while hidden | snapshots 1 + 2-minute bars 1 on the board's feed (`ALPACA_FEED`), cached 5 s per instance and name set with one read in flight; bars only after the open, at most 4 pages | **24** | 24 per instance whatever the number of tabs (60 at most if bars page) |
| Feed comparison report (site's pair) | once a day after close + 20 min (`*/10 20-23 * * 1-5`; later ticks find the report and ask nothing) | 4 reads, N pages each: 2-minute bars per feed, N = 1 (about 4 names x 195 bars = about 800, under `limit=10000`); 1-minute bars per feed, N = 1 (about 4 names x 390 bars = about 1,560, under `limit=10000`; a card of up to 25 names fits in one page) | 4 calls in that one minute, about **0** a minute over the day | 80 (20 pages x 4 reads, `MAX_PAGES`), all under one shared 180-a-minute limiter and one 150 s budget; a build that may heal retries at the next 10-minute tick, until 23:50 UTC |
| Site, flow (site's pair, `/api/flow`) | each open, visible Options page (the market bar, SPY and QQQ): every 5 s in the regular session (`FLOW_POLL_MS`); outside it every 5 minutes, or at the next 09:30 New York open if sooner (`flowPollMs`); nothing while hidden; 3 s cache per instance and set of names, one read in flight per set | in the session: snapshots 1 + 2-minute bars 1 (2 names x up to 195 bars, under `limit=10000`: 1 page); outside the session: snapshots 1 only (no bars call before the open, from the close or off session days); the baseline comes from the store | in the session 12 requests a minute per open page, each reading upstream (the 3 s cache is shorter than the 5 s poll): **24 per open page**; outside it 1 / 5 = **0.2 per open page** (pages polling in step on one instance share a read) | 21 per request (252 a minute per page) in the session if every bars answer paged to `MAX_BAR_PAGES` (20); after failures it waits 2 s doubling to 30 s, and 30 s at once after a 429 |
| Flow baseline (site's pair, `/api/cron/flow-baseline`) | every 10 minutes 11:00 to 13:50 UTC on weekdays (`*/10 11-13 * * 1-5`); the run idles from 09:30 New York and off session days, and once the day's baseline is stored a tick asks nothing (one head) | one 2-minute bars read per session for the previous 20 full sessions, each about 1,170 bars: 20 calls, 4 at a time, in one run | **20** once a day, in the first tick that finds today's edition; 0 otherwise | 400 (20 pages x 20 sessions, `MAX_PAGES`), cut by the run's 40 s budget; a partial run writes nothing and the next tick asks again: up to 18 ticks a day on EST, 15 on EDT |

Arithmetic for the host's stocks pair (`APCA_API_`):

- 08:00 to 09:30: the routine at most 30 a minute; at about 08:30 runner B arms and reads 14 sigma calls once; at
  08:55 the pipeline check makes 2 or 3. Peak about 44 (30 + 14) in the minute runner B arms, 33 at 08:55.
  Once the selection's fetch is scheduled, it adds about 26 in the minute after 08:51 and again after 09:21 (59 at
  08:55 if a Pass A fetch ran into that minute with the routine and the pipeline check), still under both limits.
- 09:30 to the close: runner B, 9 a minute, plus about 2 from the routine at 11:31. Peak 11.
- After the close: the forward test, up to 150 a minute, plus the 18:30 pipeline check's few calls.

All of these fit under the free plan's 200 as well as Algo Trader Plus's 10,000.

The clone's pair: 18 + 0.6, so about 19 a minute, plus chain reads on a signal.

The site's pair: one open Options page costs 30 + 2 + 6 + 24 (the market bar's `/api/flow`, in the session) = 62 (77 with a
held contract's live quote, 92 with a ticket's on another contract too; the manage card shares the name's chain feed, so
it adds no chain calls), plus the evaluator's 2 and the feed comparison sampler's 2, so 66 a minute; with the signal log on (`dry`, `log` or
`show`), 10 more in the minute a slot is worked out, so 76. Three pages on separate instances would cost
3 x 62 + 2 + 2 = 190 (200 with the signal log's 10), at the free plan's 200; SIP and OPRA need Algo Trader Plus
(10,000) anyway. The comparison report adds 4 calls once a day after the close (80 pages at worst, plus 429 retries, all under its own 180-a-minute limiter), when no page polls in the session.
The flow baseline's bars are split-adjusted (`adjustment=split`): a split inside the 20 sessions would otherwise leave the
older volumes in pre-split shares, not comparable with today's raw bars. The baseline records the names it was built
for (`built_for`); a name added to the focus list after the build has no baseline that day, and its relative volume
answers `no-baseline`. The flow baseline adds about 20 calls once a day before the open, when nothing else on the site's pair is busy. `/api/flow`
is polled by the Options page's market bar for SPY and QQQ: every 5 s in the session, 24 a minute per open page (40 at
most per instance and set of names, whatever asks); outside the session every 5 minutes with no bars call, 0.2 a minute.
That pair is shared with whatever else uses it.

## After a plan change or a lapse

1. Read `X-RateLimit-Limit` from a feed-agreement report (`var/feed-agreement/`), or run one: 10,000 means Algo
   Trader Plus, 200 the free plan (per Alpaca's documentation).
2. On a lapse, SIP for the last 15 minutes is refused again (403, per Alpaca's documentation):
   - The site shows live prices as off while `ALPACA_FEED=sip`; the owner sets it back to `iex` or unsets it.
   - The routine falls back to IEX for a whole window on a SIP 403 by itself.
   - The feed agreement stops with `sip not entitled` or `sip plan`.
3. Confirm `ALPACA_FEED` on the site (unset or `iex`).
4. Confirm that the clone's opra switch file `var/options/switches/opra` is absent on the host (OPRA needs the options
   subscription). Record the date of this check and of step 3 in the table below.
5. Run `make keys-check` on the Mac, and `sudo -u wt /usr/local/bin/wt-deploy gate` on the host, which reads Alpaca's
   calendar with the host's pair.
6. A change of feed for any consumer bound by a record above is the owner's decision. It needs a dated decision
   record before it takes effect.

| Checked on | `ALPACA_FEED` on the site | `var/options/switches/opra` on the host | By |
|---|---|---|---|
| (not yet checked) | | | |
