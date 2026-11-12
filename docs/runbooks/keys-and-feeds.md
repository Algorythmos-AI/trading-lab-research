# Keys and feeds

You'll need this page when the Alpaca data plan changes or lapses, when a tool answers HTTP 401, when the Options page
says live prices are off because of the data plan, or before a change that adds a market-data request.

## Why every request names its feed

Per Alpaca's documentation (not verified by a call here), a market-data request that leaves `feed` out gets "the best
one the subscription allows": IEX on the free plan, SIP (the consolidated tape) on Algo Trader Plus, and IEX again if
the subscription lapses. A request without a feed would change its data source with the plan, with no code change and
no record. So every request here names its feed, and these guards fail on one that does not:

- Python, at run time: `wt.data.feeds.require_feed`, called by `AlpacaREST.get` before anything is sent.
- Python, in the tests: `tests/unit/test_feed_named.py` (the scan is `tests/unit/feed_scan.py`) checks every request
  call in `src/`, `scripts/` and `deploy/`, and every use of an alpaca-py data request class (the SDK leaves
  `feed=None` out of the query: `self.model_dump(exclude_none=True)` in `NonEmptyRequest`).
- `wt.live.runner_o`, `wt.options.live` and `wt.options.pipeline_check` use their own HTTP session: for now they are
  covered by the scan only, not by `require_feed`.
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
| Owner's board, live prices (site, `/api/quote`) | stock snapshots | `ALPACA_FEED`, default iex (check the site's setting) | `ALPACA_FEED` on Vercel (`alpaca-feed.ts`) | DEC-0042 | feed-agreement runbook |
| Owner's board, session bars (site, `/api/bars`) | 2-minute stock bars | `ALPACA_FEED`, default iex (check the site's setting) | the same | none | DEC-0044 (the same bars as the page; it names no feed), feed-agreement runbook |
| Shadow evaluator (site, `/api/cron/desk`) | 2-minute bars and snapshots | `ALPACA_FEED`, default iex (check the site's setting) | the same | none | DEC-0044 (names no feed), EXP-0031, feed-agreement runbook |
| Contract pane and chain (site, `/api/chain`) | option snapshots | indicative | literal in `chain.ts` | none | none |
| Feed agreement (hand, `make feed-agreement`) | 2-minute stock bars | iex and sip | literal per run (`barsUrl`) | none | feed-agreement runbook |
| Paper runner B, signal bars (host, `paper-b`) | 1-minute bars | iex | literal default in `runner_b.py` | DEC-0037 | none |
| Paper runner B, latest quotes (host) | latest quote of the signal and trade names | iex | literal | none | DEC-0024 |
| Paper runner B, sigma (host) | 1-minute bars of the 14 prior sessions | sip | literal | none | none (set in code) |
| Options clone, stock minute bars (host, `paper-o`) | 1-minute bars of its names and SPY | iex | literal in `runner_o.py` | set in code, no record binds it | DEC-0031 |
| Options clone, levels (host) | daily bars | sip | literal | none | DEC-0033 |
| Options clone, option quotes and chains (host) | option snapshots | indicative, or opra | `feeds.option` in `config/options_clone.yaml`; the file `var/options/switches/opra` selects opra | DEC-0030 section 4 | none |
| Paper positions (host, `options-live`) | stock snapshots (last close) | iex | literal in `options/live.py` | none | none |
| Paper positions, rules and hourly blocks (host) | daily and 30-minute bars | sip | literal | none | EXP-0023 |
| Pipeline check (host) | daily bars; snapshots | sip; iex | literals in `pipeline_check.py` | none | none |
| Pre-market routine (host, `routine`) | 1-minute bars, news | hybrid: sip to 16 minutes ago, iex after | `HybridFeed` names both; `--feed` overrides | DEC-0023 | none |
| Forward test (host, `forward`) | daily and 1-minute bars | sip | `AlpacaREST.bars` default argument `feed="sip"` | DEC-0009 | none |
| Research scripts (hand: `build_pool`, `scan`, `r2_`, `r3_`, `g1_`, `exp*`, `options_replication`, `options_clone_dry_run`) | bars, quotes, trades | sip | literal, or the `bars` default | not reviewed per script here | - |
| News (`AlpacaREST.news`), option bars (`options_clone_dry_run`) | news; historical option bars | none: these endpoints take no feed | - | - | - |

Every request names its feed, so none of them changed source when the plan changed. Two settings outside the code
choose a feed. Check them after any plan change: `ALPACA_FEED` on Vercel (unset or `iex` keeps the board, its bars
and the evaluator on IEX), and whether `var/options/switches/opra` exists on the host (it switches the clone's option
quotes to OPRA).

Per Alpaca's documentation, not verified by a call here: on Algo Trader Plus, SIP is not refused for the last 15
minutes. The routine's `HybridFeed` still cuts at 16 minutes by the clock. Its fallback to IEX on a SIP 403 would not
fire while such a plan lasts, and would again after a lapse.

## Keys, by name and location

Values never go in a file in the repo, a log, an issue or a chat. For rotation see `secret-rotation.md`.

| Where | Names | Who reads them | Precedence |
|---|---|---|---|
| Vercel (production only) | `ALPACA_API_KEY_ID` / `ALPACA_API_SECRET_KEY`, or `APCA_API_KEY_ID` / `APCA_API_SECRET_KEY`; `ALPACA_FEED`; `ALPACA_DATA_URL` | the site's quote, bars and chain routes and the desk cron | the `ALPACA_` pair first, then the `APCA_API_` pair |
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
| Runner B (`APCA_API_`) | one poll every 20 s (`poll_s=20.0`), 09:30 to the close | bars 1 + trade quote 1 + signal quote 1 when a signal is on the newest bar | 3 polls x 3 = **9** | at arm, 2 x 14 sigma reads = 28 calls once; its own limiter caps it at 150/min |
| Routine (`APCA_API_`) | 4 stages before the open (08:00, 08:30, 09:00, 09:15 ET), then `1131_signals` at 11:31 | per stage: the universe's 1-minute snapshot in batches of 200 names (in hybrid mode twice, SIP then the IEX tail), pre-market bars of the kept names, news; at 11:31: the Tier-2 names' bars 09:30 to 11:31, SIP plus the IEX tail | before the open, capped at **30** (`AlpacaREST(per_minute=30, shared=True)`); at 11:31, about **2** | 30, while a stage runs; the shared file limiter also holds every shared process to 180 together |
| Forward test (`APCA_API_`) | once, after the close | bars for every candidate | capped at **150** (`per_minute=150`) | 150 (own limiter only; it does not join the shared one) |
| Pipeline check (`APCA_API_`) | 08:55 and 18:30 ET | bars (1 or more pages) + 1 snapshot; contracts go to the trading host | about 2 to 3 a run | bars pages up to 30, inside a 540 s budget |
| Options clone (`APCA_CLONE_` or `APCA_OPTIONS_`) | one step every 10 s (`feeds.poll_s: 10`) | minute bars 1 + position quote 1 + shadow-arm quotes 1 | 6 steps x 3 = **18** | plus a chain read (up to 12 pages) per name with a signal; no limiter |
| Paper positions (`APCA_OPTIONS_`) | every 5 minutes in the US session; every 15 minutes otherwise | daily bars 1 + 30-minute bars 1 (rules) + 30-minute bars 1 (hourly); closes 1 every 6 h | in the session 3 / 5 = **0.6**; otherwise 3 / 15 = **0.2** | bars up to 12 pages each |
| Site, live prices (site's pair) | each open page every 2 s (`POLL_MS`); 1.5 s cache per name per instance | 1 call for all due names | 60 / 2 = **30 per open page** | N pages on N instances: 30 x N |
| Site, session bars | each open page every 30 s; 10 s cache | 1 call (pages up to 20) | **2 per open page** | 40 per page if every answer pages to 20 |
| Site, chain | each viewed name every 30 s; 20 s cache | 2 calls (3 with a held contract), up to 3 pages each | **4 to 6 per name** | 9 pages x 2 = 18 per name |
| Shadow evaluator (site's pair) | every minute, 13:00 to 21:59 UTC on weekdays | bars 1 + snapshots 1 | **2** | 21 if the bars page to 20 |
| Feed agreement (hand) | once after a session | 2 feeds x pages | capped at **180** (`ALPACA_CALLS_PER_MIN`) | 180 |

Arithmetic for the host's stocks pair (`APCA_API_`):

- 08:00 to 09:30: the routine at most 30 a minute, plus the pipeline check's 2 or 3 calls at 08:55. Peak 33.
- 09:30 to the close: runner B, 9 a minute, plus about 2 from the routine at 11:31. Peak 11.
- After the close: the forward test alone, up to 150.

All of these fit under the free plan's 200 as well as Algo Trader Plus's 10,000.

The clone's pair: 18 + 0.6, so about 19 a minute, plus chain reads on a signal.

The site's pair: one open Options page costs 30 + 2 + 6 = 38, plus the evaluator's 2, so 40 a minute. Four pages on
separate instances would cost 4 x 38 + 2 = 154, near the free plan's 200. That pair is shared with whatever else uses
it.

## After a plan change or a lapse

1. Read `X-RateLimit-Limit` from a feed-agreement report (`var/feed-agreement/`), or run one: 10,000 means Algo
   Trader Plus, 200 the free plan (per Alpaca's documentation).
2. On a lapse, SIP for the last 15 minutes is refused again (403, per Alpaca's documentation):
   - The site shows live prices as off while `ALPACA_FEED=sip`; the owner sets it back to `iex` or unsets it.
   - The routine falls back to IEX for a whole window on a SIP 403 by itself.
   - The feed agreement stops with `sip not entitled` or `sip plan`.
3. Confirm `ALPACA_FEED` on the site (unset or `iex`).
4. Confirm that the clone's opra switch file `var/options/switches/opra` is absent on the host (OPRA needs the options
   subscription). Record the date of this check and of step 3 below.
5. Run `make keys-check` on the Mac, and `sudo -u wt /usr/local/bin/wt-deploy gate` on the host, which reads Alpaca's
   calendar with the host's pair.
6. A change of feed for any consumer bound by a record above is the owner's decision. It needs a dated decision
   record before it takes effect.

| Checked on | `ALPACA_FEED` on the site | `var/options/switches/opra` on the host | By |
|---|---|---|---|
| (not yet checked) | | | |
