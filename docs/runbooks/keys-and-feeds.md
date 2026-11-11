# Keys and feeds

You'll need this page when the Alpaca data plan changes or lapses, when a tool answers HTTP 401, when the Options page
says "Live off: ... not on the data plan", or before a change that adds a market-data request.

## Why every request names its feed

When a market-data request leaves `feed` out, Alpaca picks "the best one the subscription allows": IEX on the free
plan, SIP (the consolidated tape) on Algo Trader Plus, and IEX again if the subscription lapses. A request without a
feed changes its data source with the plan, with no code change and no record. So every request here names its feed,
and two tests fail on one that does not:

- Python: `wt.data.feeds.require_feed`, called by `AlpacaREST.get` before anything is sent, and
  `tests/unit/test_feed_named.py`, which scans `src/`, `scripts/` and `deploy/` (the runners and `wt.options` call
  Alpaca with their own HTTP session, so the scan is their guard) and every use of an alpaca-py data request class
  (the SDK leaves `feed=None` out of the query: `self.model_dump(exclude_none=True)` in `NonEmptyRequest`).
- Dashboard: every data URL is built by `alpacaDataUrl` (`dashboard/src/lib/alpaca-data-url.ts`), which throws
  without a feed, and `dashboard/test/alpaca-data-url.test.ts` fails on a data path written anywhere else.

