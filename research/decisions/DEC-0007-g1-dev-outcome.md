# DEC-0007 — G1 development outcome and holdout use

- **Date:** 2026-09-28. **Global trials:** 65 (EXP-0005b 12, EXP-0007 18, EXP-0008 35).
- **Result:** no family passes the full G1 gate. Only **B (intraday momentum, QQQ→QQQM)** has OOS
  expectancy with CI95 above zero (+0.117R, [+0.038, +0.194], PF 1.44, 5/6 years), failing DSR (0.707 < 0.95).
  All KB-derived momentum families (S1 PM-high break −0.40R, S5 breakout-retest −0.14R, S3 VWAP −0.12R)
  are negative after realistic fills/costs; S1 bull flag inconclusive (n=131); S2 never triggers.
- **Holdout decision:** B's config is frozen (research/active_strategies/B_intraday_momentum_qqqm.yaml) and
  evaluated on the holdout (2025-09-26 → 2026-09-25) **exactly once** (EXP-0011). No other family is
  eligible (all failed dev). The holdout result is reported regardless of outcome and cannot be used
  to re-tune B.
- **Paper dress rehearsal** of B continues (forward, untouched data).
