# Forward scorecard — 2026-10-16

Forward-test sessions logged: **15** (2026-09-28 → 2026-10-16); forward-test errors: 0

## 1. Forward test vs. frozen backtest

| Candidate | Fwd n | Fwd E[R] | Win | PF | Cum R | Backtest μ (sd) | 95% band for this n | Status |
|---|---|---|---|---|---|---|---|---|
| B_qqq_qqqm | 2 | +0.243 | 50% | 3.73 | +0.49 | +0.115 (0.83) | [-1.041, +1.272] | ✅ inside band — n<20, too early |
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
| r3:REV-1 | 2 | +0.342 | 100% | inf | +0.68 | no baseline | — | forward record only |

## 2. Paper trading — strategy B (Alpaca paper, virtual account)

- Sessions armed: **13** · clean (count for G2): **9** · trades closed: **0**
- Signal agreement with forward-test B (clean sessions both ran; day-level, provisional until the replay harness): **0/9** = 0% (G2 needs ≥90%)
- Replay of B on recorded bars against the runner's journal (sessions recorded 5, comparable 5): same bar 0 · no signal on either 5 · different bar 0 · replay only 0 · journal only 0. Forward test against the replay: same 5 · not the same 0
- Incidents: loop errors 3 · not flat at close 0 · reconcile fixes 0 · refused to arm 0 · latch events 0
- Virtual account: equity US$600.00, settled cash US$600.00, latched=False

## 3. G2 progress

- Paper trades 0/50 · clean sessions 9/30 · incident-free streak 9/20 (a KILL-on, refused or incident session does not count)

## 4. The dry run against the record

Sessions with both a dry run and a forward pool: **6**. Counts only; the two records are never merged (DEC-0023).

| Tier | Dry run | Of record | In both |
|---|---|---|---|
| Tier 1 names | 2 | 4 | 2 |
| Tier 2 names | 0 | 0 | 0 |

- First pick: same 0 · different 0 · on one side only 0 · none on either 6
- Signals (a rule firing on a name, the four Set F trials; sessions with both records: 6): dry run 0 · of record 0 · in both 0

_Rules are frozen; any change requires a new decision record (research/decisions)._
