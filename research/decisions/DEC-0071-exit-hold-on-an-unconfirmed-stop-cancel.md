# DEC-0071: a stop an exit asked to cancel is not put back while that exit is asked again

- **Status:** PROPOSED on 2026-11-23. It takes effect on the host once the owner merges it into `integration` and a
  release carries it to `main`. Until then the desks run the order manager as it was.
- **Evidence:** EXP-0048 (report section 3, the flatten leg) and the host's own plan files and journal, read on
  2026-11-23 (below).
- **Kind:** an execution fix in the order manager (`src/wt/oms/manager.py`), as DEC-0063 asked for ("each would
  need its own record"). It changes no rule: no signal, entry, stop price, target, size, limit, gate, latch, stop
  line or frozen config. HYP-0071's rule (DEC-0068) is untouched.
- **Desks:** the stock desk, Gap Hunter (`wt.live.runner_s`, `MultiOMS`), which sends every exit through
  `OMS.exit_now`. Robot B (`runner_b`) uses the same manager but no longer runs (DEC-0069). The options clone has
  its own order manager (`wt.oms.options`) and is not affected.

## What happened

EXP-0048 counted five end-of-day flattens of Robot B, all with exit incidents: 5 refused sells in 2 trades and 4
deferred exits in 3. Read again on the host:

- **Refused, 2026-10-21 and 10-26.** The sell was refused by our own pre-trade guard ("sell within long position:
  sell 2 vs long 2 minus resting sells 2"): the open-orders list still showed a stop that had been cancelled.
  #317 (2026-10-27) fixed that: a stop the broker has reported cancelled no longer counts as resting. No sell has
  been refused since.
- **Deferred, 2026-10-20, 10-27 and 11-11, the last two after #317.** The exit could not confirm its stop's cancel and deferred
  (`exit_deferred`, "stop cancel not confirmed"). The next loop's reconcile saw the stop gone and placed a fresh
  one ("protected QQQM: stop for 2 @ 283.11", journaled 20:50:37 and 20:51:02 UTC on 11-11). The exit then had to
  cancel that one too. One round on 10-20 and 10-27, two on 11-11; that trade closed at 20:51:05.
- The position was never without a stop and never refused, but each round cost a loop and two orders.
- **Not established:** why the cancel was not confirmed. The broker no longer lists those orders and the runner's
  logs for those days are gone, so a slow cancel and a failed lookup cannot be told apart. The fix below holds for
  both.

## What changes

- When `exit_now` sends a stop's cancel and cannot confirm it, the plan records that stop's id and a time
  `EXIT_HOLD_S` (15 s) ahead: `exit_hold_stop`, `exit_hold_until`, saved with the plan.
- Until then, `ensure_stop` does not replace that stop if the broker reports it gone, and `reconcile` journals
  "held SYM: stop cancelled for an exit that is due; not replaced" instead of placing one.
- The next loop's exit finds the stop cancelled and sells. A stop still resting keeps covering the position as
  before.
- The hold is tied to that one stop id and starts once per stop: it is never extended, and a stop placed since
  (a re-protect, a moved stop) is never held.
- **The bound.** If the exit is not asked again within 15 s (a target whose quote moved away, a loop error, a
  restart), the stop goes back on the next reconcile. 15 s is about one loop of the stock desk, which polls every
  10 s and asks its latched exits (`p.wt["exit"]`, the end-of-day steps) at every poll.
- The hold is a wall-clock time, so a restart inside it keeps it, and after it protects.
- The stock desk passes its session clock to the manager, so replays follow their own time.

## The risk it takes

For at most 15 s after a cancel the broker then confirms, the shares have no resting stop while their exit is due.
Before, they had a fresh stop that the exit then cancelled, which took a loop and two orders each round. Gap
Hunter's exits through `exit_now` are at the market, except the end-of-day flatten (a limit at the bid less
US$0.02, re-protected by the manager if it does not fill). The first-target sale goes through `partial_exit` and is
not changed by this record.

## Tests

`tests/unit/test_oms_exit_hold.py`, on a broker that accepts a cancel and reports it only later:

- a cancel confirmed late is sold on the next loop with no second stop;
- an exit not asked again gets its stop back after the hold;
- a restart inside the hold still sells, and after it protects.

These three fail with the hold switched off (`EXIT_HOLD_S = 0`, the old behaviour). These three hold either way:

- a cancel still pending keeps the old stop over the position;
- the hold is never extended;
- a stop that filled instead closes the plan as a stop, with no sell.

The manager's existing suites pass unchanged.

## Not included

- `MultiOMS.move_stop` and `partial_exit` defer in the same way when a cancel is not confirmed. A moved stop that is
  deferred may also be put back at its old price on the next loop. Neither was seen in the records, and neither is
  changed here.

## Notes

### 2026-11-22: a hold still running at the close

Found while building DEC-0073, before any release carried this record's code. A hold that begins in the session's
last 15 s, at an exit asked on the last poll, is still running when the after-close step asks for the overnight GTC
stop. If the cancel has landed by then, `ensure_stop` places nothing, because the hold says the exit will sell next.
No exit is asked after the close, so the shares would have no stop until the next session's open.

The after-close step now ends the hold first (`OMS.end_hold`), then asks for the stop. A test holds this
(`tests/unit/test_oms_exit_hold.py`). Nothing else in this record changes. The 15 s bound still applies during the
session.
