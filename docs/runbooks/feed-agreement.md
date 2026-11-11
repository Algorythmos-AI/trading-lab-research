# Feed agreement: IEX against SIP for the Options board

The Options page's "Trade now" board reads Alpaca's IEX feed (one exchange). The owner's Alpaca plan now includes
SIP (the consolidated tape). The owner has decided that the board stays on IEX while the two feeds are compared side
by side for about five sessions, and that any switch is made by the owner with a dated decision record. This page
fixes, before any number is seen, how that comparison is made and how it is read. The tool that makes it is
`make feed-agreement` (below).

Written 2026-11-11, before any comparison was run on real data. The thresholds below are fixed. Changing any of them
needs a new dated version of this page, committed before the next run; runs made before it are read under the rules
they were run under.

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
(`ENGINE_VERSION`, `pnpm gen:engine`) does not change. The label in force is written into every report.

Each session is replayed twice, slot by slot: once with that session's IEX 2-minute bars, once with its SIP 2-minute
bars. Everything else given to the evaluation is the same for both replays (see "The inputs").

## The unit

One **unit** is one (focus name, side, 2-minute slot) of the regular session:

- the focus names are the session's edition's focus card (`focus.items`), in the card's order (`focusSymbols`);
- the sides are `call` and `put` (`SIDES`); a name's two rows come from `stateRows`, as in the server's record (a
  name the board pauses, or holds at no trade, carries that state on both sides);
- the slots are `expectedSlots(day)`: every 2-minute bar end from 09:32 New York whose settle instant
  (end + `SERVER_SETTLE_MS`, 60 s) falls before the close (16:00, or 13:00 on a half day, from the exchange calendar
  `market-calendar.json` via `sessionOf`). A full day has 194 slots (09:32 to 15:58), a half day 104 (09:32 to
  12:58). Slots are New York wall-clock times, so the week of a clock change needs no special case;
- each slot is evaluated **as of the settled slot, exactly as the server does**: `evaluateSlot` with
  `slot = { day, end }`, which reads the bars that ended by `end` and judges the board at `end + CLOSE_GRACE_MS`.

Only slots where the board is live (`board === "live"`, from 09:35 New York, so from the 09:36 slot) have units.
The 09:32 and 09:34 slots are "opening" on both feeds by the clock alone; they are counted as slots without units.

A unit **has a state** on a feed when that feed's evaluation for the slot has `status === "ok"`, its board is live,
and it holds a row for the name and side. It has **no state** when the name is in `degraded_names` (`bars-missing`,
`bars-gap`, `snapshot-missing`) or the evaluation is not `ok`.

A unit **has a bar** on a feed when that feed holds the name's bar for the slot itself (the 2-minute bar ending at
the slot's end).

A unit is **comparable** when it has a state and a bar on both feeds. A unit that has a state and a bar on one feed
but not on the other is **one-sided**: it is reported apart, by which feed lacks it, and is never counted as agreement
or as disagreement. A unit that lacks a state or a bar on both feeds is reported apart too ("both lack").

## The measures

Per session:

1. **State agreement**: of the comparable units, how many carry the identical state word (`no_trade`, `watch`,
   `get_ready`, `enter_zone`, `plan_off`, `missed`, `paused`) on both feeds. Reported as a count and a share, with the
   full table of (IEX state, SIP state) pairs, and the disagreeing units listed by name, side, slot and the two states.
2. **Enter-zone events on each feed**: for each name and side, in slot order over the live slots, an event is a unit
   whose state is `enter_zone` when the previous slot's state for the same name and side was not `enter_zone`. A
   previous slot with no state counts as not `enter_zone`; the first live slot has no previous slot, so `enter_zone`
   there is an event. Events are found on each feed's own states, comparable or not.
3. **Matched events**: an IEX event and a SIP event for the same name and side match when their slots are at most
   one slot apart (plus or minus one slot, 2 minutes). Each event matches at most one other. Pairs are taken closest
   first (offset 0 before plus or minus 1), then earliest. The **offset** of a match is the SIP event's slot minus
   the IEX event's slot, in slots (positive: SIP later).
   Reported: matched count, **IEX-only** events (no SIP event within one slot), **SIP-only** events, and of the
   matched events the **median offset** and the **worst offset** (the largest in size), with the count at each
   offset (-1, 0, +1).
4. **Not comparable**: the one-sided units, split into "IEX lacks" and "SIP lacks", and the "both lack" units.
5. **Bars missing per slot**: for every slot of the session (live or not), how many focus names have no bar for that
   slot on IEX, and how many on SIP; and the totals.

A report is written for one session at a time. Its share and its unmatched events are shown, but **a single session
is never read** as equivalent or different.

## The reading (fixed)

Over **at least 5 sessions** (distinct session days in the running summary, the latest run of each day counted
once), pooled:

