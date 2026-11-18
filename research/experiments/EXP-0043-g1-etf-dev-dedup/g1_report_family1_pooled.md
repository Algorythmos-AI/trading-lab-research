# G1 walk-forward report — EXP-0043-g1-etf-dev-dedup

Dev span 2019-01-02 → 2025-09-25 (holdout 2025-09-26 → 2026-09-25 untouched). Trials counted for DSR: **12** (all configs evaluated).

## A

- OOS trades: 532; expectancy +0.004R; win 36%; PF 1.01; CI95 [-0.11200440255560895, 0.12029095368743725]
- DSR prob 0.054762103070815256; years profitable 3/6; random-control p 0.04488778054862843
- Gate: {'ci_lower_gt_0': False, 'dsr_gt_0.95': False, 'pf_ge_1.2': False, 'random_control_p_lt_0.05': True, 'n_ge_100': True} → **FAIL**

## B

- OOS trades: 419; expectancy +0.106R; win 55%; PF 1.39; CI95 [0.02719016250966951, 0.18360541484544274]
- DSR prob 0.840447884844129; years profitable 5/6; random-control p 0.0024937655860349127
- Gate: {'ci_lower_gt_0': True, 'dsr_gt_0.95': False, 'pf_ge_1.2': True, 'random_control_p_lt_0.05': True, 'n_ge_100': True} → **FAIL**
