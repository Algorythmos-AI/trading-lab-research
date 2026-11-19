# DEC-0064: Every stock price comes from SIP; IEX is paused everywhere

- **Status: ACCEPTED on 2026-11-19.** approved_by: owner.
  - On 2026-11-19, in chat, the owner decided that IEX is paused for every consumer and only SIP is used.
  - Asked directly, they chose: the pre-market window 04:00 to 09:30 New York (from three windows put to them);
    that the clone's count restarts on SIP and EXP-0040 closes early (point 6); and that Robot B moves to SIP in this
    record (point 8).
  - The merge of the pull request that carries this line accepts it.
- **Written before any session on the new feed exists.** What the author had seen is listed in "Disclosure".
- **Amends:**
  - DEC-0030 in the clone's stock feed and in the window of its pre-market high and low (point 3). DEC-0031
    describes the feed as IEX; no record fixed it. DEC-0033 (the day, week and month levels) is unchanged;
  - DEC-0023 in the routine's live feed (point 9);
  - DEC-0037 in the feed of Robot B's signal bars (point 8). DEC-0024 describes B's quote as an IEX quote; that
    description changes with it;
  - DEC-0050 in one line: IEX no longer runs beside SIP for comparison (point 10).
- **Depends on:** DEC-0003, DEC-0005, DEC-0011, DEC-0028, DEC-0030 to DEC-0034, DEC-0039, DEC-0040, DEC-0050,
  DEC-0056, DEC-0058.
- **Experiment:** EXP-0050.

## Why

