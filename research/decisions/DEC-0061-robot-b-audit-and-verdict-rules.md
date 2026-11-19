# DEC-0061: Robot B audit outcome, and the verdict rules fixed before the corrective re-runs

- **Status: ACCEPTED on 2026-11-19.** The owner accepted it in chat on 2026-11-19 ("accept DEC-0061 and start the
  re-runs"), after #510 merged. The re-runs in section 3 are registered after this line, in the same pull request.
- **Amends nothing.** No rule, exit, size, limit, gate, latch or stop line of B changes; no file the runner reads is
  edited. B v1 stays frozen (`research/active_strategies/B_intraday_momentum_qqqm.yaml`) and keeps paper trading.
- **Depends on:** DEC-0007 (G1), DEC-0011 (R-C1 and the owed re-runs), DEC-0023 and DEC-0037 (G2, stop rule).
- **Experiment:** EXP-0042 (descriptive; no hypothesis, no trial). The global trial count stays at 87.

## Why

The audit (EXP-0042 `report.md`) finds that B's only evidence is the pre-correction development record; that the
DEC-0011 re-runs ordered on 2026-10-25 were never registered; that R-C1 reaches about two-thirds of B's trades through
its volatility window; that G1's deflated Sharpe at the trial count in force is 0.669 (G1 needs > 0.95); and that the
paper record cannot tell B's claimed edge from zero in useful time. Before any corrected number is seen, the way the
corrected numbers will be read is fixed here, so the verdict cannot be fitted to them.

## Decision

### 1. Provisional verdict: SUSPEND research investment in B v1

No tuning, filter or exit change to v1 is researched. Paper trading continues unchanged under G2a and the DEC-0037
stop line, as an execution and plumbing check; it is not evidence of edge.

### 2. The verdict rules (frozen by this record)

**Inputs.** Only the G1 gate as `scripts/g1_eval.py` already computes it, unchanged: the family `B|QQQ`, walk-forward
pooled out-of-sample trades, `--method dec0011` (DSR at the registry's global trial count, day-block CI95), with the
random-control p taken against the corrected controls. That is EXP-0044's `g1_eval_dec0011.json` → `B|QQQ` → `gate`
and `stats`, with EXP-0046 as its control experiment. Nothing new is computed for the verdict. The gate items are
DEC-0007's: `ci_lower_gt_0`, `dsr_gt_0.95`, `pf_ge_1.2`, `random_control_p_lt_0.05`, `n_ge_100`.

**Rows** (exactly one of V1–V3 holds; then the caps apply; the most severe outcome wins):

| # | Condition (EXP-0044 gate, control from EXP-0046) | Verdict |
|---|---|---|
| V1 | any of `ci_lower_gt_0`, `pf_ge_1.2`, `random_control_p_lt_0.05`, `n_ge_100` is false | **ABANDON** v1. Later intraday-momentum work starts as a new hypothesis on sessions after 2026-09-25 |
| V2 | those four are true and `dsr_gt_0.95` is false | **SUSPEND** stands. A **REDESIGN** may be proposed only as a new hypothesis (EXP-0042 backlog H4 or H8), judged on sessions after 2026-09-25 |
| V3 | all five are true | **REFINE** path opens; promotion still needs G2 (DEC-0037) and the owner |

| Cap | Condition | Effect |
|---|---|---|
| C1 (DEC-0011 §3) | EXP-0045's re-scored holdout mean is below the recorded +0.091R and its CI95 lower bound is ≤ 0 | the verdict can be no better than V2 |
| C2 | EXP-0048 has not been read | no promotion step is taken, whatever V3 says. Its statistic, minimum sample and threshold are fixed in its own registration, before it is read |

EXP-0043 (data-only re-run, legacy method) and EXP-0047 (IWM/DIA) are descriptive and feed no row; they are reported
beside the verdict.

**Which outcome Stage 0 makes likely.** V3 needs a DSR above 0.95 at 87 trials. At B's recorded moments that is a
per-trade Sharpe near 0.19 at this sample size, or about 890 trades at the recorded Sharpe; the development span gives
415. V3 is therefore unlikely, though not excluded, because R-C1's effect on the volatility band is untested. The live
question is V1 versus V2.

### 3. Owed work, in this order (each registered with a manifest before it runs)

1. The DEC-0011 re-runs under the next free ids (planned EXP-0043 to EXP-0047): data-only re-run of EXP-0005b;
   corrected method of EXP-0005b; holdout re-score; controls re-run; IWM/DIA re-run.
2. A paper execution audit (planned EXP-0048), aggregates only on the dashboard.
3. Stop-line operating characteristics (planned EXP-0049): how often the −6.0R line and the 30-trade review fire with
   no edge and with the corrected edge.
4. A record that applies section 2 mechanically.

### 4. What the dashboard shows

The Robot B page shows ids, statuses, dates, counts, R, intervals and statistics from EXP-0042, the G1 record and the
snapshot: that the evidence is pre-correction, the G1 items against their lines, and how many trades the paper record
would need. No text from this record or the report is published.

## Disclosure

- Seen before this record was written: all of EXP-0042's outputs and its adversarial review; the recorded EXP-0005,
  EXP-0005b, EXP-0006b and EXP-0011 summaries and the per-trade development results; the forward archive's published
  scorecards (the paper aggregate of 9 trades and the forward test's 8 trades); the dashboard's G2 and stop-rule lines.
- Not seen: any corrected (de-duplicated) result of B; any paper or forward per-trade R beyond the published
  aggregates; any session after the 2026-11-13 scorecard.
- The corrected data overlaps heavily with what was seen. The rows therefore use only the G1 items and DEC-0011 §3,
  which predate this record. A first draft read the frozen rule over the whole span (more lenient: DSR 0.708 against
  the G1 series' 0.669); review caught it, and the rows were moved to the series G1 already gates.
