# G1 walk-forward report — EXP-0008-g1-watchlist-dev

Dev span 2019-01-02 → 2025-09-25 (holdout 2025-09-26 → 2026-09-25 untouched). Trials counted for DSR: **65** (all configs evaluated).

## s1_pm_high_break

- OOS trades: 345; expectancy -0.404R; win 21%; PF 0.45; CI95 [-0.531690312215311, -0.2741810041298773]
- DSR prob 7.451829040594388e-09; years profitable 1/6; random-control p None
- Gate: {'ci_lower_gt_0': False, 'dsr_gt_0.95': False, 'pf_ge_1.2': False, 'random_control_p_lt_0.05': False, 'n_ge_100': True} → **FAIL**

## s1_bull_flag_5m

- OOS trades: 131; expectancy +0.084R; win 44%; PF 1.14; CI95 [-0.16907884612977475, 0.3353100267189219]
- DSR prob 0.04037938885340354; years profitable 4/6; random-control p None
- Gate: {'ci_lower_gt_0': False, 'dsr_gt_0.95': False, 'pf_ge_1.2': False, 'random_control_p_lt_0.05': False, 'n_ge_100': True} → **FAIL**

## s5_breakout_retest_pmh

- OOS trades: 1069; expectancy -0.140R; win 30%; PF 0.78; CI95 [-0.22148849438931745, -0.05289307033128789]
- DSR prob 1.9510714179210533e-07; years profitable 0/6; random-control p None
- Gate: {'ci_lower_gt_0': False, 'dsr_gt_0.95': False, 'pf_ge_1.2': False, 'random_control_p_lt_0.05': False, 'n_ge_100': True} → **FAIL**

## s2_extreme_reversal

- OOS trades: 0; expectancy +0.000R; win 0%; PF 0.00; CI95 None
- DSR prob None; years profitable None; random-control p None
- Gate: {'ci_lower_gt_0': False, 'dsr_gt_0.95': False, 'pf_ge_1.2': False, 'random_control_p_lt_0.05': False, 'n_ge_100': False} → **FAIL**
