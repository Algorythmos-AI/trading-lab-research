# Feed agreement: IEX against SIP for the Options board

The Options page's "Trade now" board reads Alpaca's IEX feed (one exchange). The owner's Alpaca plan now includes
SIP (the consolidated tape). The owner has decided that the board stays on IEX while the two feeds are compared side
by side for about five sessions, and that any switch is made by the owner with a dated decision record. This page
fixes, before any number is seen, how that comparison is made and how it is read. The tool that makes it is
`make feed-agreement` (below).

Written 2026-11-11, before any comparison was run on real data; revised the same day (revisions 1 and 2, below),
still before any real-data count existed. The thresholds below are fixed. Changing any of them needs a new dated revision
of this page, committed before the next run; runs made before it are read under the rules they were run under.

## Revisions

**Revision 1, 2026-11-11 (New York).** Made after an independent review of the first version and **before any
real-data count existed**: the one real-data attempt was refused by Alpaca (HTTP 401) before any bar was read, so no
report and no number were produced. What changed, and why:

1. **A unit where one feed lacks the slot's bar is now comparable.** The first version set such a unit aside as "not
   comparable". That hid the main way the feeds can differ: IEX has no print in a slot, the board on IEX pauses (or
   carries no state), and the board on SIP does not. A review run with IEX missing every fifth bar on a quiet day
   read 100% and "equivalent". Now each feed's word for the unit is its state word, or `none` when it carries no
   state, and the two words are compared. Only units where **both** feeds lack the slot's bar are left out.
2. **Clock-fixed and no-plan units are left out of the share.** About 36% of a full day's live units are `no_trade`
   on both feeds by the clock alone (the lunch block and the flat time), and a side with no plan is `no_trade`
   whatever the price. Counting them made agreement look higher than the prices justify. They are now counted apart.
   The 98% threshold is unchanged and applies to the price-dependent units only.
3. **The snapshot limitation is stated in both directions.** The first version said the replay only loses pauses; it
   also adds them (see "Limitations").
4. **The summary never pools engine labels.** Five sessions of the same engine label are needed for a reading.
5. Smaller: names with no bars all day are listed; the report files are written atomically; the runner refuses until
   20 minutes after the close; the exit codes for a 429 retry cap, a write failure and an unexpected failure are
   listed; `make feed-agreement-edition` no longer sources the env file as shell and validates the day first.

**Revision 2, 2026-11-11 (New York).** Also made **before any real-data count existed** (no bar had been read).

1. **The keys' source.** The earlier 401 came from a dead key pair exported by the shell; Node's `--env-file` does
   not override a variable already in the environment, so the runner used it silently. Now, when an env file is
   named and defines an Alpaca key pair, the file's pair wins over the inherited environment (for the key names
   only), and the runner prints which source it used ("keys from the env file" or "keys from the environment"),
   never a value. A 401 names that source.
