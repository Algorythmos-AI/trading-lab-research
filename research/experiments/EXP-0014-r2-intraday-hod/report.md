# EXP-0014 (HYP-0007) — intraday HOD-momentum scanner (causal: +10%, $2–30, RVOL_t ≥5×, 09:45–11:30)

| Config (full dev span) | n | E[R] | CI95 | PF | yrs + |
|---|---|---|---|---|---|
| runner + 5m bull flag (ATR stop), M1 | 310 | +0.130 | [−0.054, +0.317] | 1.20 | 5/7 |
| runner + 5m bull flag (ATR stop), M3 | 310 | +0.106 | [−0.061, +0.268] | 1.16 | 5/7 |
| runner + first 1m pullback, M1 | 4,508 | −0.065 | [−0.109, −0.017] | 0.91 | 2/7 |
| runner + first 1m pullback, M3 | 4,508 | −0.032 | [−0.074, +0.009] | 0.95 | 4/7 |

**Walk-forward (M1/M3 chosen each quarter from the prior 12 months):** bull flag OOS n=277, **+0.043R**,
CI [−0.133, +0.231], PF 1.06, DSR 0.02 (75 trials) → **FAIL**. First pullback −0.046R → FAIL.
**HYP-0007 falsified as a robust edge.** Weak positive signal for the bull flag on genuine intraday runners
(consistent with KB "stocks in play"), but not distinguishable from zero with 277 trades.
