# DEC-0062: Robot B on corrected data: verdict V2, SUSPEND stands

- **Status: ACCEPTED on 2026-11-19.** A mechanical application of DEC-0061 section 2 (accepted 2026-11-19) to the
  DEC-0011 re-runs; the owner asked for the re-runs to start on 2026-11-19 and the table decides the verdict, so no
  further choice is made here.
- **Amends nothing.** No rule, exit, size, limit, gate, latch or stop line of B changes (DEC-0011 §3: no parameter of
  B may change because of any corrected result). Paper trading continues unchanged.
- **Experiments:** EXP-0043, EXP-0044, EXP-0045, EXP-0046, EXP-0047, each registered and pushed (66041c3e) before it
  ran, each run from that commit with a clean tree (manifests). No trial added; the global count stays at 87.
- **Carries out:** DEC-0011 "After approval", items 2 to 4 (this record is the outcome DEC-0011 named DEC-0012).

## The verdict (DEC-0061 section 2)

Input: EXP-0044 `g1_eval_dec0011.json` → `B|QQQ`, with EXP-0046 as the control experiment.

| G1 item | Recorded (EXP-0005b) | Corrected (EXP-0044) | Line | Pass |
|---|---|---|---|---|
| CI95 lower bound | +0.038R | +0.033R (day blocks) | > 0 | yes |
| Deflated Sharpe | 0.707 at 65 trials | **0.636 at 87 trials** | > 0.95 | **no** |
| Profit factor | 1.44 | 1.42 | ≥ 1.2 | yes |
| Random-control p | 0.005 | 0.005 (above all 200) | < 0.05 | yes |
| Trades | 415 | 417 | ≥ 100 | yes |

Walk-forward: 417 trades, +0.113R (recorded +0.117R), CI95 [+0.033, +0.192]; 21 folds picked the frozen exit and 2
the trailing exit, as recorded. Cost stress (descriptive): +0.101R at 1.5x and +0.088R at 2x per-fill cost, CI lower
bounds still above zero; +0.110R and +0.107R at 2x and 3x stop slippage.

- **Row V2 holds:** the four items other than the DSR pass and the DSR fails. **SUSPEND stands.** A REDESIGN may be
  proposed only as a new hypothesis (EXP-0042 backlog H4 or H8), judged on sessions after 2026-09-25.
- **Cap C1 applies:** the re-scored holdout (EXP-0045) is 59 trades, +0.071R, CI95 [−0.128, +0.288], below the
  recorded +0.091R with a lower bound ≤ 0. The verdict can be no better than V2, which it is not. Per DEC-0011 §3 the
  recorded holdout evidence is demoted to the corrected figure and is not upgraded by anything.
- **Cap C2 applies:** EXP-0048 has not been read, so no promotion step is taken.

## Old and corrected, side by side (DEC-0011 §2)

| Experiment | Recorded | Corrected |
|---|---|---|
| B on QQQ, frozen rule, development span | 479 trades, +0.115R | 481 trades, +0.114R, CI95 [+0.039, +0.187], PF 1.41, max drawdown −9.4R (EXP-0043 = EXP-0044 for this rule: no B target fill moved under trade-through) |
| B on QQQ, walk-forward | 415, +0.117R, DSR 0.707 (65) | 417, +0.113R, DSR 0.636 (87) |
| B on SPY, frozen rule | 474, +0.049R | 480, +0.048R |
| Holdout (consumed) | 57, +0.091R, CI [−0.122, +0.309] | 59, +0.071R, CI [−0.128, +0.288] |
| Random-entry control, B on QQQ (mean of 200 means / 95th pct) | −0.111R / −0.040R | −0.108R / −0.042R |
| B on IWM | 488, −0.034R | 492, −0.032R |
| B on DIA | 479, +0.028R | 480, +0.032R |

The eight entries clean bars cannot produce (EXP-0042 §3.4) are gone from the corrected run. The correction moved B's
development figures by about 0.002R: R-C1 was real, but it was not what limits B. What limits B is the DSR, which at
B's Sharpe needs roughly twice the trades the development span holds, and a holdout that cannot be told from zero.

## Disclosures

- The registered evaluation command in EXP-0043's and EXP-0044's `config.yaml` omitted `g1_eval`'s family-fields
  argument, so the first evaluation pooled B over SPY and QQQ (family `B`). The registration's own `verdict_input`
  names family `B|QQQ`, which is how EXP-0005b was gated, so the evaluation was run again with family fields 2. Both
  outputs are kept: the pooled one as `*_family1_pooled.*` beside the `B|QQQ` one. The verdict reads `B|QQQ` only.
- EXP-0043's legacy DSR (0.880) uses that experiment's own 12 trials, as the legacy method always did; it is not a
  G1 figure.
- EXP-0043's and EXP-0044's `results.json` (1.4 MB and 5.0 MB, over the 500 KB pre-commit limit) are kept out of
  git as EXP-0007's is: listed by sha256 in `research/experiments/LARGE_FILES.sha256`, ignored in `.gitignore`, a copy
  in the owner's `~/trading` checkout. Their G1 outputs, which the verdict reads, are committed.
- `research/active_strategies/B_intraday_momentum_qqqm.yaml` is not edited (the runner loads it, DEC-0061); B's old
  and corrected numbers are in `research/G1_SUMMARY.md` and here.

## What follows

1. EXP-0048 (paper execution audit) and EXP-0049 (stop-line operating characteristics), each registered before it runs.
2. No research on v1 itself. A REDESIGN, if proposed, starts as a new HYP with a new EXP on sessions after 2026-09-25.