2. **The plan.** The owner's plan includes real-time SIP (the consolidated tape). Every request names its feed
   explicitly (Alpaca's default silently becomes IEX without the subscription). The report records the
   `X-RateLimit-Limit` Alpaca sends on each feed's first answer, and the runner stops when SIP's is under 1000: the
   plan no longer includes real-time SIP, or the keys are the wrong ones.
3. **Drift of the history.** Bars can change after the session (late and corrected prints). The report records when
   its bars were fetched, and a recheck mode measures how many units change word when the same day is fetched again.
   The recheck never replaces a report or a summary row.

## What it is, and what it is not

- It is a **data-quality measurement**: does the board, given the same focus card, show the same state words on IEX
  bars as on SIP bars, slot by slot?
- It reads **no trade, no P&L and no outcome of any setup**. It does not look at what price did after a state, at the
  journal, at fills, or at the clone's or the paper desks' results.
- It is **not evidence that either feed gives better trades**. "Equivalent" says the board would have shown the same
  things; "different" says it would not. Neither says which is right or more profitable.
- It changes nothing the board or the server's shadow evaluator does. `ALPACA_FEED` and every other setting stay as
  they are; the runner names its two feeds itself (`iex`, `sip`) for its own reads only.
- It starts no trial and so needs no hypothesis, experiment or decision record in `research/`. The owner's switch,
  when it comes, is its own dated record.

## The engine it runs

The same evaluation the server's shadow evaluator runs once a minute (DEC-0044): `evaluateSlot` in
`dashboard/src/lib/desk-eval.ts`, which calls the board's own `boardMode` and `boardRows` (`trade-now.ts`) over
`nameState` (`trade-state.ts`), unchanged. The comparison code (`dashboard/src/lib/feed-agreement.ts`) imports those
functions; it holds no copy of any rule, and nothing in the engine imports it, so the engine's label
(`ENGINE_VERSION`, `pnpm gen:engine`) does not change. The label in force is written into every report and every
summary row.

Each session is replayed twice, slot by slot: once with that session's IEX 2-minute bars, once with its SIP 2-minute
bars. Everything else given to the evaluation is the same for both replays (see "The inputs").

## The unit

One **unit** is one (focus name, side, 2-minute slot) of the regular session where the board is live:

- the focus names are the session's edition's focus card (`focus.items`), in the card's order (`focusSymbols`);
- the sides are `call` and `put` (`SIDES`); a name's two rows come from `stateRows`, as in the server's record;
- the slots are `expectedSlots(day)`: every 2-minute bar end from 09:32 New York whose settle instant
  (end + `SERVER_SETTLE_MS`, 60 s) falls before the close (16:00, or 13:00 on a half day, from the exchange calendar
  via `sessionOf`). Slots are New York wall-clock times, so the week of a clock change needs no special case;
- each slot is evaluated **as of the settled slot, exactly as the server does**: `evaluateSlot` with
  `slot = { day, end }`, which reads the bars that ended by `end` and judges the board at `end + CLOSE_GRACE_MS`;
- only slots where the board is live (`board === "live"`, from 09:35, so from the 09:36 slot) have units. The 09:32
  and 09:34 slots have no units and are not counted anywhere below.

**Each feed's word** for a unit is the state word of its row (`no_trade`, `watch`, `get_ready`, `enter_zone`,
`plan_off`, `missed`, `paused`), or **`none`** when that feed's evaluation carries no state for it (the name is in
`degraded_names`: `bars-missing`, `bars-gap`, `snapshot-missing`; or the evaluation is not `ok`).

A unit **has a bar** on a feed when that feed holds the name's bar for the slot itself (the 2-minute bar ending at
the slot's end).

Every unit falls in exactly one of these sets, tested in this order:

1. **Clock-fixed**: the board's clock alone makes it `no_trade`, judged at `end + CLOSE_GRACE_MS` in New York, as
   `nameState` judges it: from the lunch block (`lunchBlock(halfDay)`: on a full day, `LUNCH_FROM_MIN` 11:30 to
   `LUNCH_TO_MIN` 13:00) and from the flat time (`flatMinute(halfDay)`: 15:10, or 12:10 on a half day) to the close.
   `halfDay` is `isHalfDay(edition)`, as `evaluateSlot` uses it. Counted apart; never in the share.
2. **No plan**: the side has no plan on the focus card (`focusPlan(item)[side] === null`), so the board holds it at
   `no_trade` whatever the price. Counted apart; never in the share.
3. **Both lack**: neither feed holds the slot's bar for the name. Counted apart; never in the share.
4. **Price-dependent (comparable)**: every other unit, including one where exactly one feed lacks the slot's bar.
   Such a unit counts by its two words: `paused` or `none` on the feed without the bar against `watch` on the other
   is a disagreement. How many comparable units lacked the bar on IEX only and on SIP only is reported beside the
   share as a fact.

The sizes of the excluded clock-fixed set, per name and side (fixed by the clock, whatever the data):

| Day | Live slots | Clock-fixed | Not clock-fixed |
|---|---|---|---|
| Full day | 192 (09:36 to 15:58) | 70: 45 in the lunch block (11:30 to 12:58) + 25 from the flat time (15:10 to 15:58); 36.5% | 122 |
| Half day | 102 (09:36 to 12:58) | 25 from the flat time (12:10 to 12:58); no lunch block; 24.5% | 77 |

A side with no plan adds the remaining 122 (full day) or 77 (half day) units of that side to "no plan".

## The measures

Per session:

1. **State agreement**: of the comparable units, how many carry the identical word on both feeds (`none` against
   `none` is identical). Reported as a count and a share, with the full table of (IEX word, SIP word) pairs, and the
   disagreeing units listed by name, side, slot and the two words. Beside it: the comparable units where IEX lacked
   the slot's bar, where SIP lacked it, and the counts of the clock-fixed, no-plan and both-lack units, with the
   clock-fixed units' own pair table (a pause inside a clock-fixed window shows there, outside the share).
