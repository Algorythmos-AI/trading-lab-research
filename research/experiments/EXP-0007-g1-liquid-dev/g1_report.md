# G1 walk-forward report — EXP-0007-g1-liquid-dev

Dev span 2019-01-02 → 2025-09-25 (holdout 2025-09-26 → 2026-09-25 untouched). Trials counted for DSR: **65** (all configs evaluated).

## S3

- OOS trades: 42577; expectancy -0.124R; win 31%; PF 0.78; CI95 [-0.13532739060492935, -0.11255398054183348]
- DSR prob 3.708969501912941e-103; years profitable 0/6; random-control p None
- Gate: {'ci_lower_gt_0': False, 'dsr_gt_0.95': False, 'pf_ge_1.2': False, 'random_control_p_lt_0.05': False, 'n_ge_100': True} → **FAIL**
