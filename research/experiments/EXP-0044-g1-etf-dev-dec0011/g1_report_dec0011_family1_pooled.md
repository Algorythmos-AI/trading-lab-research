# G1 walk-forward report — EXP-0044-g1-etf-dev-dec0011

Dev span 2019-01-02 → 2025-09-25 (holdout 2025-09-26 → 2026-09-25 untouched). Trials counted for DSR: **87** (all configs evaluated).
Method **dec0011** (DEC-0011): DSR trials from the global registry, CI95 by day blocks, per-fill and stop-slippage stress (descriptive).

## A

- OOS trades: 532; expectancy +0.005R; win 36%; PF 1.01; CI95 [-0.11120662389131676, 0.12100619199214127]
- DSR prob 0.008137022726676626; years profitable 3/6; random-control p 0.04488778054862843
- Stress (descriptive): stress_1.5x {'expectancy_R': -0.03739834658023177, 'ci95': [-0.1541096321804331, 0.0783677958320471], 'profit_factor': 0.9430913139193139} · stress_2.0x {'expectancy_R': -0.0795605293489892, 'ci95': [-0.1961577783513515, 0.03645948626374682], 'profit_factor': 0.8838414607147548} · stop_stress_2.0x {'expectancy_R': -0.020081154716447936, 'ci95': [-0.13770441259850286, 0.09761554019012042], 'profit_factor': 0.9692693251692792} · stop_stress_3.0x {'expectancy_R': -0.044926657915647525, 'ci95': [-0.163923450264186, 0.07453923250752646], 'profit_factor': 0.9336720748578998}
- Gate: {'ci_lower_gt_0': False, 'dsr_gt_0.95': False, 'pf_ge_1.2': False, 'random_control_p_lt_0.05': True, 'n_ge_100': True} → **FAIL**

## B

- OOS trades: 419; expectancy +0.106R; win 55%; PF 1.39; CI95 [0.02719016250966951, 0.18360541484544274]
- DSR prob 0.566880668043639; years profitable 5/6; random-control p 0.0024937655860349127
- Stress (descriptive): stress_1.5x {'expectancy_R': 0.09042125347668135, 'ci95': [0.011429951694114216, 0.16775898345814905], 'profit_factor': 1.320596523658342} · stress_2.0x {'expectancy_R': 0.0746945266734069, 'ci95': [-0.004320372561758721, 0.15201606835937673], 'profit_factor': 1.2582661709054228} · stop_stress_2.0x {'expectancy_R': 0.10213303346204498, 'ci95': [0.02261441092556616, 0.17990761964169075], 'profit_factor': 1.366571246625874} · stop_stress_3.0x {'expectancy_R': 0.09811790216178957, 'ci95': [0.018025251019715798, 0.17635836867750643], 'profit_factor': 1.347566498741934}
- Gate: {'ci_lower_gt_0': True, 'dsr_gt_0.95': False, 'pf_ge_1.2': True, 'random_control_p_lt_0.05': True, 'n_ge_100': True} → **FAIL**
