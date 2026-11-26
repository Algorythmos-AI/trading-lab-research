# Retired strategies

A strategy is retired when a decision record ends it. Nothing here runs, and nothing here is re-tuned: a strategy
comes back only under a new hypothesis, a new experiment id and a new decision, with the trials counted globally.

| Strategy | Hypothesis | Ended by | Evidence | Why, in one line |
|---|---|---|---|---|
| S1 small-cap momentum (gap-and-go) | HYP-0001 | DEC-0007 | EXP-0007, EXP-0008 | Negative after costs; the bull flag variant too rare to judge |
| S2 extreme reversal | HYP-0002 | DEC-0006, DEC-0007 | EXP-0007, EXP-0008 | Never triggers on either universe |
| S3 VWAP trend pullback | HYP-0003 | DEC-0007 | EXP-0007 | Negative over a large sample |
| S5 breakout-retest | HYP-0004 | DEC-0007 | EXP-0007, EXP-0008 | Negative after costs |
| A 5-minute ORB on ETFs | HYP-0005 | DEC-0007 | EXP-0005b | No edge on SPY or QQQ |
| B on SPY (SPYM orders) | HYP-0006 | DEC-0007 | EXP-0005b | Costs of the cheap ETF erase the edge |
| HOD momentum scanner | HYP-0007 | DEC-0009 | EXP-0014 | Walk-forward result spans zero |
| Knowledge-base setups with ATR stops | HYP-0008 | DEC-0009 | EXP-0013 | No edge with wider stops |
| B on IWM and DIA | HYP-0009 | DEC-0009 | EXP-0012 | Does not carry over from QQQ |
| Crypto family C and its challengers | HYP-0020 to HYP-0024 | DEC-0036 | EXP-0016 to EXP-0022 | Every rule run failed C1; desk closed |
| B on QQQ (QQQM orders), "the QQQ rule" | — | DEC-0069 | see DEC-0069 | Retired by the owner on 2026-11-20; its job `paper-b` left the schedule |

Strategy B on QQQ was the last forward candidate (stop rule DEC-0037) until DEC-0069 retired it on 2026-11-20. Its
frozen config, unchanged, moved here from `research/active_strategies/` on 2026-11-26 at the owner's choice:
[B_intraday_momentum_qqqm.yaml](B_intraday_momentum_qqqm.yaml). Older records (DEC-0007, DEC-0037, DEC-0061,
DEC-0062, EXP-0042) cite the old path; they are left as written. The status code lists this folder's `*.yaml` as
retired (`src/wt/ops/status.py`). The desks that trade now, Gap Hunter and the options clone, are configured in
`config/` ([config/README.md](../../config/README.md)).
