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
| One decision per name per finished 2-minute bar | `var/options/decisions/<date>.jsonl` |
| One plan file per trade | `var/options/plans/plan_<date>-O-<n>.json` |
| Loss latches | `var/options/latches/{day,week,drawdown}` |
| Log | `logs/paper_o_<YYYYMMDD>.log`; `journalctl -u wt-paper-o` shows only start and exit |
| Account | The clone's own paper account when `APCA_CLONE_KEY_ID` / `APCA_CLONE_SECRET_KEY` are set (`sudo wt-set-secrets`), otherwise the second paper account beside your hand trades |

## The dashboard

| Direction | What | How |
|---|---|---|
| In, at arm | The latest options edition's focus names (symbol, rank, bias) and its session | A signed `GET /api/focus` with the host's `DASHBOARD_KEY_ID` / `DASHBOARD_INGEST_SECRET`. On any failure, or a focus for another session, the clone trades SPY and QQQ; the Trades page then says "Fallback" under Names |
| Out, after every trade event and at the close | `stocksdelta/options-clone` v1: names, entries, day result against the limit, latch, trades, feed medians, broker stop, decisions by gate, each hypothesis's figures | `wt.ops.publish.send` from a thread of its own, newest first. Drawn as "The clone" on the Trades page. A document that cannot be built or sent is journaled (`clone_doc_unsent`), never retried into a trade; `clone_doc` at the close counts what was sent |

## Controls (owner)

| To | Run in `/home/wt/trading` as `wt` |
|---|---|
| Stop new entries (exits keep being managed) | `make kill DESK=options REASON="..."` (the stocks `KILL` file stops it too) |
| Allow entries again | `make unkill DESK=options` |
| Clear a loss latch, after reading the day's trades | `make reset-options-latch KIND=day\|week\|drawdown REASON="..."` (refused while a session runs) |
| Use the exact option feed after subscribing to Algo Trader Plus | `touch var/options/switches/opra` |
| Stop sending orders at all (it still arms and journals) | `orders: off` in `config/options_clone.yaml`, through a pull request and a decision record |

## Pages and what to do

| Page | Meaning | What to do |
|---|---|---|
| Options clone entered / exited | A trade, with its setup and result on premium | Nothing |
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
| `options.session`, `options.built_from` | the edition is not for the coming session, or not built from the last close |
| `options.close.<SYM>` | the edition's close is more than $0.02 from the tape's |
| `options.levels.<SYM>` | PDH, PDL, PWH, PWL, PMH, PML, MA20 or MA50 is more than $0.05 from the same level recomputed |
| `radar.date`, `radar.fresh` (before the open) | the radar is not for today, or is more than 6 hours old |
| `radar.close.<SYM>` (before the open) | the radar's price is more than $0.02 from the last close |

Warnings, never a page: `focus.tradeable` (fewer than two focus names have a contract expiring that session; the
clone tops up with SPY and QQQ, DEC-0032), `focus.premarket` (the 08:50 refresh did not land), `focus.earnings.<SYM>`
(a focus name reports, so the clone skips it), `radar.premarket.<SYM>` (price moved more than 0.5% since the radar).

Each run writes `var/pipeline-check/<session>-<slot>.json`. Any failed check pages once a day per run with the ids.
Read the report: `cat /home/wt/trading/var/pipeline-check/$(date +%F)-pre-open.json`.