2. **Enter-zone events on each feed**: for each name and side, in slot order over the live slots, an event is a unit
   whose word is `enter_zone` when the previous slot's word for the same name and side was not `enter_zone` (`none`
   is not `enter_zone`). The first live slot has no previous slot, so `enter_zone` there is an event. Events are found
   on each feed's own words, in every set.
3. **Matched events**: an IEX event and a SIP event for the same name and side match when their slots are at most
   one slot apart (plus or minus one slot, 2 minutes). Each event matches at most one other. Pairs are taken closest
   first (offset 0 before plus or minus 1), then earliest. The **offset** of a match is the SIP event's slot minus
   the IEX event's slot, in slots (positive: SIP later). Reported: matched count, **IEX-only** events, **SIP-only**
   events, and of the matched events the **median offset** and the **worst offset** (the largest in size), with the
   count at each offset (-1, 0, +1).
4. **Names without bars**: the focus names with no bar at all that session, per feed (`names_without_bars`). The
   report is still written: such a name's units read `none` (or `paused`) on that feed and, wherever the other feed
   has the slot's bar, count as comparable disagreements. Read it as "that feed had no prices for that name all day",
   a feed fact, not an engine fact.
5. **No state**: per feed, how many (name, live slot) evaluations carried no state, by the engine's reason, and how
   many live slots the evaluation did not answer `ok`.
6. **Bars missing per slot**: for every slot of the session, how many focus names have no bar for that slot on IEX,
   and how many on SIP; and the totals.
7. **Provenance**: when the bars were fetched (`fetched_at`), the `X-RateLimit-Limit` of each feed's first answer
   (`rate_limit`, a number, or null when Alpaca sent none) and the keys' source (`keys`: `env-file` or
   `environment`). These describe the run, not the feeds, and are not part of any reading.

A report is written for one session at a time. Its share and its unmatched events are shown, but **a single session
is never read** as equivalent or different.

## The reading (fixed)

The summary reads the latest run of each session day, and **never pools sessions with different engine labels**. It
reads the label of the most recent session, over the sessions run under that label:

- with **at least 5 sessions of that label**, pooled, the feeds are **"equivalent for the board"** when **at least
  98% of the comparable (price-dependent) units match** (identical comparable units x 100 >= 98 x comparable units,
  so exactly 98.000% passes and one identical unit fewer does not) **and every enter-zone event on either feed has a
  match within one slot** (IEX-only + SIP-only = 0);
- otherwise, with at least 5 such sessions, they are **"different"**. Zero comparable units reads "different":
  agreement cannot be shown;
- with fewer than 5 sessions of that label the summary says **"not enough sessions"**, or **"not enough sessions
  (labels differ)"** when sessions under other labels exist (they are listed per label, never added in).

The clock-fixed, no-plan and both-lack counts, the IEX-lacks and SIP-lacks counts, the names without bars and the
bars-missing counts are shown beside the reading and are not part of it.

What follows:

- **Either way, the switch is the owner's decision**, recorded with its date. This comparison does not make it.
- **"Equivalent for the board"**: the board's states and labels before and after a switch on that date may be read
  as one series, with the switch date marked.
- **"Different"**: states and labels from before a switch and after it **must not be pooled**: the switch starts a
  new series, and anything counted from the board's states (alert counts, shadow-record agreement, labels) is counted
  on each side of the date separately.

## The inputs, and the neutral choices

The server's evaluation (`runDeskEval` in `desk-run.ts`) gives `evaluateSlot` more than bars. A replay after the
session cannot read those the way the live run did, so each is given a fixed, neutral value, **the same for both
feeds**:

| Input | What the live server reads | What the replay gives | Why |
|---|---|---|---|
| `edition` | `options/latest.json` at each run | the session's edition, from the file passed with `--edition` | the focus names and levels the board was built from that day |
| `bars` | Alpaca 2-minute bars of `ALPACA_FEED`, read about a minute after the slot | that session's historical 2-minute bars of the feed named (`iex` or `sip`), read once after the session, raw (unadjusted), regular session only (`normaliseBar`) | the only thing that differs between the two replays |
| `fetchedAt` | when each name's bars were read upstream | the slot's settle instant (end + `SERVER_SETTLE_MS`) for every name | the bars count as read exactly when the slot settled, so `bars-unsettled` never arises and only bars ended by the slot are used, as `evaluateSlot` filters them |
| `snapshots` | Alpaca's snapshot per name at run time (last trade time, the day's high and low) | per name, a snapshot dated the session with its last trade time at the slot's end and no high or low | `settledQuote` then takes the quote's time from the bars (inside the slot's own bar when it exists, else the last bar's start) and the high and low from the bars only; the run-time snapshot cannot be had after the session |
| `journal` | the owner's journal (`journal/latest.json`) | none (`null`), as the server reads a missing journal | the day limit then reads as not used and today's wins as unknown, for both feeds alike; the comparison reads no trade |
| `done` | the owner's "done for today" flag | `false` | it sets only the record's `day.done` flag, never a row's state |

