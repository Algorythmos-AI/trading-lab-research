# Stocks desk forensic audit, 8 October 2026

Scope: why the stocks desk has placed no order, what the scanner sees, and what has to be true before learning is
added. Code read at `630e6f1`. Host evidence was read by the owner on `trading-lab-host` on 8 October 2026 at
10:22 UTC with three read-only commands (`make status`, `git rev-parse HEAD`, a counts-only tally of
`var/routine`, `data/live/journal.jsonl` and `var/forward/forward_trades.jsonl`). Counts, ids, statuses and dates
only; no profit figure was read for this document.

## Verdict

1. The desk cannot trade small caps. The only strategy that can place an order is B: signals on QQQ, orders on QQQM.
2. B was held off by the kill switch through 5 October, when its one would-be signal was blocked. On 6 and 7
   October it ran with entries possible and its inputs present, and the rule did not fire. That is a true "no signal".
3. The ten small-cap trials produced no hypothetical trade in 8 forward sessions. In the live dry run, 0 to 3 names
   a day passed the hard filters and none passed the chart musts on any day.
4. One session (1 October) scanned a universe of zero and was recorded as a normal day.
5. Nothing records why a name was rejected, so point 3 cannot be explained further from the evidence that exists.

## A. Architecture found

| Path | What it does | Can place an order |
|---|---|---|
| `src/wt/live/runner_b.py` (job `paper-b`) | Strategy B on the Alpaca paper account; `SIG, TRADE = "QQQ", "QQQM"` (`:57`), allowlist `[QQQM]` (`config/risk.yaml:4`) | Yes, the only one |
| `scripts/premarket_routine.py` (job `routine`) | Small-cap dry run at 08:00, 08:30, 09:00, 09:15 and 11:31 New York; no broker calls | No |
| `scripts/forward_test.py` (job `forward`) | Nightly re-simulation of B and the ten round-3 trials (HYP-0010..0019) into a hash-chained ledger | No |

The price band "US$2 to US$20" is in no config. The registered bands are US$1-20 (spec funnel), US$2-30 (baseline)
and US$1-30 (pool) (`config/generated/ranking_warrior.yaml`, `config/ranking.yaml`, `src/wt/scanner/pool.py:76`).

## B. Deployment state

- Host checkout: `9f04c8019f848739e6383c0319e38928ffd3e2b0`, on main, clean, venv synced, 24.0 GB free.
- Kill switch: off. No `KILL` file.
- Last stocks runs (7 October): `routine`, `paper-b`, `forward`, all exit 0, all on `2d098f5`, which contains the
  entry fix of PR 73. No stocks job has yet run on `9f04c80`.
- `weekly` last ran on 3 October on `ab9cd22`.
- `make status` run by hand reported `.env missing` and `NTFY_TOPIC is empty`. Unverified: a hand-run command does
  not load the host's secrets file, so this may not reflect the scheduled jobs. To be confirmed by the owner.
- The Mac runs nothing: no `com.wt.*` agent is loaded. `AGENTS.md` and `README.md` still describe the Mac.

## C. Scanner funnel, live dry run (as seen), last stage of each session

| Session | Feed | Universe | With a pre-market bar | Kept (band and gap) | Passed hard filters (Tier 1) | Passed chart musts (Tier 2) | Tickets |
|---|---|---|---|---|---|---|---|
| 28 Sep | iex | 4393 | 48 | 8 | 1 | 0 | 0 |
| 29 Sep | hybrid | 4357 | 809 | 37 | 3 | 0 | 0 |
| 30 Sep | no files (job refused: disk below floor) | | | | | | |
| 1 Oct | hybrid | **0** | 0 | 0 | 0 | 0 | 0 |
| 2 Oct | hybrid | 4354 | 944 | 42 | 0 | 0 | 0 |
| 5 Oct | hybrid | 4351 | 830 | 44 | 1 | 0 | 0 |
| 6 Oct | hybrid | 4357 | 883 | 31 | 3 | 0 | 0 |
| 7 Oct | hybrid | 4335 | 837 | 11 | 2 | 0 | 0 |

Chart musts for the Tier 1 names, summed over every stage file that lists them (23 name-stage rows):
`trend_ok` 3, `window_ok` 5, `pm_consolidation` 1, `suspect_split` 3, `chart_ok` 0.

Observations:

- Tier 1 is capped at 20; the hard filters let through 0 to 3. Which filter removes the other 9 to 47 kept names is
  not recorded: `funnel()` returns the reasons (`src/wt/scanner/ranking.py:174`) and the routine does not write them.
- `pm_consolidation` needs a bar starting 09:10-09:24 (`src/wt/scanner/checklist.py:74-83`). The last stage cuts at
  09:15 and SIP data reached only 09:00 at that stage on every day, so the check ran on the sparse feed. It was true once.
