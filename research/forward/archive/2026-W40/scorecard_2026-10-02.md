# Forward scorecard — 2026-10-02

Forward-test sessions logged: **5** (2026-09-28 → 2026-10-02); forward-test errors: 0

## 1. Forward test vs. frozen backtest

| Candidate | Fwd n | Fwd E[R] | Win | PF | Cum R | Backtest μ (sd) | 95% band for this n | Status |
|---|---|---|---|---|---|---|---|---|
| B_qqq_qqqm | 1 | -0.178 | 0% | 0.00 | -0.18 | +0.115 (0.83) | [-1.520, +1.751] | ✅ inside band — n<20, too early |
| watchlist_bull_flag_atr_M1 | 0 | — | — | — | — | +0.006 (1.61) | — | biased — not evidence (DEC-0011) |
| hod_bull_flag_atr_M1 | 0 | — | — | — | — | +0.130 (1.67) | — | biased — not evidence (DEC-0011) |
| r3:F:GG-1 | 0 | — | — | — | — | no baseline | — | waiting for trades |
| r3:F:GG-2 | 0 | — | — | — | — | no baseline | — | waiting for trades |
| r3:F:GG-3 | 0 | — | — | — | — | no baseline | — | waiting for trades |
| r3:F:GG-4 | 0 | — | — | — | — | no baseline | — | waiting for trades |
| r3:MP-1 | 0 | — | — | — | — | no baseline | — | waiting for trades |
| r3:P:GG-1 | 0 | — | — | — | — | no baseline | — | waiting for trades |
| r3:P:GG-2 | 0 | — | — | — | — | no baseline | — | waiting for trades |
| r3:P:GG-3 | 0 | — | — | — | — | no baseline | — | waiting for trades |
| r3:P:GG-4 | 0 | — | — | — | — | no baseline | — | waiting for trades |
| r3:REV-1 | 0 | — | — | — | — | no baseline | — | waiting for trades |

## 2. Paper trading — strategy B (Alpaca paper, virtual account)

- Sessions armed: **3** · clean (count for G2): **0** · trades closed: **0**
- Signal agreement with forward-test B (clean sessions both ran; day-level, provisional until the replay harness): **0/0** (no overlap yet)
- Incidents: loop errors 3 · not flat at close 0 · reconcile fixes 0 · refused to arm 0 · latch events 0
- Virtual account: equity US$600.00, settled cash US$600.00, latched=False

## 3. G2 progress

- Paper trades 0/50 · clean sessions 0/30 · incident-free streak 0/20 (a KILL-on, refused or incident session does not count)

_Rules are frozen; any change requires a new decision record (research/decisions)._
