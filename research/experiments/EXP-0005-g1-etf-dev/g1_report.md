# G1 walk-forward report — EXP-0005-g1-etf-dev

Dev span 2019-01-02 → 2025-09-25 (holdout 2025-09-26 → 2026-09-25 untouched). Trials counted for DSR: **12** (all configs evaluated).

## A|SPY

- OOS trades: 550; expectancy +0.034R; win 36%; PF 1.06; CI95 [-0.07955173752717219, 0.15179042042927976]
- DSR prob 0.13785372972514592; years profitable 5/6; random-control p 0.029850746268656716
- Gate: {'ci_lower_gt_0': False, 'dsr_gt_0.95': False, 'pf_ge_1.2': False, 'random_control_p_lt_0.05': True, 'n_ge_100': True} → **FAIL**

## B|SPY

- OOS trades: 409; expectancy +0.121R; win 55%; PF 1.48; CI95 [0.04061256226756899, 0.2008876172923819]
- DSR prob 0.9152975794016527; years profitable 5/6; random-control p 0.004975124378109453
- Gate: {'ci_lower_gt_0': True, 'dsr_gt_0.95': False, 'pf_ge_1.2': True, 'random_control_p_lt_0.05': True, 'n_ge_100': True} → **FAIL**

## A|QQQ

- OOS trades: 545; expectancy +0.015R; win 36%; PF 1.02; CI95 [-0.09728855299079368, 0.1248243629112557]
- DSR prob 0.07855806220141624; years profitable 4/6; random-control p 0.263681592039801
- Gate: {'ci_lower_gt_0': False, 'dsr_gt_0.95': False, 'pf_ge_1.2': False, 'random_control_p_lt_0.05': False, 'n_ge_100': True} → **FAIL**

## B|QQQ

- OOS trades: 415; expectancy +0.128R; win 57%; PF 1.48; CI95 [0.048356247689091685, 0.20491928368056764]
- DSR prob 0.9364959457896179; years profitable 5/6; random-control p 0.004975124378109453
- Gate: {'ci_lower_gt_0': True, 'dsr_gt_0.95': False, 'pf_ge_1.2': True, 'random_control_p_lt_0.05': True, 'n_ge_100': True} → **FAIL**
