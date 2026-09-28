# DEC-0009 — Round 2 outcome (2026-09-28)

- HYP-0009 (B on IWM/DIA): falsified → B's edge may be QQQ/regime-specific; lowers prior for B.
- HYP-0008 (ATR stops for KB setups): falsified → entries, not stop width, are the problem.
- HYP-0007 (intraday HOD scanner): falsified as robust (walk-forward +0.043R, CI spans 0); bull flag on
  intraday runners is the only KB setup with a consistently non-negative sign.
- Trials: 10 used (global 75); 10 of the round-2 budget remain unused.
- **Direction:** stop adding historical trials (each one raises the DSR bar and the overfitting risk).
  Collect *forward* evidence instead: (1) B paper dress rehearsal (orders, Alpaca paper); (2) a nightly
  **forward test** that re-runs the frozen B, HOD-bull-flag (M1) and watchlist-bull-flag (M1) rules on each
  new session after the close using delayed SIP data (no subscription needed) — clean out-of-sample data
  accumulating daily for every candidate at zero cost.
