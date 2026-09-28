# G1 walk-forward report — EXP-0005b-g1-etf-dev-realcost

Dev span 2019-01-02 → 2025-09-25 (holdout 2025-09-26 → 2026-09-25 untouched). Trials counted for DSR: **65** (all configs evaluated).

## A|SPY

- OOS trades: 550; expectancy -0.068R; win 35%; PF 0.90; CI95 [-0.18115163575447177, 0.05009836759888894]
- DSR prob 0.0002612827575357979; years profitable 2/6; random-control p 0.004975124378109453
- Gate: {'ci_lower_gt_0': False, 'dsr_gt_0.95': False, 'pf_ge_1.2': False, 'random_control_p_lt_0.05': True, 'n_ge_100': True} → **FAIL**

## B|SPY

- OOS trades: 409; expectancy +0.061R; win 50%; PF 1.22; CI95 [-0.01814084789898418, 0.1394605762947998]
- DSR prob 0.19612809166643735; years profitable 4/6; random-control p 0.004975124378109453
- Gate: {'ci_lower_gt_0': False, 'dsr_gt_0.95': False, 'pf_ge_1.2': True, 'random_control_p_lt_0.05': True, 'n_ge_100': True} → **FAIL**

## A|QQQ

- OOS trades: 553; expectancy -0.007R; win 36%; PF 0.99; CI95 [-0.11190146332770151, 0.1039507204160313]
- DSR prob 0.00634089598640301; years profitable 4/6; random-control p 0.12935323383084577
- Gate: {'ci_lower_gt_0': False, 'dsr_gt_0.95': False, 'pf_ge_1.2': False, 'random_control_p_lt_0.05': False, 'n_ge_100': True} → **FAIL**

## B|QQQ

- OOS trades: 415; expectancy +0.117R; win 57%; PF 1.44; CI95 [0.037844587355745675, 0.19393543650355644]
- DSR prob 0.7074144598935209; years profitable 5/6; random-control p 0.004975124378109453
- Gate: {'ci_lower_gt_0': True, 'dsr_gt_0.95': False, 'pf_ge_1.2': True, 'random_control_p_lt_0.05': True, 'n_ge_100': True} → **FAIL**
