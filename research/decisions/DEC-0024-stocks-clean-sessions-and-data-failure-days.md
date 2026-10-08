# DEC-0024: Stocks desk, what counts as a clean session, what a data-failure day records, and three things left as they are

- **Status: ACCEPTED on 2026-10-08.** The owner accepts it by merging the pull request that carries this
  status line. Each numbered decision below is stated as recommended; to choose otherwise, change its
  **Decision** line before merging.
- **Changes:** the definition of a clean G2 session (decision 1) and what the forward test records on a
  day whose data failed (decision 2). Decisions 3 to 6 change nothing and say why.
- **Changes no:** strategy rule, risk limit, cost, trial count, or past ledger row.
- **Evidence:** `docs/audits/STOCKS_FORENSIC_AUDIT.md`; the host's journal as read on 2026-10-08 (six armed
  sessions); `tests/unit/test_b_parity.py`.
- **Date drafted:** 2026-10-08.

## 1. A session whose signal could not be checked is not a clean G2 session

**Was:** a session is clean when the runner armed, finished, had no kill, refusal or incident
(`src/wt/analytics/g2.py`). The outcome was not read, so a session that armed and never once had its prices
counted toward the 30 clean sessions, and toward agreement with the forward test as "both did not trade".

**Decision:** a session that ends `no_inputs` is not clean and is left out of the agreement measure. The
dashboard counts such sessions separately.

**Why:** G2 asks whether the desk ran the rule correctly for 30 sessions. A session where the rule never ran
is not evidence of that.

**Effect on the counters:** they are recomputed from the journal, as always. In the six sessions read on
2026-10-08, the five with a decision summary all had their inputs, and the sixth (28 September) already
fails as an incident, so no session is known to change. The outcome `no_inputs` exists only from the runner
of 2026-10-08 onward; earlier sessions cannot be reclassified by it.

## 2. A day whose scan data failed records an error, not a session with no trades

**Was:** when the forward pool is built from a universe of zero, or no symbol has a pre-market bar, an empty
pool is saved, never rebuilt, and each trial that reads it writes a completed marker with zero trades. The
dry run showed the case on 1 October (universe 0 at every stage).

**Decision:**
1. `universe == 0` or `snapshot_symbols == 0` is a data failure: the pool is not saved, the units that need
   it write an error row and no marker, and the session is retried on the next run.
2. `kept == 0` with a real universe is a legitimate session and is recorded as now.
3. A collapse against the trailing median (universe, symbols with a bar, kept, Tier 1) raises an alert and
   blocks nothing.
4. Past rows are not rewritten. If the forward pool of a recorded session is found to have been built from a
   failed scan, the session is listed in a lessons-learned note as affected, and stays in the ledger.

**Why:** a data failure must not be readable as "no opportunity", and a session count is the denominator of
every forward statistic.

**Effect on the trials:** which sessions carry a marker can differ from before on failed days only. Their
trades cannot: a failed pool has no names.

## 3. Sigma from fewer than 14 valid sessions: no change

The desk and the forward test average the valid sessions among the last 14. The backtest averages the last
14 valid days, reaching further back when one is short. They agree when every session is whole.

**Decision:** leave all three as they are. The runner journals how many sessions its sigma used. Aligning
them belongs with DEC-0011's corrected re-runs, which already re-evaluate B.

**Why not now:** either alignment changes a calculation a recorded result depends on.

## 4. B acts on the first qualifying mark only: no change

**Decision:** this is strategy B version 1 as frozen. A first mark that was blocked or missed is the
session's only chance. Changing it is a new strategy version: a hypothesis, an experiment and a decision.

## 5. The dry run's stage times and the chart musts: no change

The dry run cannot see the last minutes before 09:25 on consolidated data, and the trend must failed for 20
of 23 candidate rows in the sessions read. The after-close record does not have the first limitation.

**Decision:** leave the stages and the musts as registered. Whether the funnel's selectivity is intended is
put to the owner once ten sessions of the counts of DEC-0023 section 2 exist, with those counts.

## 6. The spread check on B's entry: no change

`spread_or_no_quote` was journaled 29 times across six sessions (limit 0.10% on an IEX quote). It has not
been seen to block a signal.

**Decision:** leave the limit. Count, per session, the half-hour marks at which it was the only blocker;
bring the count back if any is non-zero. `config/risk.yaml` says a limit that can block an entry is changed
only by a decision record, and resets the gate's counters.

## What follows

- `src/wt/analytics/g2.py` reads the session's outcome (decision 1).
- `scripts/forward_test.py` and `scripts/build_pool.py` treat a failed scan as an error (decision 2), with
  the alerts of 2.3.
- The runner journals `sigma_sessions` (decision 3) and the count of decision 6.
- Nothing in this record is implemented by the pull request that carries it.