- the feeds are **"equivalent for the board"** when **at least 98% of the comparable units match** (identical
  comparable units x 100 >= 98 x comparable units, so exactly 98.000% passes and anything below does not) **and every
  enter-zone event on either feed has a match within one slot** (IEX-only + SIP-only = 0);
- otherwise they are **"different"**. Zero comparable units over the sessions reads "different": agreement cannot be
  shown;
- with fewer than 5 sessions the summary says **"not enough sessions"** and gives no reading.

The one-sided counts and the bars-missing counts are shown beside the reading and are not part of it. A large
one-sided count is itself a finding about the feeds (one of them has no price in slots where the other does) and the
owner reads it as such; it is not hidden by the reading.

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

1. **The run-time snapshot is not reproduced.** Live, a name whose snapshot's last trade is older than the slot's
   end can read `paused` from it, and a snapshot high or low printed after the slot can move a side to `missed`. The
   replay sees only the bars, so neither effect appears. Both replays lack it alike.
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

After a session has closed, on a machine with the Alpaca keys in `.env` (`APCA_API_KEY_ID` and
`APCA_API_SECRET_KEY`, or `ALPACA_API_KEY_ID` and `ALPACA_API_SECRET_KEY`):

```
make feed-agreement DAY=2026-11-12 EDITION=var/feed-agreement/editions/2026-11-12.json
make feed-agreement-summary
```

### Getting the session's edition file

The runner reads the edition from a local file (`--edition`). Two ways to get it, both with credentials the owner
already has:

- **Between the close and the evening edition** (until 21:52 UTC, `OPTIONS_SLOT_UTC`, the time the next session's
  card replaces it): the site's latest edition is still that session's. On a machine whose `.env` has
  `DASHBOARD_INGEST_URL` and `DASHBOARD_INGEST_SECRET` (the trading host's, which the pipeline check already uses):
  `make feed-agreement-edition DAY=2026-11-12`. It reads the signed `GET /api/editions/options` (read only, the
  same call `wt.options.pipeline_check` makes) and saves the edition to
  `var/feed-agreement/editions/<day>.json` only when its session is that day; otherwise it saves nothing and says so.
- **Any later day**: the dashboard keeps one copy per session at `options/editions/<day>.json` in its private Blob
  store. The owner downloads it from the Vercel dashboard (the project's Storage, Blob, browse) with the owner's own
  login, and passes its path.

The edition is PRIVATE (it names the focus names and their levels). Keep it under `var/`, which git ignores.

### What the runner does

- Refuses a day that is not a session (weekend, holiday), a session not yet closed (now before the close plus
  `SERVER_SETTLE_MS`), and an edition whose `session` is not that day or which has no focus names.
- Reads, for the focus names only, that session's 2-minute bars from `iex` and from `sip`, from 09:30 to the close:
  read-only `GET /v2/stocks/bars` on `data.alpaca.markets`, one feed at a time. It keeps under 200 calls a minute,
  waits for `Retry-After` on a 429, and stops at a hard time budget (`BUDGET_S`, 120 s by default). The keys are sent
  only in Alpaca's headers; they are never printed or logged, and neither is a page token or a response body.
- Replays both feeds through `evaluateSlot` and writes, under `var/feed-agreement/` (git-ignored):
  `<day>.json` (the full report), `<day>.txt` (a short table) and one row appended to `summary.jsonl`. It then prints
  the table and the summary's reading.
- The output holds counts, state words, slot times (New York `HHMM`) and symbols only: no level, no price, no amount.
  Nothing is sent anywhere: no ntfy, no Blob write, no publish.

### When it stops without a report

In every case below it prints one line saying exactly what happened, exits non-zero, and writes nothing (no report
file, no summary row), so no misleading report exists.

| Exit | Line begins | Meaning |
|---|---|---|
| 2 | `usage:` | missing or malformed arguments |
| 3 | `refused:` | not a session day, not yet closed, or an edition that is not that session's or has no focus names |
| 4 | `no keys:` | no Alpaca keys in the environment |
| 5 | `sip not entitled:` | Alpaca answered 403 for the SIP feed: the plan does not include it (on IEX: `iex refused:`) |
| 6 | `no bars:` | a feed returned no bars for any focus name that session |
| 7 | `time budget:` | the budget ran out, including a `Retry-After` longer than what is left |
| 8 | `upstream:` | any other HTTP or network failure (the status only) |

### Reading five sessions

`make feed-agreement-summary` reads `summary.jsonl` and prints, over the distinct sessions (the latest run of each
day), the pooled comparable and identical counts, the share, the IEX-only and SIP-only events, the one-sided counts,
the engine labels seen, and the reading: "not enough sessions" (fewer than 5), "equivalent for the board" or
"different", by the rule above.
