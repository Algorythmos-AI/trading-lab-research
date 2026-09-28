# G1 combined development report

Global trials counted for DSR: **65** across ['EXP-0005b-g1-etf-dev-realcost', 'EXP-0007-g1-liquid-dev', 'EXP-0008-g1-watchlist-dev']. Holdout 2025-09-26 → 2026-09-25 untouched.

| Family | OOS n | E[R] | CI95 | PF | DSR | random-control p | years + | Gate |
|---|---|---|---|---|---|---|---|---|
| A|SPY | 550 | -0.068 | [-0.181, +0.050] | 0.90 | 0.000 | 0.004975124378109453 | 2/6 | FAIL |
| B|SPY | 409 | +0.061 | [-0.018, +0.139] | 1.22 | 0.196 | 0.004975124378109453 | 4/6 | FAIL |
| A|QQQ | 553 | -0.007 | [-0.112, +0.104] | 0.99 | 0.006 | 0.12935323383084577 | 4/6 | FAIL |
| B|QQQ | 415 | +0.117 | [+0.038, +0.194] | 1.44 | 0.707 | 0.004975124378109453 | 5/6 | FAIL |
| S3 | 42577 | -0.124 | [-0.135, -0.113] | 0.78 | 0.000 | None | 0/6 | FAIL |
| s1_pm_high_break | 345 | -0.404 | [-0.532, -0.274] | 0.45 | 0.000 | None | 1/6 | FAIL |
| s1_bull_flag_5m | 131 | +0.084 | [-0.169, +0.335] | 1.14 | 0.040 | None | 4/6 | FAIL |
| s5_breakout_retest_pmh | 1069 | -0.140 | [-0.221, -0.053] | 0.78 | 0.000 | None | 0/6 | FAIL |
| s2_extreme_reversal | 0 | +0.000 | [+0.000, +0.000] | 0.00 | 0.000 | None | None | FAIL |
