# DEC-0002 — G1 pre-registered candidate set

- **Date:** 2026-09-27 · **Approved by:** owner ("go with your suggested G1 candidates")
- **KB-derived:** S1 small-cap momentum (historical SIP data), S2 extreme reversal (long side),
  S3 VWAP trend pullback, S5 S/R breakout-retest; S6 tested as management variants.
- **External (plan):** A = 5-min ORB on QQQ/SPY signals → QQQM/SPYM; B = intraday momentum
  (noise-area + VWAP trail) on SPY → SPYM.
- **Controls:** random entry (same timing/stop/size, 1,000 runs), gap-and-go as taught, gap-fade.
- **Parked:** S4 RSI-2 swing (overnight holds). **Excluded:** options setups, Level-2 rules (no data).
- **Independent variables pre-registered:** entry window W1–W4, management styles M1–M8 per
  `trade_management_catalog.md`, contradiction variants per `contradictions.md`; ≤20 trials per
  strategy, global registry = `research/experiments/`.
