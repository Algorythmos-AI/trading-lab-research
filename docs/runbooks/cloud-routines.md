# Cloud routines

Seven scheduled Claude routines feed the dashboard, the release flow and the weekly report. They run in Claude's cloud, not on the host
and not from this repository's code (except where noted), so `systemctl` and the deploy gate know nothing about them.
Each posts into its own thread on claude.ai. Each replies only when something needs the owner; a normal run updates
its status line and stays quiet.

| Routine | Id | When | What it does | Writes |
|---|---|---|---|---|
| Options levels, after close | `trig_01EUa31y41kKS4WuJqBXJwWN` | 21:52 UTC, Mon–Fri | Pulls IBKR daily and hourly bars and the volatility snapshot for the ten names, builds the levels, picks the next session's four focus names, posts the focus card, then runs the shadow step | The options edition (`/api/ingest`, `trading-lab/options`) |
| Options focus, pre-open | `trig_01WyzH7k8xAUgj8RZsakUDW7` | 08:50 New York, Mon–Fri | Prices the focus names before the open and republishes the focus block; posts the pre-open card | The edition's focus block |
| Radar edition | `trig_01B1TN3d4x7dZ3Wxad2LmYgb` | 11:12 UTC, Mon–Fri | Sends the newest radar outbox file; retries once if the radar run is late | The radar edition |
| Webull trades, live | `trig_01Et86JsFLYn7j7kbBt1dGUm` | :24 every hour 09:24–15:24 New York, Mon–Fri | Each run reads the owner's Webull AU history every 2 minutes for an hour (stops at 16:20) and publishes on change and at least every 30 minutes | The trade journal |
| Webull trades, after close | `trig_012wh4n2yJT7B4Agy12u7yoF` | 21:38 UTC, Mon–Fri | One full read after the close | The trade journal |
| Release PR | `trig_01Dbj8zTA2HTq2Uzf9ziRzdj` | 16:20 New York, Mon–Fri | Opens or refreshes the `integration` → `main` release PR and drives its CI; never merges | A pull request |
| Weekly supervisor report | `trig_01EpHRrfQphBMhwEDGykabZi` | Sat 13:30 UTC (Fri evening or Sat morning in New York) | Reads the week's scorecard and the decision records' status lines and replies in at most fifteen lines; runs with the repository only, no connectors | A reply in its thread |

All of them are read-only toward the brokers: none places, changes or cancels an order.

Two more routines, outside this list, publish the focus card ledger (`stocksdelta/ledger`) from the
`focus-card-ledger` repository: one saves the card before the open (about 09:11 New York) and one scores it after
the close (about 16:21 New York). Their ids and the zone of their schedules are not recorded here and have not been
checked; the feed watch shows them as assumed and never pages for them (below).

## What depends on what

- **The feed watch** (`dashboard/src/lib/feed-watch.ts`, its table `FEEDS`) holds every routine above that publishes
  a document, with the schedule and zone in this table: the options edition (21:52 UTC), the pre-open refresh
  (08:50 New York, due by 09:05), the journal (the hourly live runs and 21:38 UTC), the radar (11:12 UTC), the two
  ledger routines (assumed, display only) and the desk's own shadow evaluator. It is the one source for the
  Operations page's "Your feeds", the Options page's health strip and the feed alerts (`/api/cron/watchdog`, pages
  only with `FEED_WATCH_ALERTS=on`). **A change of a routine's schedule or zone here must change its row there**, in
  the same pull request; a new routine that publishes is one more row (and, to show it, a chip or a card).
- **The journal's freshness**: the feed watch expects a read at or after each live run within 45 minutes (the
  routine publishes at least every 30 minutes) and the 21:38 UTC sync within an hour, and pages after two missed runs
  in a row. The evening rule (only a stamp at most 10 minutes before 21:38 UTC counts) assumes the after-close routine
  stamps its own read time and never fires over 10 minutes early; neither is recorded here, so that run is marked
  assumed and a missed evening sync is shown, not paged, until the owner confirms both (then drop `verified: false`
  from that schedule in `FEEDS`). The day check (`trade-rules.ts`, `journalCurrent`, inside the shadow evaluator's engine) is stricter and
  says "Journal not current" when a read is missing; it still reads `feeds.ts`'s `journalCheck`, unchanged.
- **The options desk and the clone** read the edition and its focus block. The pre-open routine replaces only the
  focus block.
- **The IBKR paper login** is shared by the options routines and the HFT desk's runner. Two sessions on one login end
  each other ("competing live session"); this is why the HFT desk is parked (HFT-DEC-0005).
- **GitHub access.** The release-PR routine and the options routine's shadow step read this repository. Since the
  repository is private (2026-10-24), they need the routines' GitHub connection to cover it. The first night after
  the flip is the check: the shadow step's reply names the step that was blocked.
- **The shadow step** is temporary: it compares the repository's edition builder with the routine's own. Five
  consecutive clean nights in format 2 are the condition for switching the build to the repository
  (`scripts/options_edition.py --pulls --send --focus`, plan step B4, its own decision record).

## Checking a routine

- On claude.ai: the routine's page shows its schedule, its last run and the thread.
- From a Claude session: `RemoteTrigger` `get` (schedule, `enabled`, `next_run_at`, last run) and `get_run_log` on
  the run's session id. A fire that was skipped before a session existed leaves no run; `get` still shows it.
- On the dashboard: Operations, "Your feeds", says whether each feed arrived on schedule; the Options page's strip
  says the same for the feeds the morning trades from. Both use the exchange calendar, so a holiday is not late.

## The weekly supervisor report (plan step D2, created 2026-10-25)

Fifteen plain lines every Saturday at 13:30 UTC, after `wt-weekly` (Friday 20:00 New York) and its evidence pull
request, from the same records the Research page's "The programme" panel reads. It runs with the repository and no
connectors: a scheduled task acts without pausing for approval, so it carries nothing it does not need (no broker,
no mail). Its prompt:

> Weekly supervisor report for the trading lab (Algorythmos-AI/trading-lab-research). Read-only: never place,
> change or cancel an order, never merge, never push. Read the newest weekly scorecard in
> `research/forward/archive/` on `integration`, or in the open `evidence/*` pull request if it has not merged yet,
> and the decision records' status lines in `research/decisions/`. Reply in this thread with at most fifteen short
> lines, counts, ids, dates and R only: what strategy B and the options clone traded this week; G2a (clean
> sessions, incident-free streak, agreement at the bar) and G2b (trades) against their lines; where B's stop rule
> (DEC-0037) stands and whether it fired; any decision record still PROPOSED and how long it has waited; any open
> pull request into `main`; and what is blocked on the owner. Never quote a decision's prose, a setup name, a
> headline, an account balance or a P&L in dollars. If the scorecard for this week is missing, say so in one line
> and stop.
