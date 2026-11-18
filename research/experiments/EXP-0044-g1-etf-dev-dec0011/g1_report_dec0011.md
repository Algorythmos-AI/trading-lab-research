# G1 walk-forward report — EXP-0044-g1-etf-dev-dec0011

Dev span 2019-01-02 → 2025-09-25 (holdout 2025-09-26 → 2026-09-25 untouched). Trials counted for DSR: **87** (all configs evaluated).
Method **dec0011** (DEC-0011): DSR trials from the global registry, CI95 by day blocks, per-fill and stop-slippage stress (descriptive).

## A|SPY

- OOS trades: 547; expectancy -0.067R; win 36%; PF 0.90; CI95 [-0.18078582300561424, 0.05112494084429381]
- DSR prob 0.00019464892159727192; years profitable 2/6; random-control p 0.004975124378109453
- Stress (descriptive): stress_1.5x {'expectancy_R': -0.15498907704433093, 'ci95': [-0.27007523005897155, -0.03700786825656709], 'profit_factor': 0.7893169911601612} · stress_2.0x {'expectancy_R': -0.24327453977177435, 'ci95': [-0.3585953911820443, -0.12551681890814614], 'profit_factor': 0.6942039158033629} · stop_stress_2.0x {'expectancy_R': -0.12269851474450257, 'ci95': [-0.2399277623845085, -0.002061199052699847], 'profit_factor': 0.8319900527786978} · stop_stress_3.0x {'expectancy_R': -0.1786945402915097, 'ci95': [-0.299131102047764, -0.05490330733011895], 'profit_factor': 0.7722147036336604}
- Gate: {'ci_lower_gt_0': False, 'dsr_gt_0.95': False, 'pf_ge_1.2': False, 'random_control_p_lt_0.05': True, 'n_ge_100': True} → **FAIL**

## B|SPY

- OOS trades: 414; expectancy +0.059R; win 50%; PF 1.22; CI95 [-0.01809552596904629, 0.13803966894798053]
- DSR prob 0.16186787564393057; years profitable 4/6; random-control p 0.004975124378109453
- Stress (descriptive): stress_1.5x {'expectancy_R': 0.01871214368405996, 'ci95': [-0.05833616811789534, 0.09680222211406145], 'profit_factor': 1.063528173750006} · stress_2.0x {'expectancy_R': -0.021728881113703916, 'ci95': [-0.09913895857666576, 0.05591521332678847], 'profit_factor': 0.9314931971360378} · stop_stress_2.0x {'expectancy_R': 0.04294020885892651, 'ci95': [-0.03529592472489147, 0.12278292947890397], 'profit_factor': 1.1493218530899365} · stop_stress_3.0x {'expectancy_R': 0.026726733573229983, 'ci95': [-0.052514095555240455, 0.10768429483231765], 'profit_factor': 1.088351443193555}
- Gate: {'ci_lower_gt_0': False, 'dsr_gt_0.95': False, 'pf_ge_1.2': True, 'random_control_p_lt_0.05': True, 'n_ge_100': True} → **FAIL**

## A|QQQ

- OOS trades: 552; expectancy -0.011R; win 36%; PF 0.98; CI95 [-0.12014177918853221, 0.09994014567274793]
- DSR prob 0.003747448407363763; years profitable 4/6; random-control p 0.1691542288557214
- Stress (descriptive): stress_1.5x {'expectancy_R': -0.03660344431237495, 'ci95': [-0.14555785615953615, 0.07482744957564474], 'profit_factor': 0.9391532077700414} · stress_2.0x {'expectancy_R': -0.061732568216525445, 'ci95': [-0.17063362194079287, 0.049898370905187575], 'profit_factor': 0.9000866611877532} · stop_stress_2.0x {'expectancy_R': -0.025974558659938193, 'ci95': [-0.13561555987144278, 0.08610097180913849], 'profit_factor': 0.9565887136527899} · stop_stress_3.0x {'expectancy_R': -0.040475080586017766, 'ci95': [-0.15072686466205762, 0.07223051282559044], 'profit_factor': 0.9337959709431904}
- Gate: {'ci_lower_gt_0': False, 'dsr_gt_0.95': False, 'pf_ge_1.2': False, 'random_control_p_lt_0.05': False, 'n_ge_100': True} → **FAIL**

## B|QQQ

- OOS trades: 417; expectancy +0.113R; win 56%; PF 1.42; CI95 [0.03311235639031509, 0.19159619010719742]
- DSR prob 0.6360979919998069; years profitable 5/6; random-control p 0.004975124378109453
- Stress (descriptive): stress_1.5x {'expectancy_R': 0.10057296948657544, 'ci95': [0.020675663757813975, 0.17915529573473757], 'profit_factor': 1.3649356976146838} · stress_2.0x {'expectancy_R': 0.0880844412577791, 'ci95': [0.008204258995128826, 0.1663521880070406], 'profit_factor': 1.3133875532715298} · stop_stress_2.0x {'expectancy_R': 0.11005134042057012, 'ci95': [0.029679606159225352, 0.18906503190010182], 'profit_factor': 1.403359606812235} · stop_stress_3.0x {'expectancy_R': 0.10704104198700848, 'ci95': [0.02621951718474419, 0.1861937778515036], 'profit_factor': 1.3885155747048943}
- Gate: {'ci_lower_gt_0': True, 'dsr_gt_0.95': False, 'pf_ge_1.2': True, 'random_control_p_lt_0.05': True, 'n_ge_100': True} → **FAIL**