The owner has paid for Alpaca's Algo Trader Plus plan since 2026-11-12. The code was written for the free plan,
which refuses SIP for the last 15 minutes (DEC-0003), so live consumers read IEX, one exchange. On 2026-11-12 every
request was pinned to a named feed (#388) so that a plan change could not move a data source without a record. That
worked as designed: the upgrade changed nothing. DEC-0050 moved the owner's board. No record moved a host job.

Checked on 2026-11-18 (New York), read only:

| Check | Result |
|---|---|
| Host key pairs `APCA_API_`, `APCA_OPTIONS_`, `APCA_CLONE_`: SIP bars ending now, SIP latest quote, one OPRA snapshot | 200 on all nine; `X-RateLimit-Limit` 10000 |
| The site's pair (`/api/health`) | stock sip, option opra, 10,000 calls a minute |
| The board's feed (Feeds page) | every stamp of the session on SIP (388) |

Pre-market high and low on each feed, levels only. 12 liquid names, the 23 sessions from 2026-10-19 to 2026-11-18
(276 name-days). The names are the author's panel, not the clone's names of each day. No signal, fill or result
was read for it.

| Measure | IEX | SIP |
|---|---|---|
| Pre-market minutes with a bar, median per name-day | 5 (to 09:25) | 302 (to 09:30) |
| Name-days with no pre-market bar | 43 | 0 |
| Low within 5 cents of SIP's (of 233 name-days with IEX bars) | 3 | - |
| High within 5 cents of SIP's | 0 | - |
| Median gap of the low; of the high | 0.60%; 0.48% | - |

Cutting SIP at 09:25 instead of 09:30 moves the high by more than 5 cents on 50 of the 276 name-days and the low
on 32.

## Decision

1. **SIP is the only stock feed and OPRA the only option feed.** Every request for a stock bar, quote, trade or
   snapshot names `feed=sip`. Every option snapshot and chain names `feed=opra`. Requests that take no feed (news,
   corporate actions, option trades, option bars, contracts) are unchanged.
2. **IEX is paused, in one place.**
   - `wt.data.feeds` holds the paused feeds. `require_feed` refuses a request that names one, before it is sent.
   - On the dashboard the pause is applied outside the signal's frozen code (DEC-0051; its hashes do not change):
     in the feed setting and in the comparison jobs (point 10).
   - The pause is switched on in the last pull request, after every consumer below has moved. A test fails on an
     `iex` literal outside the paused comparison code.
   - **No fallback.** A SIP or OPRA read that is refused or fails is a failed data read, handled as each consumer
     handles one today. Nothing asks another feed instead. `HybridFeed`'s fall-back to IEX on a 403 is removed.
   - The way back is the owner's: empty the paused list and set the config values back, effective the next
     session, with a dated note here.
3. **The clone's stock bars come from SIP** (`feeds.stock: sip` in `config/options_clone.yaml`; the runner reads
   the key, which it ignored until now, and accepts only `sip`).
   - This moves the 2-minute bars, VWAP, ATR, the 9 EMA and SPY's trend read.
   - **The pre-market high and low are those of 04:00 to 09:30 New York on SIP 1-minute bars.** The clone arms at
     about 09:25, so it reads the range again after 09:30:00, no sooner than the offset at which it reads any
     minute bar (point 7), and before the first signal bar is judged. That second read is final for the day.
   - A failed read of the range is handled as a failed levels read is today. An empty answer leaves the name
     without pre-market marks, as today, and the journal says so.
   - Daily levels are unchanged (the edition's, or SIP daily bars: DEC-0033).
4. **The clone's option quotes come from OPRA by config** (`feeds.option: opra`). The host file
   `var/options/switches/opra` is no longer needed; removing it is the owner's step.
5. **Unchanged for the clone:** every setup, tolerance, gate, floor, cap, exit, limit, latch, the names, the 15:10
   flatten and the money limits. The 1-ATR retest tolerance and the time stop's wording, both raised by the
   2026-11-18 reconstruction, are not decided here.
6. **A new experiment, EXP-0050.**
   - The clone's three trials (HYP-0029 `retest`, HYP-0030 `rejection`, HYP-0031 `nearest`) run again on SIP as
     three new trials. Family O goes from 47 to **50**.
   - **The cutover session** is the first session whose `armed` journal line names the stock feed as `sip`. The
     pull request that moves the clone adds that field.
   - EXP-0040 closes at the session before the cutover, with however many sessions it has. It cannot reach 20, so
     it gives no verdict and is kept as a record, as EXP-0039 was. Its trades never count toward EXP-0050.
   - Each verdict needs a fresh 30 trades and 20 sessions from the cutover session, with the test of DEC-0030
     section 6. `wt.options.review` reports the window apart (`sip`); its start date is set by a dated note here,
     written before that session's trades are viewed.
   - IEX and SIP sessions are never pooled, in any report.
7. **When the clone reads a bar.** The clone reads a minute bar about 3 seconds after the minute ends. On one
   session, read only, SIP bars of SPY, QQQ, TSLA and NVDA are polled at 1, 2, 3, 5, 8, 15, 30 and 75 seconds after
   each of 20 minutes from 09:35. A bar is final at an offset when its open, high, low and close equal the
   75-second answer. A poll sent more than half a second late is left out.
   - If at least 95% of bars are final at 3 seconds, nothing changes.
   - Otherwise `feeds.bar_settle_s` is set to the smallest polled offset at which at least 99% are final, by a
     dated note here before the clone's pull request merges.
8. **Robot B reads SIP:** its signal bars and its latest quotes. This is the owner's instruction, not a response to
   any corrected result (DEC-0011 section 3 forbids changing B for one).
   - No entry, exit, size or limit of B changes. The 0.10% spread limit is the same number, read on the
     consolidated quote, which is usually tighter than IEX's: B may pass that gate more often.
   - The stop rule of DEC-0037 and its latch are never reset by this record, and keep counting across the switch.
     B's paper record is not restarted; it is split at the cutover.
   - B's runner logs its feed. Every evaluation of B's paper record (the scorecard, G2, an audit) reports sessions
     before and after its cutover apart and never pools them.
   - B's verdict (DEC-0062, SUSPEND) stands.
9. **The pre-market routine reads SIP** for every stage (`--feed sip` is the default; `hybrid` is refused). Its
   stage log names the feed. Agreement figures (DEC-0023) are reported apart from its cutover.
10. **The rest.**
    - Paper positions' last-price snapshots and the pipeline check's snapshots read SIP.
    - The 08:55 pipeline check asks each key pair for one SIP bar ending now and pages when an answer is not 200.
    - On the dashboard an unset `ALPACA_FEED` means `sip`; `iex` is refused and the board says why.
    - The feed comparison sampler, its report and `make feed-agreement` are paused, not deleted. They answer
      "paused" and ask nothing.
11. **If the subscription lapses,** SIP answers 403 for recent data. Every job then fails its data read, takes no
    new entry, keeps managing exits, and pages. Nothing returns to IEX by itself.

## Order of the work

Each step is its own pull request into `integration`; none changes behaviour before its release reaches the host.

1. The pause in `wt.data.feeds`, with an empty list.
2. The clone (points 3, 4, 6, 7).
3. The routine, paper positions and the pipeline check (points 9, 10).
4. Robot B (point 8).
5. The dashboard (point 10).
6. The pause switched on, the test, and the runbook `docs/runbooks/keys-and-feeds.md`.

Releases go into `main` after the US close and are the owner's to merge.

## Disclosure

The author read, while writing this record:

- A reconstruction of clone trade 2026-11-18-O-1 (a `retest` put in TSLA), pasted by the owner: its signal bars,
  gates, quotes, fill, stop, the highest and lowest option trade while it was open, and its exit by the time stop
  at its fill price. That is the trade's outcome.
  - On that session the IEX pre-market low was 382.26 and SIP's was 381.40. The reconstruction found that the
    signal exists with the first level and not with the second, on either feed's bars.
  - So this record is known to remove one flat trade. It was not chosen for that: the reason is the table in "Why".
- SIP trade prints of TSLA's 2026-11-18 pre-market, to check that the SIP low was not one odd print (1,597 trades
  below the IEX low, on several venues).
- The level comparison in "Why": highs, lows and bar counts only.

Seen before this work, as earlier records disclose: EXP-0029's running figures on 2026-11-16; EXP-0025's result;
clone trade 2026-11-16-O-1 in a supervision check; O-1's closing line and O-2's exit reason on 2026-11-18.

What the author did not see: any return or R figure of EXP-0039 or EXP-0040, the shadow file of 2026-11-18, and
any result of Robot B beyond what DEC-0061 to DEC-0063 state.

No backtest or replay of the clone on SIP levels was run beyond the one reconstructed signal.

## Not verified

- Which data source the Radar and the focus-pick skills call. They run in the owner's cloud project, outside this
  repo and its guards. The edition's levels come from there.
- The effect of the feed on past signals, beyond the one trade above. Measuring it with outcomes needs its own
  registered experiment.
- The owner's chart showed a line at 382.27 on 2026-11-18. SIP's low from 09:00 was 382.81 and from 04:00 was
  381.40, so that line is not explained.