## Limitations (stated, not hidden)

These are listed in every report's output as well.

1. **The run-time snapshot is not reproduced, and this cuts both ways.** It **removes pauses**: in the replay a
   slot that has its own bar is dated inside that bar, so it is never stale; live, a slot's only trade can come early
   in the bar and be more than `TRADE_STALE_MS` (120 s) old when the board judges it, and the board pauses. It
   **adds pauses**: in the replay a slot without its own bar is dated at the last bar's start, which is older than
   the true last trade (that bar may have traded up to its end), so the replay can pause where the live board did
   not. It also drops a `missed` that only a snapshot high or low printed after the slot would cause. Both replays
   are treated alike, but the pauses counted are the replay's, not the live board's.
2. **Historical bars, not the bars the server read.** The replay reads each feed's bars after the session. A late
   or corrected print can make them differ from what the live server read a minute after the slot. Both feeds are
   read the same way, so the comparison is fair between them, but it is not a re-run of the live records.
3. **The journal is absent.** On a day the owner reached the day's loss limit or trade cap, the live board read
   `no_trade` from then on; the replay does not. Cautions that depend on today's wins read as unknown. Neither feed is
   favoured.
4. **One edition per session.** The replay uses the edition file given. If the edition was replaced during the
   session, the live server read the newer one from that time on; the replay does not.
5. **The page is not replayed.** The board in the browser also builds bars from its own 2-second prices; the server's
   evaluation does not (no trails), and neither does this replay. It measures what the server's evaluation shows on
   each feed.
6. **The leader's quote** (a name's market leader, e.g. SMH for QQQ) is read only when the leader is itself a focus
   name, exactly as the server reads it.

## Running it

Run from an up-to-date worktree of `origin/main` (`git worktree add ~/trading-wt/feed-agreement origin/main`, then
`make bootstrap` and `cd dashboard && pnpm install --frozen-lockfile`), never from the stale console checkout
`~/trading`: the engine label in the report must be the one in production. The Alpaca keys come from the env file
(`ENV_FILE`, `.env` by default): `APCA_API_KEY_ID` and `APCA_API_SECRET_KEY`, or `ALPACA_API_KEY_ID` and
`ALPACA_API_SECRET_KEY`. The file is read with Node's own env-file parser, never sourced as shell. When the file
defines a key pair, that pair is used even if the shell exports another one (a shell profile can export a dead
pair); otherwise the environment's pair is used. The runner's first line says which: "keys from the env file" or
"keys from the environment".

```
make feed-agreement DAY=2026-11-12 EDITION=var/feed-agreement/editions/2026-11-12.json ENV_FILE=$HOME/trading/.env
make feed-agreement-summary
```

### Getting the session's edition file

The runner reads the edition from a local file (`--edition`). Two ways to get it, both with credentials the owner
already has:

- **Between the close and the evening edition** (until 21:52 UTC, `OPTIONS_SLOT_UTC`, when the next session's card
  replaces it): the site's latest edition is still that session's. On the **console Mac**, with the Mac's own
  `DASHBOARD_INGEST_URL` and `DASHBOARD_INGEST_SECRET` in its env file:
  `make feed-agreement-edition DAY=2026-11-12 ENV_FILE=$HOME/trading/.env`. It makes one signed, read-only
  `GET /api/editions/options` (the call `wt.options.pipeline_check` makes) and saves the edition to
  `var/feed-agreement/editions/<day>.json` only when its session is that day; otherwise it saves nothing and says so.
  **Never copy a secret off the trading host** to do this; if the Mac has no ingest secret of its own, use the next
  way.