- `trend_ok` was true for 3 of 23 rows, so the timing of the stages is not the only reason Tier 2 is empty.
- On 28 September the first stage saw 0 symbols on the IEX-only feed.
- There is no US$2-20 count; the stage files do not carry price-band counts.

## D. Why trades did or did not occur

Strategy B, from the journal (6 armed sessions):

| Session | Outcome recorded | Inputs present | Would-be signals | Note |
|---|---|---|---|---|
| 28 Sep | none (older code) | not recorded | not recorded | 3 loop errors |
| 1 Oct | none | yes | 0 | |
| 2 Oct | none | yes | 0 | |
| 5 Oct | none | yes | 1 | blocked; the kill switch was on |
| 6 Oct | `no_signal` | yes | 0 | |
| 7 Oct | `no_signal` | yes | 0 | |

Blocker codes journaled across all sessions: `kill_file` 77, `spread_or_no_quote` 29, `stale_signal_data` 6,
`event` 2. These count journal rows, not minutes. `spread_or_no_quote` recurs often enough to check before it
blocks a real signal (limit 0.10% on an IEX quote, `runner_b.py:63, 775`).

Forward ledger: B has 7 sessions and 2 hypothetical trades. Each of the ten round-3 trials has 8 sessions and 0
trades. No error rows.

## E. Software defects

| Grade | Defect | Evidence |
|---|---|---|
| P1 | A universe of zero is written as a normal scan, and in the forward test an empty pool is saved, never rebuilt, and yields zero-trade markers for every trial | 1 October stage files; `pool.py:128-129,204`; `forward_test.py:182-186,245-246` |
| P1 | Rejection reasons are computed and discarded in the routine and the forward test | `ranking.py:174`; `premarket_routine.py:108-119`; `scripts/r3_run.py:89-97`; `forward_test.py:265-277` |
| P1 | Missing inputs end B's session as `no_signal`: NaN sigma from zero valid sessions, empty bars | `runner_b.py:133-140, 388, 410-411`. Not seen in these six sessions |
| P2 | A signal with no QQQ quote ratio is dropped with no journal row | `runner_b.py:798` |
| P2 | Dashboard health is green on process exit codes; it reads no scan, data or limit state | `dashboard/src/lib/health.ts:33-111` |
| P2 | The quote lookup swallows every error, and an unknown spread then passes the baseline filter | `src/wt/scanner/features.py:171-172`; `ranking.py:47` |
| P3 | `tickets()` falls back to a default account on any error; pool build failures are printed only | `premarket_routine.py:131-133`; `scripts/build_pool.py` |
| P3 | Sigma has three implementations | `runner_b.py:131-140`; `forward_test.py:387-393`; `scripts/g1_etf.py:48` |

PR 73 (before this audit) fixed the P0: B could never place an entry.

## F. Strategy constraints (not defects)

- B acts only on the first qualifying half-hour mark of a session, and only if nothing blocks it at that mark.
- The spec funnel needs a known float, a qualifying catalyst, 200 daily bars and the chart musts. On the evidence
  in C this passes almost nothing. Whether that is the intended selectivity is an owner question.
- G1 failed after 75 trials; round 3 is registered (DEC-0010) with no recorded result; DEC-0011 is proposed.

## G. Data

- Provider: Alpaca only. The free plan withholds the last 15 minutes of SIP; the gap is filled from IEX, whose
  volume is understated (`src/wt/data/alpaca.py:156-209`). Stage files show SIP 15 minutes behind at every stage.
- Splits are handled as-of (`src/wt/data/corpactions.py`); `suspect_split` fired on 3 rows.
- Quality checks today: duplicate keys only (`src/wt/data/quality.py`).

## H. Backtest, forward and paper differences

Live B signals from IEX bars, trades QQQM through a price ratio, has no stop-before-trigger cancel and exits on a
20-second poll; the simulation uses SIP, QQQ prices and touch fills. Paper-versus-forward agreement is measured
by day only (`src/wt/analytics/g2.py:16-18`). The dry run and the forward pool see different data (C above), so
their funnels must not be merged.

## I. Dashboard

Scan counts and candidates are shown; reasons, near misses, data state and a small-cap board are not. The top
banner is process-level (E).

## J and K. Readiness for learning

- B: about 480 development trades, a 57-trade holdout already used, 2 forward trades.
- Small caps: 0 forward trades; round 3 not yet evaluated.
- The validation code needs 200 training examples per fold (`src/wt/ml/validate.py:18-20`).
- **Machine learning: not justified yet. Deep learning: not justified yet.**

## L, M. Architecture and plan

As approved on 8 October 2026: pin the frozen functions (done, PR 114); outcome wording (done, PR 115); runner
labelling; a funnel explainer beside the frozen functions with per-rule counts and a US$2-20 count; a forward
sidecar of record; data flags; parity tests; per-trial books as views over the forward ledger; dashboard
extensions; learning only at a pre-registered sample checkpoint.

