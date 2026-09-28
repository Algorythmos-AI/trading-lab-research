# EXP-0007 — Liquid large-cap track (top-30 by ADV, $15–250), development span 2019-02 → 2025-09

**Trials:** 6 S3 configs + 12 S2 configs dropped after 150 sessions with 0 signals (DEC-0006) = 18.

| Family | OOS n | E[R] | CI95 | PF | yrs + | Gate |
|---|---|---|---|---|---|---|
| S3 VWAP pullback (walk-forward) | 42,577 | **−0.124** | [−0.135, −0.113] | 0.78 | 0/6 | **FAIL** |
| S2 extreme reversal | 0 signals in ~4,500 stock-days | — | — | — | — | not applicable to megacaps |

Diagnostics: ~70% of S3 trades exit at the initial stop; median MFE only +0.82R vs a 2R target; the
trail-only variant (M4) stops less but captures less. Conclusion: a 1-min VWAP-touch entry with a stop just
under VWAP sits inside normal large-cap noise. **Rejected; no further tuning** (would only add trials).
