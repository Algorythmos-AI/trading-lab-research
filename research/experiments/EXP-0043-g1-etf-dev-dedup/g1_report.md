# G1 walk-forward report — EXP-0043-g1-etf-dev-dedup

Dev span 2019-01-02 → 2025-09-25 (holdout 2025-09-26 → 2026-09-25 untouched). Trials counted for DSR: **12** (all configs evaluated).

## A|SPY

- OOS trades: 547; expectancy -0.067R; win 36%; PF 0.90; CI95 [-0.18078582300561433, 0.051124940844293566]
- DSR prob 0.003019932954686631; years profitable 2/6; random-control p 0.004975124378109453
- Gate: {'ci_lower_gt_0': False, 'dsr_gt_0.95': False, 'pf_ge_1.2': False, 'random_control_p_lt_0.05': True, 'n_ge_100': True} → **FAIL**

## B|SPY

- OOS trades: 414; expectancy +0.060R; win 50%; PF 1.22; CI95 [-0.017658666745417797, 0.14007559122128208]
- DSR prob 0.44412609291752736; years profitable 4/6; random-control p 0.004975124378109453
- Gate: {'ci_lower_gt_0': False, 'dsr_gt_0.95': False, 'pf_ge_1.2': True, 'random_control_p_lt_0.05': True, 'n_ge_100': True} → **FAIL**

## A|QQQ

- OOS trades: 552; expectancy -0.012R; win 36%; PF 0.98; CI95 [-0.12077607235805075, 0.09899785731286162]
- DSR prob 0.030295864777470507; years profitable 4/6; random-control p 0.1791044776119403
- Gate: {'ci_lower_gt_0': False, 'dsr_gt_0.95': False, 'pf_ge_1.2': False, 'random_control_p_lt_0.05': False, 'n_ge_100': True} → **FAIL**

## B|QQQ

- OOS trades: 417; expectancy +0.113R; win 56%; PF 1.42; CI95 [0.03311235639031509, 0.19159619010719742]
- DSR prob 0.8800298053013917; years profitable 5/6; random-control p 0.004975124378109453
- Gate: {'ci_lower_gt_0': True, 'dsr_gt_0.95': False, 'pf_ge_1.2': True, 'random_control_p_lt_0.05': True, 'n_ge_100': True} → **FAIL**
