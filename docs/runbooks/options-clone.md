# Options clone (DEC-0030)

The options clone is a paper bot. It buys one same-day call or put at a time by the nine rules on the Trades page. It runs as the job `paper-o` on the host:

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
