# Forward scorecard — 2026-11-13

Forward-test sessions logged: **35** (2026-09-28 → 2026-11-13); forward-test errors: 3

## 1. Forward test vs. frozen backtest

| Candidate | Fwd n | Fwd E[R] | Win | PF | Cum R | Backtest μ (sd) | 95% band for this n | Status |
|---|---|---|---|---|---|---|---|---|
| B_qqq_qqqm | 8 | +0.008 | 50% | 1.03 | +0.06 | +0.115 (0.83) | [-0.463, +0.693] | ✅ inside band — n<20, too early — baseline biased (DEC-0011 R-C1) until its re-run |
| watchlist_bull_flag_atr_M1 | 0 | — | — | — | — | +0.006 (1.61) | — | biased — not evidence (DEC-0011) |
| hod_bull_flag_atr_M1 | 0 | — | — | — | — | +0.130 (1.67) | — | biased — not evidence (DEC-0011) |
| hod_bull_flag_atr_M1_v2 | 2 | -1.071 | 0% | 0.00 | -2.14 | no baseline | — | forward record only |
| r3:F:GG-1 | 0 | — | — | — | — | no baseline | — | waiting for trades |
| r3:F:GG-2 | 0 | — | — | — | — | no baseline | — | waiting for trades |
| r3:F:GG-3 | 0 | — | — | — | — | no baseline | — | waiting for trades |
| r3:F:GG-4 | 0 | — | — | — | — | no baseline | — | waiting for trades |
| r3:MP-1 | 0 | — | — | — | — | no baseline | — | waiting for trades |
| r3:P:GG-1 | 0 | — | — | — | — | no baseline | — | waiting for trades |
| r3:P:GG-2 | 0 | — | — | — | — | no baseline | — | waiting for trades |
| r3:P:GG-3 | 0 | — | — | — | — | no baseline | — | waiting for trades |
| r3:P:GG-4 | 0 | — | — | — | — | no baseline | — | waiting for trades |
| r3:REV-1 | 5 | -0.157 | 40% | 0.47 | -0.78 | no baseline | — | forward record only |
| watchlist_bull_flag_atr_M1_v2 | 2 | +0.257 | 50% | 1.49 | +0.51 | no baseline | — | forward record only |

_"no baseline": the round-3 trials and the re-specified `*_v2` flags have no frozen backtest, by design (DEC-0010, DEC-0011); their forward record is the only evidence they get._

## 2. Paper trading — strategy B (Alpaca paper, virtual account)

- Sessions armed: **33** · clean (count for G2): **28** · trades closed: **9** · E[R] -0.365 · win 33% · cum -3.29R
- Agreement at the bar, the frozen rule on recorded bars against the runner (clean sessions with a readable replay record, DEC-0037): **23/24** = 96% (G2a needs ≥90%) · 4 session(s) unreadable · harness, forward test against replay: 24/24 (a diagnostic, not pooled)
- Replay of B on recorded bars against the runner's journal (sessions recorded 25, comparable 25): same bar 8 · no signal on either 16 · different bar 0 · replay only 0 · journal only 1. Forward test against the replay: same 25 · not the same 0
- Incidents: loop errors 11 · not flat at close 0 · reconcile fixes 6 · refused to arm 0 · latch events 0
- Virtual account: equity US$586.27, settled cash US$586.27, latched=False
- Stop rule (DEC-0037): cumulative -3.29R of -6.0R · 9 of 30 trades to the review (not yet measured) · stop date 2027-01-30

## 3. G2 progress

- Paper trades 9/50 · clean sessions 28/30 · incident-free streak 4/20 (a KILL-on, refused or incident session does not count)

## 4. The dry run against the record

Sessions with both a dry run and a forward pool: **26**. Counts only; the two records are never merged (DEC-0023).

| Tier | Dry run | Of record | In both |
|---|---|---|---|
| Tier 1 names | 37 | 43 | 36 |
| Tier 2 names | 0 | 0 | 0 |

- First pick: same 0 · different 0 · on one side only 0 · none on either 26
- Signals (a rule firing on a name, the four Set F trials; sessions with both records: 26): dry run 0 · of record 0 · in both 0

_Rules are frozen; any change requires a new decision record (research/decisions)._
