# EXP-0048 report: Robot B paper execution against the backtest fill model

- Ran from 3492c01 (the registration commit, tree clean; `manifest.json`).
- **Snapshot:** taken read-only from the cloud host on 2026-11-19, cut at the 2026-11-18 session.
- **Reconciliation:** reproduced the registered published aggregate exactly (9 trades, −3.29R, 36 armed sessions).
- **Hash chain:** the journal's chain is intact.
- **Determinism:** `--check` reproduces `results.json` byte for byte.

Every figure below is in `results.json` unless it is marked *post hoc*.

## 1. The finding: two "target" exits booked far below the target

Both trades the runner closed as `target` were booked well below their target price: 1.82R below on average (sd
0.06R). A resting target limit cannot do that.

Read the 1.82R as a measurement against the fill model, not as R lost. The model's target fill assumes price
reached the target. Here it probably did not, so what those two trades would otherwise have made is unknown.

**What the code shows** (`src/wt/live/runner_b.py:805`):

- The target exit fires when the QQQM **mid** reaches the target.
- It then sells with a limit at **bid − $0.01**.
- The quote is IEX's latest quote (`LiveData.quote`), with no spread check and no age check.
- The entry path has both checks: it blocks on `spread_or_no_quote` and `stale_signal_data`. The exit trigger has
  neither.

**Two explanations remain open.** The records cannot tell them apart; the journal does not store the quote, and the
snapshot has no broker order fills.

1. **A wide or stale IEX quote** put the mid above the target while the bid sat far below it. The exit then sold at
   that bid.
2. **A partial stop fill was averaged into the exit price.** `exit_fill` averages over every sell order of the plan.
   Each of the two trades had two sell orders: its stop and its exit.

**Post hoc, unregistered checks** (consistency checks only, run after the results were read):

- The journal's exit price, the plan's `exit_fill_price` and the plan log's `closed` price agree on both trades.
- Each plan's target is exactly trigger + 2R.
- The two hold times were 1.1 minutes and 79 minutes. A 2R move in QQQM within about a minute of entry is very
  unlikely, which supports explanation 1 for at least one trade.

**What it means for B:**

- **The verdict does not change.** No rule of B changes because of this record (DEC-0011 §3), and the verdict stays
  SUSPEND (DEC-0062: V2 and C1 bind; this record lifts C2).
- **The −3.29R paper total and the stop-line meter carry this defect.** The G2b sample does too, while B keeps
  trading paper.
- **Hotfix candidate for the owner:** give the target exit the entry's quote guards (a spread ceiling and a quote age
  limit), and sell only when the bid itself is at or above the target. That is a change to the runner, so it needs
  the owner's decision and its own record.
- **Separate experiment:** a registered EXP could estimate what the two trades would have made. It would need QQQM
  bars or the forward book.

## 2. Entries match the model closely

| Measure | n | Mean | CI95 |
|---|---|---|---|
| Entry shortfall vs model (R) | 9 | +0.028 | [+0.002, +0.057] |
| Entry slip vs trigger (bps) | 9 | +2.1 | [+0.4, +3.9] |
| Model's own slip (R) | 9 | +0.005 | |

- All 9 entries filled inside the collar (trigger + 0.1R).
- The shortfall is an upper bound, because the gap term is not measurable without QQQM bars.
- The excess over the model, about 0.02R a trade, is a cost the backtest does not charge. It is small next to B's
  claimed +0.11R edge. At n = 9, the smallest mean this sample could tell from zero is 0.042R.

## 3. Other exit legs

**Stops (2 trades).** The exits were 0.010R worse than the model's stop − slip, about one model slip more.

**Flattens (5 trades).** These cannot be measured as registered (no QQQM bar).

- All five had exit-path incidents: 5 `exit_failed` notes, all "sell exceeds available", plus 4 `exit_deferred` and
  4 `exit_unfilled_restopped`.
- The flatten sell is refused while the stop still reserves the shares. The runner re-stops and retries.
- The trade closed a median of 57 seconds after the flatten time (mean 64 s, CI95 [46, 89] s).

**Round trip.** This figure (n = 4, mean +0.94R) is dominated by the two target legs and is not used.

**Disclosure.** With two trades in a leg, the mean and sd recover both values, so the stop and target legs are
effectively per trade. That contradicts the README's "nothing per trade" line. They are execution measures, and the
trades are already on the /robot-b blotter.

## 4. Latency

- **Signal bar close to entry placed:** median 15.5 s (n = 8; one entry had no matching decision row).
- **Entry placed to fill journaled:** median 121 s. This is a resting stop-limit waiting for its trigger, not order
  latency.

## 5. Sessions, blockers and faults

These are counts over 36 armed sessions (`unarmed_rows` are lease and no-session rows, not failed sessions).

**Blocked marks:**

| Blocker | Marks | Sessions |
|---|---|---|
| stale_signal_data | 39 | 36 |
| kill_file | 35 | 3 |
| spread_or_no_quote | 25 | 17 |
| event | 3 | 3 |

`stale_signal_data` appears in every session. It is most likely the open mark, before the first closed bar arrives,
but this record did not check the timestamps, so it is not called a fault.

**Faults:**

| Fault | Rows | Sessions |
|---|---|---|
| decision_inputs_missing | 29 | 29 |
| loop_error | 11 | 6 |
| reconcile | 6 | 5 |
| data_timeout | 4 | 3 |

There were none of clock_skew, broker_connect_failed, persist_failed, refuse_to_arm, or entries skipped for size or
quote.

## 6. Replay agreement

- **Replay vs journal:** 28 records. 27 agree (8 same signal bar, 19 neither), 1 is `only_second` (the runner
  journaled a signal the replay did not reach) and 0 differ.
- **Forward vs replay:** 28 of 28 agree.
- **Gaps:** 8 armed sessions have no replay record.
- **Scope:** agreement is measured at the entry bar only, so it cannot see the exit defect in section 1. It is
  reported, not fed to G2.

## 7. What this sample cannot say

- With 9 trades, no leg can separate small execution costs from zero except the entry shortfall, whose CI excludes
  zero.
- Nothing here bears on whether B has an edge.
- Not measured: the flatten leg, the entry and stop gap terms, and the counterfactual for the two target exits.
