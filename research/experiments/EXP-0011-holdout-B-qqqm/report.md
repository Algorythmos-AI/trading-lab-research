# EXP-0011 — ONE-TIME holdout: frozen B config (QQQ signals → QQQM costs, M3), 2025-09-26 → 2026-09-25

| | Dev walk-forward (EXP-0005b) | **Holdout (this run)** |
|---|---|---|
| Trades | 415 | 57 |
| E[R] | +0.117 | **+0.091** |
| Win rate | 57% | 58% |
| Profit factor | 1.44 | 1.32 |
| CI95 | [+0.038, +0.194] | [−0.122, +0.309] |
| Max drawdown | — | −6.3R (Jan–Mar 2026 ≈ −5.9R) |

**Reading:** sign, win rate and profit factor replicate on untouched data; the holdout alone is too small
to be significant. Combined with dev, the evidence is *consistent but modest*. B does **not** formally pass
G1 (DSR 0.707 at 65 global trials). Per DEC-0007 the holdout may not be used to re-tune B.
**Next evidence source:** forward paper trading (G2: ≥50 trades, ≥30 sessions) — the only remaining
untouched data.
