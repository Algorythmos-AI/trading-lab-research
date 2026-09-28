# G1 walk-forward report — EXP-0014-r2-intraday-hod

Dev span 2019-01-02 → 2025-09-25 (holdout 2025-09-26 → 2026-09-25 untouched). Trials counted for DSR: **75** (all configs evaluated).

## HOD_bull_flag

- OOS trades: 277; expectancy +0.043R; win 37%; PF 1.06; CI95 [-0.13261877888297652, 0.23134685371081765]
- DSR prob 0.023806464292646087; years profitable 4/6; random-control p None
- Gate: {'ci_lower_gt_0': False, 'dsr_gt_0.95': False, 'pf_ge_1.2': False, 'random_control_p_lt_0.05': False, 'n_ge_100': True} → **FAIL**

## HOD_first_pullback

- OOS trades: 4173; expectancy -0.046R; win 34%; PF 0.93; CI95 [-0.08978089206462982, -0.0022712979962260333]
- DSR prob 4.384487163750508e-06; years profitable 2/6; random-control p None
- Gate: {'ci_lower_gt_0': False, 'dsr_gt_0.95': False, 'pf_ge_1.2': False, 'random_control_p_lt_0.05': False, 'n_ge_100': True} → **FAIL**