## N. Risks

- Instrumentation that changes selection: guarded by the goldens of PR 114.
- Any result split by price band or by rejected group is a new trial and needs its own record.
- Restricted fields (`setup`, headlines, catalyst categories) sit one column away from the snapshot.

## O. Owner decisions

1. Is the selectivity in C intended, or should the chart musts or the stage times change (decision record)?
2. Should a session with missing inputs count as a clean G2 session? Should a data-failure day write no marker?
3. DEC-0011: approve or amend. Round 3: run.
4. Is `NTFY_TOPIC` set for the scheduled jobs on the host?
5. Paid real-time SIP data, the only route to judging small caps in real time.

## P. Where the plan stands, 11 October 2026

Added after the work of section L was carried out. Statuses and pull request numbers only. "Open" means the pull
request exists with its checks passing and waits for the owner's merge.

| Plan item | Carried by | Status |
|---|---|---|
| Frozen functions pinned by goldens and source hashes | PR 114 | Merged |
| Runner truthfulness: `no_inputs`, a journal row when inputs are absent, a logged skip on a missing quote | PRs 115, 122 | Merged |
| DEC-0023 (evidence charter) and DEC-0024 (clean sessions, data-failure days) | PR 126 | Merged, accepted |
| A no-input session is not a clean G2 session | PR 127 | Merged |
| A scan with no data is an error, not a day without trades; thin-scan alert | PRs 128, 139 | Merged |
| Funnel explainer beside the frozen functions; US$2-20 counts | PR 117 | Merged |
| Dry run records reasons; forward funnel of record beside the ledger | PRs 117, 119 | Merged |
| `sigma_sessions`, `marks`, `spread_only_marks` in the journal | PR 134 | Merged |
| Dry run against the record, in counts: tiers, first pick, signals | PRs 135, 138, 139 | Merged |
| A book per registered trial from the forward ledger | PR 129 | Merged |
| Sealed shadow outcomes for signals admission refused; the resolved count on the books | PRs 136, 137 | Merged |
| Sessions left out of G2 shown on the Risk page | PR 140 | Merged |
| Data-quality counts for each scan, record only; dry-run pages on a failed or IEX-only scan | PR 168 | Open |
| Strategy B replayed on recorded bars beside the runner's journal | PR 174 | Open |
| Near misses, the funnel of record and the scan strip on the dashboard; banner rules for a failed scan and the loss limits | PR 173 | Open |
| Pins on the learning code's shared pieces | PR 169 | Open |
| `wt.ml.examples`; the scorer takes the inputs' identity | PR 170 | Open |

### Not done, and why

| Plan item | Reason |
|---|---|
| One shared `sigma_and_prev_close` for the runner, the forward test and the backtests | DEC-0024, decision 3: the three calculations stay as they are until DEC-0011's re-runs. `tests/unit/test_b_parity.py` holds where they agree and where they part |
| Counts of stale and missing bars | Neither can be counted without a threshold, and a threshold is a rule |
| A stocks dataset, labels, models, shadow scoring (plan F3 onward) | Gated: after the round-3 result is recorded and an owner decision. Forward outcomes for the small-cap trials: 1 trade in 10 sessions |
| G2 reading the replay record | It would redefine a gate measure: a decision record first |

### Corrections to this document

- Section B said `forward` "ran" on the host at a time that read as mid-session on the dashboard. That is by
  design: the unit starts at 12:40 New York, before the earliest early close, and waits until 20 minutes after the
  close (`src/wt/ops/schedule.py`).
- Verdict 5 ("nothing records why a name was rejected") no longer holds: the dry run and the forward test both
  record it, in counts.

### First session on the new code (9 October 2026, read from the dashboard)

- Dry run: universe 4,328 at every stage, 29 names gapping at 09:15, 0 passed every filter, no failed scan.
- Paper B: armed, entries allowed, no signal, no trade. Clean G2 sessions 4 of 30; sessions left out for missing inputs 0.
- Trial books: 10 sessions for each small-cap trial; signals 0, refused 0, shadow outcomes resolved 0.

### Owner decisions still open

1. DEC-0011: approve or amend, then run its re-runs and round 3. The ids it names are taken (see its closing note).
2. Whether the funnel's selectivity is intended: due once ten sessions of the funnel counts exist (DEC-0024, decision 5).
3. A spread limit for B: only if `spread_only_marks` is ever above zero (DEC-0024, decision 6).
4. Whether G2's agreement measure should read the replay record.
5. Paid real-time consolidated data, the only route to judging small caps in real time.
6. The thin-scan alert's thresholds (half the median of ten pools; five pools before it speaks) were chosen in PR 128 and never confirmed.
