# EXP-0005 / EXP-0006 — ETF track, development span (2019-01-02 → 2025-09-25), interim

**Trials:** 12 configs (A: 4 variants × 2 symbols; B: 2 variants × 2 symbols). Holdout untouched.

## Walk-forward (fit 12m → test 3m, rolling), out-of-sample
| Family | OOS n | E[R] | CI95 | PF | vs random p | DSR | yrs + |
|---|---|---|---|---|---|---|---|
| A ORB SPY | 550 | +0.034 | [−0.080, 0.152] | 1.06 | 0.030 | 0.14 | 5/6 |
| A ORB QQQ | 545 | +0.015 | [−0.097, 0.125] | 1.02 | 0.264 | 0.08 | 4/6 |
| **B momentum SPY** | 409 | **+0.121** | [0.041, 0.201] | 1.48 | 0.005 | 0.915 | 5/6 |
| **B momentum QQQ** | 415 | **+0.128** | [0.048, 0.205] | 1.48 | 0.005 | 0.936 | 5/6 |

## Cost stress (full dev span, B, fixed 2R target M3)
- On SPY/QQQ bars with 1¢ slippage: robust (SPY +0.114 → +0.095R at 2×; QQQ +0.128 → +0.112R at 2×).
- **At slippage equivalent to trading the affordable ETFs** (1¢ on SPYM ≈ 7¢ on SPY; 1¢ on QQQM ≈ 2.2¢ on QQQ):
  - **B via SPYM: +0.049R (1×), +0.007R (1.5×), −0.029R (2×) → FAILS the 1.5× cost gate.**
  - **B via QQQM: +0.115R (1×), +0.101R (1.5×), +0.087R (2×) → passes cost stress.**

## Interim conclusions (not a G1 pass)
- A (5-min ORB, long-only) shows no reliable edge → deprioritised.
- **B on QQQ→QQQM is the leading candidate**: positive OOS, CI>0, beats random entry, cost-robust, 5/6 years.
  Still **fails DSR (0.936 < 0.95)**, and DSR will fall further as more global trials are added (S1/S5).
- Next: small-account viability (QQQM integer shares at US$600/1k/2k), per-year/regime breakdown,
  event-day policy, then the single holdout run once all candidate families are frozen.

## Small-account viability — B via QQQM (QQQ bars ÷ 2.28, 1¢ slippage, 1% risk, integer shares, cash-capped)
| Equity | Trades | Skipped (qty<1/no fill) | E[R] | Median realised risk vs intended | Simulated P&L over dev span | Avg per trade |
|---|---|---|---|---|---|---|
| US$600 | 483 | 11 | +0.112 | 0.52 | +US$163 | +US$0.34 |
| US$1,000 | 483 | 11 | +0.112 | 0.57 | +US$282 | +US$0.59 |
| US$2,000 | 483 | 11 | +0.112 | 0.58 | +US$579 | +US$1.20 |

Edge in R survives integer shares, but the **cash cap limits realised risk to ~55% of intended** (tight
VWAP-based stops vs ~US$250 QQQM price), so dollar outcomes are small: ~US$24/year at US$600 over the
dev span. Viability depends on $0 commission (confirmed April 2026). Honest read: even if B passes G1,
at US$600 it is a *proof-of-process* account, not an income stream.
