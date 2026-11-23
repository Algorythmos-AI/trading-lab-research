# DEC-0075: a deferred stop move lands at its new price; a deferred first-target sale is asked again inside the hold

- **Status:** PROPOSED on 2026-11-23. It takes effect on the host once the owner merges it into `integration` and a
  release carries it to `main`. Until then the desk runs the order manager as it was.
- **Evidence:** DEC-0071's "Not included" section. Neither case was seen in the records, so this fix is preventive.
- **Kind:** an execution fix in the order manager (`src/wt/oms/multi.py`) and in the runner's first-target try
  (`src/wt/live/runner_s.py`, `gap_exit`), as DEC-0063 asked for ("each would need its own record"). It changes no
  rule: no signal, entry, stop price the exit asks for, target, size, limit, gate, latch, stop line or frozen config.
  DEC-0073's execution stops, X3 included, are untouched.
- **Desks:** Gap Hunter only (`wt.live.runner_s`, `MultiOMS`). The base `OMS` is unchanged, so the desks that use it
  directly are not affected. The options clone has its own order manager (`wt.oms.options`) and is not affected.

## What happened

Nothing yet. DEC-0071 fixed a whole-position exit whose stop cancel is not confirmed. It named two more places in
`MultiOMS` that defer in the same way, and left them:

- **The stop move.** `move_stop` cannot confirm the old stop's cancel, so it notes `stop_move_deferred` and keeps the
  old price. If the cancel then lands, the next reconcile finds no stop and places a fresh one at the old price. The
  runner asks for the move again on the next poll and cancels that new stop. The two fight.
- **The first-target sale.** `partial_exit` cannot confirm the stop's cancel, so it notes `partial_deferred` and
  sells nothing. If the cancel then lands, the next reconcile puts a full-size stop back. The runner tries the sale
  only once a minute, so the next try cancels that stop again.

## What changes

### The stop move

- When `move_stop` defers, the plan saves the new price as `stop_deferred`. The old stop keeps resting and stays the
  plan's stop.
- The stop that replaces the old one, once the broker reports it gone, rests at the larger of the plan's stop and the
  deferred price. It never lowers the stop.
- The new price is saved on the plan before the stop is placed. The journal's stop price and the stop order agree.
  So does DEC-0073's X5 reading, which compares a stop's fill with its own stop price.
- The plan's log notes the landing as `stop_moved` with the marker `deferred`. The reconcile row names the new price.
- A broker that refuses the stop at the new price (the market can already be under it) gets the old price instead,
  as `move_stop` already does. The position is never left without a stop.
- The deferred price is dropped when a later move succeeds, when the old stop is found filled, and when the plan
  closes.
- There is no hold here. A hold would leave up to 15 s with no stop, where today an old-price stop rests.
- The field has a default, so the plan files already on the host still load.

### The first-target sale

- When `partial_exit` sends the stop's cancel and cannot confirm it, it starts DEC-0071's hold: the same
  `exit_hold_stop` and `exit_hold_until` fields, once per stop, never extended. `ensure_stop` and `reconcile` then do
  not put the stop back, and the after-close step's `end_hold` covers it.
- A cancel that was never sent (the broker could not be read) starts no hold.
- Inside the hold, the runner asks for the sale again at the next poll (10 s), on a fresh quote, instead of waiting for
  the next minute. The bid must still be at or over the target, and the limit is still the target's own price.
- If the sale is not asked again at that poll (the bid has left the target, or the hold ran out since reconcile), the
  runner ends the hold and puts the stop back in the same poll. It does not wait for the next poll's reconcile.

### Why the once-a-minute rule still holds

The runner tries the first target once a minute because an unfilled try costs its time without half the stop: the
remainder's stop rests while the sale waits. A deferred try sent no sale and never took that stop away. Asking again
at the next poll, on a fresh quote that must still be at or over the target, takes nothing the rule protects. A try
that does send a sale still uses up its minute.

### Why the hold ends early when the bid leaves

The stock desk checks DEC-0073's X3 at the start of each poll, before reconcile. A hold that ran its full 15 s would
end between two 10 s polls. The next poll would then find the shares without a stop before reconcile put one back: one
`unprotected` row, and up to 20 s with no stop. Ending the hold at the first poll that does not ask for the sale
avoids both, for a cancel the broker has reported by that poll. X3 is not changed.

## The risk it takes

- **The stop move.** None beyond today's. The old stop rests until the broker reports it gone, as before. The
  replacement rests at a higher price, or at the old one if the broker refuses it.
- **The first-target sale.** From a cancel the broker reports late until the next poll, about 10 s, the shares have no
  resting stop while the sale is due. Before, they had a fresh full-size stop that the next minute's try cancelled
  again. The same window exists in DEC-0071 for a whole-position exit.
- **A cancel reported later still.** If the broker reports the cancel only after the hold has been ended, the old
  stop was still resting at that poll, and nothing is held. The next poll finds the shares without a stop before its
  reconcile puts one back: one `unprotected` row, and X3 does not latch. This is as before this record. A replay with
  the cancel reported 25 s after it was sent gave exactly that.
- **Found, not changed.** A deferred stop move whose old stop is reported gone between two polls is bare until the next
  poll's reconcile, as it was before this record. X3 counts that poll once and does not latch, since it needs two in a
  row. The session replay below shows this.

## Tests

`tests/unit/test_oms_deferred_move_partial.py`, on a broker that accepts a cancel and reports it only later:

- a deferred move whose cancel lands late is replaced at the new price, never the old one, with one stop placed;
- a refused stop at the new price falls back to the old price;
- the deferred price never lowers a stop, survives a restart, and lands on a stop resized for a smaller position;
- a deferred sale is sold on the next poll with no second full-size stop;
- a sale not asked again gets its stop back after the hold;
- a hold still running at the close is ended by `end_hold`;
- a stop fill or a close drops the deferred price.

These fail with the fix switched off. These hold either way: a plan file without the new field loads, through
`MultiPlanStore` and through the runner's `load_plan`; a later move clears the deferred price; a broker that cannot be
read starts no hold; the hold is never extended.

`tests/unit/test_runner_s_deferred.py`, Gap Hunter's whole session replayed (the harness of `test_runner_s_gap`):

- **X3.** A sale is deferred, its cancel is reported by the next poll, and the bid stays under the target for more
  than two polls. No `execution_stop` row and no `unprotected` row. The stop is back at the next poll, and the next
  touch sells the half. It fails without the runner's early end of the hold.
- **A winner.** The first-target sale and the breakeven move are deferred once each. The trade still matches the batch
  path's, with one stop at each price and no stop at an old price.

The manager's and the runner's existing suites pass unchanged.

## Not included

- `partial_exit` places the remainder's stop at the plan's stop, not at a deferred price. In Gap Hunter the stop moves
  only after the first target, so no deferred move can be pending at the sale.
- A deferred move whose old stop is reported gone between two polls still shows as one bare poll to X3 (above). So
  does a sale's cancel reported after its hold has ended.
- The runner journals `stop_moved` only for its own successful call. A deferred move that lands in reconcile shows in
  the reconcile row and in the plan's log, not as a `stop_moved` row.
