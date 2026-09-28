# DEC-0004 — Keep baseline scanner hard filters (no change after EXP-0002/0003)

- **Date:** 2026-09-27 · decided by: Claude (research step; reversible via new experiment)
- **Evidence:** EXP-0002 (40 sessions, 2026-07-31→2026-09-25) and EXP-0003 (+ tradeable-target re-score).
  - Close-to-close top-5 recall: baseline 56/200 vs naive top-gappers 108/200 — biased toward naive
    because close-to-close includes the gap itself.
  - Tradeable target (open→high, top-5, $2–30, vol ≥1M): baseline 34/200 hits but the **highest median
    open→high per watched stock (7.97%)** vs naive 7.10% and relaxed V3 4.52%.
  - Relaxing liquidity ($1M→$250k) and removing the 100M float cap raised recall but diluted quality.
- **Decision:** keep `config/ranking.yaml` unchanged (frozen for G1). Scanner goal = quality of watched
  names, consistent with KB "quality over quantity".
- **Gap noted:** 51/200 close-to-close winners never gapped pre-market (intraday runners) → requires an
  intraday HOD-momentum scanner (future hypothesis HYP-0007, not in G1 pass 1).
- **Trials:** EXP-0002 and EXP-0003 are scanner-recall experiments, not strategy trials; they are not
  counted in strategy DSR (no P&L was used to choose them).
