# EXP-0005b — ETF track with realistic traded-ETF slippage (supersedes EXP-0005 for gating)

Cost model: 1¢ slippage per share on the *traded* ETF (SPYM ≈ SPY/7 → 7¢ in SPY units; QQQM ≈ QQQ/2.28 → 2.2¢).
Not a strategy trial (cost-model correction). Walk-forward OOS, global DSR (trials so far = 12):

| Family | OOS n | E[R] | CI95 | PF | DSR | yrs + | Gate |
|---|---|---|---|---|---|---|---|
| A ORB SPY→SPYM | 550 | −0.068 | [−0.181, +0.050] | 0.90 | 0.003 | 2/6 | FAIL |
| B momentum SPY→SPYM | 409 | +0.061 | [−0.018, +0.139] | 1.22 | 0.447 | 4/6 | FAIL |
| A ORB QQQ→QQQM | 553 | −0.007 | [−0.112, +0.104] | 0.99 | 0.037 | 4/6 | FAIL |
| **B momentum QQQ→QQQM** | 415 | **+0.117** | **[+0.038, +0.194]** | **1.44** | 0.897 | 5/6 | FAIL (DSR only) |

**Lesson (LL-0001):** "beats random entry" is a weak criterion when random entries carry heavy costs —
A/SPY "beats" its control with negative expectancy. The CI and DSR criteria carry the weight.
