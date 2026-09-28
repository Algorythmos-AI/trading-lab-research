# G1 summary (2026-09-28)

**Question:** does anything in the knowledge base, or the two published candidates, show a statistically
robust edge after realistic costs, tradable in a small long-only cash account on Webull AU?

**Answer so far: one modest candidate, no formal pass.**

| Family | Source | Dev OOS E[R] | Verdict |
|---|---|---|---|
| **B intraday momentum QQQ→QQQM** | published (Zarattini et al. 2024) | **+0.117R** (CI>0), holdout **+0.091R** | best candidate; fails DSR (0.707) |
| B via SPYM | published | +0.061R, CI spans 0 | costs of cheap ETF erase edge |
| A 5-min ORB (long) | published | ≈ 0 / negative | rejected |
| S1 pre-market-high break (Gap & Go) | KB (Warrior) | **−0.40R** | rejected |
| S1 bull flag 5m | KB (Warrior) | +0.08R, n=131, CI spans 0 | inconclusive (rare) |
| S5 breakout-retest | KB | −0.14R | rejected |
| S3 VWAP pullback | KB | −0.12R (42k trades) | rejected |
| S2 extreme reversal | KB | never triggers (gappers or megacaps) | not applicable |

**Why the KB momentum setups failed here (honest caveats):** entries were rule-based approximations of a
discretionary style (no Level-2/tape, no human judgement), stops are tight (20¢ cap / candle lows) so
spread+slippage and fake breakouts dominate, pre-market-only scanning misses intraday runners, and the
universe has residual survivorship bias (which would *flatter* results, not hurt them). The owner's own
trade history (profit factor 0.90, open window weakest) points the same way.

## Round 2 (DEC-0008 → DEC-0009)
| Hypothesis | Result |
|---|---|
| HYP-0009 B on IWM / DIA | −0.034R / +0.028R → falsified (B may be QQQ-regime specific) |
| HYP-0008 KB setups with ATR stops | bull flag ≈0, breakout −0.10R → falsified |
| HYP-0007 intraday HOD scanner | bull flag +0.13R full-span but **+0.043R walk-forward (CI spans 0)**; first pullback negative → falsified |

**Overall:** after 75 trials, nothing passes G1. B/QQQ remains the only candidate with CI>0 in development and a
positive holdout, but it fails DSR and does not generalise. Next evidence = forward (paper + nightly forward test).