Both tests carry a list of known exceptions (requests awaiting the owner's decision). Both lists are empty: the
inventory below found none.

## Inventory (2026-11-12)

Every place the repo asks Alpaca for market data. "Host" is a scheduled job on the cloud host; "site" is the dashboard
on Vercel; "hand" is run by hand. No module uses the alpaca-py data clients or streams; the SDK is used only for
the trading API (`TradingClient`).

| Consumer | What it reads | Feed | Where the feed is set | Record that binds it |
|---|---|---|---|---|
| Owner's board, live prices (site, `/api/quote`) | stock snapshots | iex | `ALPACA_FEED` on Vercel, `iex` when unset (`alpaca-feed.ts`) | DEC-0042 (states from IEX), feed-agreement runbook (stays on IEX until the owner decides) |
| Owner's board, session bars (site, `/api/bars`) | 2-minute stock bars | iex | the same `ALPACA_FEED` | DEC-0042, DEC-0044 (the server reads the same bars) |
| Shadow evaluator (site, `/api/cron/desk`, every minute in the session) | 2-minute bars and snapshots | iex | the same `ALPACA_FEED` | DEC-0044; EXP-0031 labels from settled IEX bars |
| Contract pane and chain (site, `/api/chain`) | option snapshots | indicative | literal in `chain.ts` | none (display; 15 minutes behind) |
| Feed agreement (hand, `make feed-agreement`) | 2-minute stock bars | iex and sip, both | literal per run (`barsUrl`) | feed-agreement runbook |
| Paper runner B (host, `paper-b`) | 1-minute bars and latest quotes of the signal and trade names | iex | literals in `runner_b.py` | DEC-0037 (the runner reads IEX minute bars) |
| Paper runner B, sigma (host) | 1-minute bars of the 14 prior sessions | sip | literal | the backtest's definition (SIP history) |
| Options clone, stock bars (host, `paper-o`) | 1-minute bars of its names and SPY | iex | literal in `runner_o.py` | DEC-0031 (the clone reads IEX) |
| Options clone, levels (host) | daily bars | sip | literal | DEC-0033 (the edition's levels; the tape's when there is no edition for today) |
| Options clone, option quotes and chains (host) | option snapshots | indicative, or opra | `feeds.option` in `config/options_clone.yaml`; the file `var/options/switches/opra` selects opra | DEC-0030 section 4 |
| Paper positions (host, `options-live`) | stock snapshots (last close) | iex | literal in `options/live.py` | none (display) |
| Paper positions, rules and hourly blocks (host) | daily and 30-minute bars | sip | literal | EXP-0023 (consolidated tape) |
| Pipeline check (host, twice a day) | daily bars; snapshots | sip; iex | literals in `pipeline_check.py` | none (a check) |
| Pre-market routine (host, `routine`) | 1-minute bars | hybrid: sip up to 16 minutes ago, iex after | `HybridFeed` names both; `--feed` overrides | DEC-0023 (the last 15 minutes from IEX) |
| Forward test (host, `forward`) | daily and 1-minute bars | sip | `AlpacaREST.bars` default argument `feed="sip"` | DEC-0009 (delayed SIP data) |
| Research scripts (hand: `build_pool`, `scan`, `r2_`, `r3_`, `g1_`, `exp*`, `options_replication`, `options_clone_dry_run`) | bars, quotes, trades | sip | literal, or the `bars` default | each experiment's own record |
| News (`AlpacaREST.news`), option bars (`options_clone_dry_run`) | news; historical option bars | none: these endpoints take no feed | - | - |

None of these changed source when the plan changed: every request names its feed. Two settings outside the code
decide a feed and should be read after any plan change: `ALPACA_FEED` on Vercel (unset or `iex` keeps the board on
IEX) and whether `var/options/switches/opra` exists on the host (it switches the clone's option quotes to OPRA).

What the paid plan did change, though no feed did: SIP is no longer refused for the last 15 minutes. The routine's
`HybridFeed` still cuts at 16 minutes by the clock (so DEC-0023's "last 15 minutes from IEX" still holds), and its
fallback to IEX on a SIP 403 will no longer fire while the plan lasts; after a lapse it fires again.

## Keys, by name and location

Values never appear in a file in the repo, a log, an issue or a chat. Rotation: `secret-rotation.md`.

| Where | Names | Who reads them | Precedence |
|---|---|---|---|
| Vercel (production only) | `ALPACA_API_KEY_ID` / `ALPACA_API_SECRET_KEY`, or `APCA_API_KEY_ID` / `APCA_API_SECRET_KEY`; `ALPACA_FEED`; `ALPACA_DATA_URL` | the site's quote, bars and chain routes and the desk cron | the `ALPACA_` pair first, then the `APCA_API_` pair |
| Host: `/run/wt-secrets/env` (tmpfs, written by `wt-fetch-secrets` / `wt-set-secrets`, systemd `EnvironmentFile`, also named by `WT_ENV_FILE`) | `APCA_API_KEY_ID` / `APCA_API_SECRET_KEY` (required); `APCA_OPTIONS_KEY_ID` / `APCA_OPTIONS_SECRET_KEY`; `APCA_CLONE_KEY_ID` / `APCA_CLONE_SECRET_KEY` | `APCA_API_`: runner B, routine, forward test, pipeline check, deploy gate. `APCA_OPTIONS_`: options-live. Clone: `APCA_CLONE_` when both are set, else `APCA_OPTIONS_` | the job's environment (the file) wins; `wt.core.config` loads the checkout's `.env`, then `WT_ENV_FILE`, both with `override=False` |
| Mac: `~/trading/.env` | the same `APCA_` names | hand-run Python tools; `make feed-agreement` | a name already exported by the shell wins over `.env` |
| Mac: the shell profile | whatever it exports | every hand-run Python tool started from that shell | wins over `.env` for Python; loses to the env file for `make feed-agreement` |
| Hand-run `make feed-agreement` | `ALPACA_API_` or `APCA_API_` pair | the feed agreement | the env file's pair (`ENV_FILE`, default `.env`) wins over the shell's; it prints which source it used |

Warnings:

- **A paper-account reset revokes the key pair**, and every consumer that shares the pair stops at once with 401:
  the host's jobs, the site (if it holds the same pair) and hand-run tools. Regenerate, then update every location
  above that holds that pair.
- **An exported shell variable overrides `.env` for Python tools.** `load_dotenv` never replaces a name that is already
  set, even when it is set to an empty string. On the console Mac the shell exports a pair that differs from `.env`'s,
  which made a hand-run tool fail with 401. `make keys-check` shows this without showing a value.
- **An omitted feed follows the subscription.** The guards above stop new ones; a request outside this repo (a cloud
  routine, a notebook) is not covered.

## `make keys-check`

Offline and read only. It reports, for each pair above, whether the shell sets the names, whether `.env` (and
`WT_ENV_FILE`, when set) defines them, whether the definitions are the same or different, and which one a Python tool
will use ("the shell's pair differs from .env's: Python tools will use the shell's"). It prints no value, no part and
no hash of a value, makes no network call and always exits 0. `make keys-check KEYS_ENV_FILE=<path>` compares with
another file (for example `~/trading/.env` from a worktree).

## Request budget

Alpaca's market-data limit is per account: 200 calls a minute on the free (Basic) plan and 10,000 on Algo Trader Plus,
as Alpaca publishes them. Every data answer carries `X-RateLimit-Limit`; the feed agreement records it, and stops when
SIP's is under 1000. Not verified in this item by any call. Each page of a paged answer is a call. Counts below are
from the code at the settings in force on 2026-11-12, typical answers fitting one page.

| Consumer (key pair) | Rhythm | Calls per rhythm | Calls per minute | Worst case |
|---|---|---|---|---|
| Runner B (`APCA_API_`) | one poll every 20 s (`poll_s=20.0`) | bars 1 + trade quote 1 + signal quote 1 when a signal is on | 3 polls x 3 = **9** | arm: 2 x 14 sigma reads = 28 calls once; its own limiter caps it at 150/min |
| Routine (`APCA_API_`) | 3 stages before the open | universe snapshot in batches of 200 names, pages, news | capped at **30** (`AlpacaREST(per_minute=30, shared=True)`) | 30; the shared file limiter also holds every shared process to 180 together |
| Forward test (`APCA_API_`) | once, after the close | bars for every candidate | capped at **150** (`per_minute=150`) | 150, own limiter only (it does not join the shared one) |
| Pipeline check (`APCA_API_`) | 08:55 and 18:30 ET | bars (1+ pages), 1 snapshot, contracts per name (trading host) | about 3 data calls a run | bars pages up to 30, inside a 540 s budget |
| Options clone (`APCA_CLONE_` or `APCA_OPTIONS_`) | one step every 10 s (`feeds.poll_s: 10`) | minute bars 1 + position quote 1 + shadow-arm quotes 1 | 6 steps x 3 = **18** | plus a chain read (up to 12 pages) per name with a signal; no limiter |
| Paper positions (`APCA_OPTIONS_`) | every 5 minutes in the session | closes 1 + daily bars 1 + 30-minute bars 2 | 4 / 5 = **under 1** | bars up to 12 pages each; contracts every 6 h (trading host) |
| Site, live prices (site's pair) | each open page every 2 s (`POLL_MS`); 1.5 s cache per name per instance | 1 call for all due names | 60 / 2 = **30 per open page** | N pages on N instances: 30 x N |
| Site, session bars | each open page every 30 s; 10 s cache | 1 call (pages up to 20) | **2 per open page** | 40 per page if every answer pages to 20 |
| Site, chain | each viewed name every 30 s; 20 s cache | 2 calls (3 with a held contract), up to 3 pages each | **4 to 6 per name** | 9 pages x 2 = 18 per name |
| Shadow evaluator | every minute, 13:00 to 21:59 UTC on weekdays | bars 1 + snapshots 1 | **2** | 21 if the bars page to 20 |
| Feed agreement (hand) | once after a session | 2 feeds x pages | capped at **180** (`ALPACA_CALLS_PER_MIN`) | 180 |

Arithmetic for the host's stocks pair during the session: runner B 9 + pipeline check (not in the session) 0 = 9 a
minute; before the open the routine adds at most 30, so at most 39 before 09:30 and 9 after; the forward test runs
after the close and alone can reach 150. That fits the free plan's 200 and leaves Algo Trader Plus's 10,000 almost
untouched. The clone's pair: 18 + under 1 = about 19 a minute, plus chain reads on a signal. The site: one open
Options page is 30 + 2 + 6 + 2 (the cron) = 40 a minute; four pages on separate instances would be about 150, which
the free plan's 200 would allow only just, and which the site shares with whatever else uses its pair.

## After a plan change or a lapse

1. Read `X-RateLimit-Limit` from a feed-agreement report (`var/feed-agreement/`), or run one: 10,000 is Algo Trader
   Plus, 200 is the free plan.
2. On a lapse: SIP for the last 15 minutes is refused again (403). The site answers "not on the data plan" while
   `ALPACA_FEED=sip`; set it back to `iex` or unset it (owner). The routine falls back to IEX for a whole window on a
   SIP 403 by itself. The feed agreement stops with `sip not entitled` or `sip plan`.
3. Check the two settings that choose a feed outside the code: `ALPACA_FEED` on Vercel, and
   `var/options/switches/opra` on the host (OPRA needs the options subscription; without it the clone's quotes fail
   and `feed-unfit` follows).
4. Run `make keys-check` on the Mac, and `sudo -u wt /usr/local/bin/wt-deploy gate` on the host (it reads Alpaca's
   calendar with the host's pair).
5. A change of feed for any consumer bound by a record above is the owner's decision, with a dated decision record
   before it takes effect.
