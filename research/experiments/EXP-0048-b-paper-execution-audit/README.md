# EXP-0048: Robot B paper execution audit

- **Status:** registered 2026-11-19, before the snapshot is taken and before the driver is run.
- **Owed by:** DEC-0062 ("What follows", item 1); DEC-0061 cap C2 (no promotion step while EXP-0048 is unread).
- **Trials:** none. The global count stays at 87.
- **Changes nothing.** No rule, exit, size, limit, gate, latch or stop line of B changes because of any figure here
  (DEC-0011 section 3). Reading the result lifts cap C2 only. Rows V2 and C1 still bind, so the verdict stays
  SUSPEND (DEC-0062).

## What it measures

The full registration is in `config.yaml`. The method is in `src/wt/research/b_exec_audit.py`; the driver,
`scripts/b_exec_audit.py`, refuses to run if:

- the experiment id has no registration;
- the tree is dirty;
- the journal's hash chain is broken;
- a `results.json` already exists;
- the snapshot fails to reproduce the registered aggregate (9 trades, −3.29R, 36 armed sessions to 2026-11-18).

It reports these aggregates, and nothing per trade:

1. **Fill shortfall against the backtest's fill model**, in R, for each leg:
   - entry, also in bps;
   - stop exits;
   - target exits;
   - the round trip, where both legs are measurable.
2. **Latencies.**
3. **Order-manager incidents** on the exit path.
4. **Blocker and fault counts.**
5. **Replay agreement.**

Some legs cannot be measured from what the host records. These are fixed before the run:

- Flatten exits need a QQQM bar, which the host does not record.
- The gap term of the engine's entry and stop fills also needs that bar, so the entry and stop shortfalls are upper
  bounds.
- Estimated exit prices are counted, not measured.

## Before registration (disclosure)

On 2026-11-19 three read-only probes of the host were run to learn the record schema. They covered event names,
key names, file lists, plan-log entry kinds and value types. No price, R, P&L or date-to-outcome pairing was printed.

The second probe printed one thing beyond the schema: plan-log entry kinds with counts over the 9 plan files. That
output shows:

- the exit-reason split of the 9 trades: eod_flatten 5, stop 2, target 2;
- the exit-incident row counts: exit_failed 5, exit_deferred 4, exit_unfilled_restopped 4.

Both are outcome-bearing aggregates, and they are disclosed here. They were already visible on the /robot-b
blotter. They did not shape the registration: the metric list follows the plan's Stage 2 item 2, written on
2026-11-18. The armed-session count (36) comes from the first probe.

## Data class

The snapshot holds PRIVATE material (log lines, prices, account state), so it stays outside git, at
`~/trading/var/research/EXP-0048/snapshot`. `results.json` holds SAFE fields only (counts, R, statistics, seconds,
sha256 values).
