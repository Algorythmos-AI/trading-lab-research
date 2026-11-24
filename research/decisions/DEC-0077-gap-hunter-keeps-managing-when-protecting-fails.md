# DEC-0077: Gap Hunter keeps managing a position when protecting it fails, and two plans never cancel each other's orders

- **Status:** PROPOSED on 2026-11-24. It takes effect on the host once the owner merges it into `integration` and a
  release carries it to `main`. Until then the desk runs as it does today.
- **Evidence:** a read-only audit of `runner_s.py` and the order manager on 2026-11-24, and two replays written before
  the fix that fail on today's code (`tests/unit/test_runner_s_protect.py`). Neither case has been seen on the host:
  Gap Hunter has had one live session, with no trade. This fix is preventive.
- **Kind:** an execution fix in the runner's poll (`src/wt/live/runner_s.py`) and in the order manager's reconcile
  (`src/wt/oms/manager.py`, `src/wt/oms/multi.py`), as DEC-0063 asked for ("each would need its own record"). It
  changes no rule: no signal, entry, stop price, target, size, limit, gate, latch threshold, stop line or frozen
  config. HYP-0071 is unchanged.
- **Desks:** Gap Hunter only (`wt.live.runner_s`). The base `OMS.reconcile` gains an optional argument whose default
  keeps today's behaviour, so the other callers (the retired `runner_b`) are not affected. The options clone has its
  own order manager (`wt.oms.options`) and is not affected.

## What happened

Nothing yet. The audit found two ways a position could be left unmanaged.

1. **A refused stop stops the whole poll.** Each poll first syncs every active plan with the broker and re-places a
   missing stop ("sync and protect"). That step had no guard of its own. If the broker refused the stop, the error
   left the poll at its outer guard (`loop_error`), so the steps after it never ran: the exits, the end-of-day
   flatten and the flat check. One way to get there: no stop rests (the broker dropped it, or a hold ended), and the
   market is already under the plan's stop, so the broker refuses a sell stop over the bid. That repeats every poll
   until the close, and the position is held overnight. DEC-0073's X3 latches entries off but never sells.
   The replay shows `loop_error` at every poll after 09:34 and no exit all day.

2. **Two active plans cancel each other's orders.** Each poll reconciles one plan at a time, naming only that plan's
   symbol. The reconcile cancels every one of the desk's orders outside the symbols it was given, as a "stray". With
   two active plans (the day's plan and a position no plan opened, adopted as an orphan, whose sale did not fill at
   once), each plan's reconcile cancelled the other's stop, and each next reconcile put its own back. That contradicts
   `multi.py`'s own guarantee ("every call names every active plan's symbol"). The replay shows a stray cancel of both
   stops at every poll while both plans are active.

## What changes

### The protect step has its own guard

- Each plan's sync and reconcile runs in its own guard. A refusal (`BrokerRejected`, `SubmitFailed`, or a
  `GuardRejected` raised outside the reconcile's own guard) is caught there. The poll then goes on to the exits, the
  end-of-day steps and the entries, as on any other poll.
- The refusal is journaled as `protect_failed`, with the plan's id, its symbol and the error's class name (no
  free-text detail). The first one of the day pages the owner (`paper-s:protect-failed`, priority 5).
- **When the market is already under the plan's stop** (the latest bid is at or under it), the plan leaves at market
  at once, with the reason `stop` and `why: stop_under_market`. The simulation is stopped out there too. This is the
  same thing `gap_exit` already does when the broker refuses a trailed stop under the market.
- When the bid is still over the stop, nothing else changes. The next poll tries to protect it again, the exits keep
  running, and DEC-0073's X3 counts the bare polls as before.
- A transport error (the outcome is unknown) is caught the same way, journaled as `protect_failed`, and retried next
  poll. It never takes the exit by itself.

### Every reconcile keeps every active plan's orders

- `OMS.reconcile` takes `keep`, a set of symbols whose orders are not strays although this call does not manage them.
  The default is empty, which is today's behaviour.
- `MultiOMS.reconcile_all` passes `keep` through.
- The runner passes the symbols of every active plan (the day's plan and the held ones) as `keep`, so no plan's
  reconcile cancels another plan's orders. An order in a symbol no active plan owns is still a stray, as today.

## The risk it takes

- **A market exit on a refused stop.** The plan sells at market when the bid is at or under its stop and no stop could
  be placed. That is where the simulation is stopped out, so it is not a new exit rule. The fill can be worse than
  the stop on a fast name. The alternative is to hold a position under its stop with no stop at all.
- **A poll that goes on after a refusal.** The exits now run in a poll where the protect step failed. They are the
  same exits that run on every other poll, and each already checks the plan's state.
- **`keep` is wider than before.** An order the desk placed in a symbol that belongs to another active plan is no
  longer cancelled by the first plan's reconcile. That order belongs to the other plan, and the other plan's own
  reconcile still cancels its excess sells.

## Tests

`tests/unit/test_runner_s_protect.py`. Both replays fail on the code before this record and pass after it:

- `test_a_stop_the_broker_refuses_while_bare_takes_the_exit_and_never_stops_the_poll`: the e2 trade fills at 09:31,
  the broker drops its stop at 09:34 when the name is already under it, and refuses any sell stop over the bid. The
  desk journals `protect_failed`, sells before 09:37, logs no `loop_error`, and ends flat.
- `test_an_adopted_orphan_and_the_days_plan_never_cancel_each_others_orders`: XYZ appears in the account at 09:33
  while the day's plan holds ABC, and XYZ's sale is refused until 09:38. No reconcile cancels a stray order, no
  `unprotected` row is journaled, both positions close, and the account ends flat.

The existing suites pass unchanged, DEC-0073's X3 replays among them.

## Not included

These were found by the same audit and are left for their own records:

- A lagging order lookup after a timeout that aborts a live entry, whose later fill is then adopted as an orphan.
- The −6R stop rule skipping trades whose exit price is estimated, and being checked only at arming.
- X3 not seeing a part-filled entry, and no longer journaling `unprotected` after its first latch.
- HTTP 429 treated as a final refusal.
- A resting entry through a halt, the end-of-day flatten priced from an unchecked quote, and the state a failed bar
  read clears.
