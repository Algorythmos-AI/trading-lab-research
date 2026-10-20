# EXP-0025: the options clone, one historical dry run on SPY and QQQ: report

- Decision: DEC-0031 (written and merged before this ran). Span 2026-03-02 to 2026-10-16, 160 sessions, SPY, QQQ. Data hash `f47742aff862475a`.
- Exploratory: it changes no number of the clone and is not evidence for DEC-0030's verdict.
- Unit: return on premium from the contracts' 1-minute trade bars, half the assumed spread paid each way, $0.03 a contract each way. Ranges: bootstrap of the mean by session (5000, seed 7).

## Spread 1x

| Setup | Signals | No option bar | Trades | Sessions | Mean on premium | Range by session | Halves | Win rate | Profit factor | Total $ | Max drawdown $ | Reading |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| retest | 619 | 1 | 103 | 76 | -0.0678 | [-0.1071, -0.0263] | -0.0762 / -0.0597 | 0.1068 | 0.463 | -865.13 | -976.26 | yes |
| rejection | 517 | 0 | 61 | 40 | -0.0583 | [-0.1069, -0.0058] | -0.0602 / -0.0565 | 0.1148 | 0.4 | -481.72 | -608.75 | yes |
| all |  |  | 164 | 98 | -0.0643 | [-0.0933, -0.0341] | -0.0695 / -0.0591 | 0.1098 | 0.442 | -1346.85 | -1473.88 | yes |

Exits: {"breakeven": 18, "chart": 16, "day-loss": 4, "next-level": 2, "premium": 39, "target": 15, "time": 70}

Left out or refused: {"gate:extension": 10, "gate:extension,reach": 5, "gate:extension,room": 13, "gate:extension,room,reach": 2, "gate:reach": 58, "gate:room": 201, "gate:room,reach": 48, "gate:shock": 1, "gate:trend": 362, "gate:trend,extension": 5, "gate:trend,extension,room": 2, "gate:trend,reach": 11, "gate:trend,room": 182, "gate:trend,room,reach": 9, "gate:trend,shock": 3, "no-option-bar:retest": 1, "over-cap:rejection": 25, "over-cap:retest": 34, "signal:rejection": 517, "signal:retest": 619}

## Spread 2x

| Setup | Signals | No option bar | Trades | Sessions | Mean on premium | Range by session | Halves | Win rate | Profit factor | Total $ | Max drawdown $ | Reading |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| retest | 619 | 1 | 103 | 76 | -0.0822 | [-0.122, -0.0413] | -0.0829 / -0.0816 | 0.1068 | 0.412 | -1040.65 | -1136.95 | yes |
| rejection | 518 | 0 | 61 | 40 | -0.0767 | [-0.125, -0.025] | -0.0782 / -0.0753 | 0.0984 | 0.331 | -624.99 | -737.21 | yes |
| all |  |  | 164 | 98 | -0.0802 | [-0.1084, -0.0502] | -0.0807 / -0.0796 | 0.1037 | 0.384 | -1665.64 | -1777.86 | yes |

Exits: {"breakeven": 16, "chart": 15, "day-loss": 4, "next-level": 2, "premium": 42, "target": 15, "time": 70}

Left out or refused: {"gate:extension": 10, "gate:extension,reach": 5, "gate:extension,room": 13, "gate:extension,room,reach": 2, "gate:reach": 58, "gate:room": 201, "gate:room,reach": 48, "gate:shock": 1, "gate:trend": 363, "gate:trend,extension": 5, "gate:trend,extension,room": 2, "gate:trend,reach": 11, "gate:trend,room": 182, "gate:trend,room,reach": 9, "gate:trend,shock": 3, "no-option-bar:retest": 1, "over-cap:rejection": 25, "over-cap:retest": 34, "signal:rejection": 518, "signal:retest": 619}

## Latches a live clone would have stopped on (1x)

{"weeks_at_or_below_week_latch": 0, "days_beyond_drawdown_latch": 143, "days_at_day_latch": 2}

## Reading it

- This span was not used to choose any of the clone's numbers, but it is history: the clone's own paper record (EXP-0024) is the only evidence for its verdict.
- Delta, volume and open interest could not be checked on history; the strike is the one nearest the stock. Trade bars are a rough stand-in for fills in a same-day contract's fast minutes; the 2x run is the guard, not a cure.