- **Any later day**: the dashboard keeps one copy per session at `options/editions/<day>.json` in its private Blob
  store. The owner downloads it from the Vercel dashboard (the project's Storage, Blob, browse) with the owner's own
  login, and passes its path.

The edition is PRIVATE (it names the focus names and their levels). Keep it under `var/`, which git ignores.

### What the runner does

- Refuses a malformed day, a day that is not a session (weekend, holiday), a session until **20 minutes after its
  close** (16:20 New York, 13:20 on a half day, so the historical bars have settled), and an edition whose `session`
  is not that day or which has no focus names. Nothing is read upstream before these checks pass.
- Reads, for the focus names only, that session's 2-minute bars from `iex` and from SIP (the consolidated tape),
  from 09:30 to the close: read-only `GET /v2/stocks/bars` on `data.alpaca.markets`, one feed at a time, every
  request naming its `feed` explicitly, following `next_page_token` (at most 20 pages). It reads
  `X-RateLimit-Limit` on each feed's first answer and stops when SIP's is under 1000. It keeps under 200 calls a minute (180), waits for `Retry-After` (seconds or an HTTP date; 5 s when
  absent) on a 429 and retries a 429 at most **5 times**, and stops at a hard time budget (`BUDGET_S`, 120 s by
  default), never starting a wait that would end past it. The keys are sent only in Alpaca's headers; they are never
  printed or logged, and neither is a page token or a response body.
- Replays both feeds through `evaluateSlot` and writes, under `var/feed-agreement/` (git-ignored): `<day>.json` (the
  full report), `<day>.txt` (a short table) and the running summary `summary.jsonl` with one row for the session.
  Each file is written to a temporary name and renamed into place, the summary last, so a failure leaves no partial
  file. It then prints the table and the summary's reading.
- The output holds counts, state words, slot times (New York `HHMM`), symbols and the engine label only: no level, no
  price, no amount. Nothing is sent anywhere: no ntfy, no Blob write, no publish.

### When it stops without a report

In every case below it prints one line saying what happened (never a stack trace), exits non-zero, and leaves no
report file and no new summary row.

| Exit | Line begins | Meaning |
|---|---|---|
| 2 | `usage:` | missing or malformed arguments (a day not `YYYY-MM-DD` included) |
| 3 | `refused:` | not a session day, less than 20 minutes after the close, or an edition that is not that session's or has no focus names; for `feed-agreement-edition`, the site holds another session's edition |
| 4 | `no keys:` | no Alpaca keys in the environment (for `feed-agreement-edition`: no ingest URL or secret) |
| 5 | `sip not entitled:` | Alpaca answered 403 for SIP: not entitled, or recent data not permitted on this plan (on IEX: `iex refused:`) |
| 6 | `no bars:` | a feed returned no bars for any focus name that session |
| 7 | `time budget:` | the budget ran out: a call or its body still arriving, a `Retry-After` or a call-limit wait longer than what is left |
| 8 | `upstream:` | any other HTTP or network failure (the status only; 401 says keys rejected), a body that is not JSON, still paging after 20 pages, or a 429 after 5 retries |
| 9 | `write failed:` | a report file or the summary could not be written; the new files are removed |
| 10 | `failed:` | anything else unexpected (the error's name only) |
| 11 | `sip plan:` | SIP's first answer carried an `X-RateLimit-Limit` under 1000: the plan no longer includes real-time SIP, or the wrong keys |

A 401 reads `upstream: … HTTP 401: the keys were rejected (keys from the env file)` (or `from the environment`),
exit 8: check the named source's pair.

### Rechecking a day (how much the history drifts)

```
make feed-agreement-recheck DAY=2026-11-12 EDITION=var/feed-agreement/editions/2026-11-12.json ENV_FILE=$HOME/trading/.env
```

It fetches the day's bars again from both feeds, replays them through the same engine, and compares every unit's
word on each feed with the stored report's (`<day>.json`). It prints, and writes to `<day>.recheck.json`, only
counts: the units compared, how many changed word on IEX and on SIP, and how many changed set (comparable, both
lack). It never replaces the stored report or its summary row, and the reading never uses it. It refuses when there
is no stored report for the day, or when the stored report was made under another engine label (the change could not
be told from an engine change). Run it **once, the day after the first session**, to learn how much a session's
history drifts after the fact; if it drifts, that is a limitation of every report (limitation 2) and is said so
beside the reading, not corrected for.

### Reading five sessions

`make feed-agreement-summary` reads `summary.jsonl` and prints, for each engine label, the sessions run under it, the
pooled comparable and identical counts, the share, the IEX-only and SIP-only events, the clock-fixed, no-plan,
both-lack and one-sided counts and the names without bars; and the reading for the most recent session's label:
"not enough sessions", "not enough sessions (labels differ)", "equivalent for the board" or "different", by the rule
above.
