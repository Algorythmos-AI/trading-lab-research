# The board's stock feed: switching to SIP, checking it, and switching back

This runbook covers DEC-0050. The owner's board (the live prices, the session bars and the server evaluator) reads
the stock feed that `ALPACA_FEED` names on the production deployment (`dashboard/src/lib/alpaca-feed.ts`): `sip` when
it is unset (DEC-0064). `iex` is paused and refused like any other value; going back to it is the owner's, by a dated
note in DEC-0064 (point 2). Only the owner changes it. Automated contributors never do (AGENTS.md).

What it moves: `/api/quote`, `/api/bars` and `/api/cron/desk`, so the hero, the glance, the ladders, the live dot, the
cards, the manage card and the shadow evaluator all follow. What it does not move: paper B, the clone, the forward
test, the feed comparison (it names both feeds itself) and the owner-trade labeller (it names its feed per
experiment).

## Before the switch

- DEC-0050's pull request is merged.
- The board-feed stamp (DEC-0050 point 4) is released and running, so the cutover session shows in the stamps.
- On the stamp's first session, the site's logs show no `board-feed.stamp` line with outcome `no-deployment-id`.
  Each stamp must name its deployment, or a stamp gap would read as a hidden change.
- No production promote or redeploy during a session: a stamp gap over 10 minutes with a deployment change ends
  EXP-0033's window (DEC-0050 point 4).
- The switch is made after the US close, so no session is read on two feeds.
- Alpaca keys: the production key pair is the paid one (checked 2026-11-12). A free key pair answers 403 on SIP, and
  the board then shows prices as off. It never falls back to IEX.

## Switching to SIP (the owner)

1. In Vercel, open the dashboard project, then Settings, then Environment Variables.
2. Set `ALPACA_FEED` to `sip` for **Production** only. Preview and staging stay as they are.
3. Redeploy the current production deployment (Deployments, the newest production one, Redeploy). An environment
   variable only reaches a new deployment.
4. Optional, for options: set `ALPACA_OPTION_FEED` to `opra` the same way, once the pull request that adds it is
   released.

## Checking it (the next session, signed in)

- `/api/quote?s=SPY` answers `"feed":"sip"`, and the quote's `at` is within a few seconds of the clock during the
  session.
- `/api/bars?s=SPY` answers `"feed":"sip"`, and the bars carry volume.
- The Options page's feed strip says SIP on the live-price chip.
- After the session: if every board-feed stamp of that day reads `sip`, it is the cutover session (DEC-0050 point
  1). If not, the next session that passes is.
- Then the cutover note follows: a dated line in EXP-0031's and EXP-0033's `README.md`, and a dated note on
  DEC-0050.

## Switching back (rollback, the owner)

Use this when SIP fails for more than a passing outage, for example Alpaca refuses SIP (403) or the plan lapses.
Do it after the close where you can. Once EXP-0033's window has started, a rollback ends it with no verdict
(DEC-0050 point 4).

1. Since DEC-0064 there is no rollback to IEX from this runbook: `iex` is refused. The way back is the owner's (a
   dated note in DEC-0064, then the pause list emptied in code, then `ALPACA_FEED=iex` on Vercel and a redeploy).
2. Check `/api/quote?s=SPY` answers `"feed":"iex"`.
3. Record it: a dated note on DEC-0050 and a dated line in EXP-0033's `README.md`, with the session it took effect.

A short SIP outage needs no rollback. The board greys and pauses with its age shown, retries at 2, 4 and 8 s up to
30 s, and offers Retry now. How such a session counts for EXP-0033 is in DEC-0050 point 4.
