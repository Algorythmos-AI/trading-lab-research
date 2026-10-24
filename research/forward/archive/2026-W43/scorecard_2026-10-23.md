# Forward scorecard — 2026-10-23

Forward-test sessions logged: **20** (2026-09-28 → 2026-10-23); forward-test errors: 0

## 1. Forward test vs. frozen backtest

| Candidate | Fwd n | Fwd E[R] | Win | PF | Cum R | Backtest μ (sd) | 95% band for this n | Status |
|---|---|---|---|---|---|---|---|---|
| B_qqq_qqqm | 4 | -0.120 | 50% | 0.60 | -0.48 | +0.115 (0.83) | [-0.703, +0.933] | ✅ inside band — n<20, too early |
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
| r3:REV-1 | 3 | +0.185 | 67% | 5.27 | +0.55 | no baseline | — | forward record only |

## 2. Paper trading — strategy B (Alpaca paper, virtual account)

- Sessions armed: **18** · clean (count for G2): **14** · trades closed: **4** · E[R] -0.736 · win 0% · cum -2.94R
- Signal agreement with forward-test B (clean sessions both ran; day-level, provisional until the replay harness): **4/14** = 29% (G2 needs ≥90%)
- Replay of B on recorded bars against the runner's journal (sessions recorded 10, comparable 10): same bar 3 · no signal on either 6 · different bar 0 · replay only 0 · journal only 1. Forward test against the replay: same 10 · not the same 0
- Incidents: loop errors 3 · not flat at close 0 · reconcile fixes 2 · refused to arm 0 · latch events 0
- Virtual account: equity US$589.09, settled cash US$8.93, latched=False

## 3. G2 progress

- Paper trades 4/50 · clean sessions 14/30 · incident-free streak 14/20 (a KILL-on, refused or incident session does not count)

## 4. The dry run against the record

Sessions with both a dry run and a forward pool: **11**. Counts only; the two records are never merged (DEC-0023).

| Tier | Dry run | Of record | In both |
|---|---|---|---|
| Tier 1 names | 13 | 15 | 12 |
| Tier 2 names | 0 | 0 | 0 |

- First pick: same 0 · different 0 · on one side only 0 · none on either 11
- Signals (a rule firing on a name, the four Set F trials; sessions with both records: 11): dry run 0 · of record 0 · in both 0

_Rules are frozen; any change requires a new decision record (research/decisions)._
