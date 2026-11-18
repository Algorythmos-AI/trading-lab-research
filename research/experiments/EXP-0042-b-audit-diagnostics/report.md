# EXP-0042 report: Robot B audit (pre-correction evidence)

- Run 2026-11-18 from the committed inputs in `config.yaml`. `python scripts/b_audit.py --check` reproduces
  `results.json` exactly; the sha256 of every input is recorded there.
- **Every input predates the DEC-0011 R-C1 re-runs.** Nothing here is a finding about B's edge on corrected data.
- **Registered vs not.** Figures under `results.json → unregistered` were added to the driver after the first run,
  on adversarial review (R-C1 footprint, calendar-aware runner cutoff, first-session counts, the rate interval, what
  DSR 0.95 would need, PBO pick counts). They are descriptive and marked *(unregistered)* where quoted. The other
  amendments after the first run changed no registered value: rounding to 9 significant digits for macOS/Linux
  identity, and the output key `share_reaching_2R_mfe` renamed to match `config.yaml`.
- Sections marked **(code-read)** were read from `origin/integration` bcee7f0, not executed.

## 1. Executive assessment (Deliverable 1)

**Condition.** B is a frozen v1 rule trading QQQM on paper (DEC-0037). Its development record reproduces exactly,
but it is built on data with a known bar-duplication bug (DEC-0011 R-C1) whose corrective re-runs, ordered on
2026-10-25, have never been registered. The bug's reach is wide: 8 of the frozen rule's 479 trades are entries clean
bars cannot produce, 19 trades fall on a month's first session, and 325 (68%) have a first session inside the 14
sessions their volatility estimate reads *(unregistered)*. The size of the effect is untested.

**The record as it stands.**

| Figure | Value | What it is |
|---|---|---|
| G1 series (walk-forward, out of sample) | 415 trades, +0.117R, CI95 [+0.038, +0.194], PF 1.44 | what G1 gates; 21 folds picked the frozen exit, 2 a trailing exit |
| G1 deflated Sharpe | 0.707 at 65 trials (recorded); **0.669 at 87** (in force) | G1 needs > 0.95 |
| Frozen rule, whole development span (in sample) | 479 trades, +0.115R, CI95 [+0.040, +0.191], PF 1.41 | descriptive; the exit was chosen on this data |
| Holdout 2025-09-26 → 2026-09-25 (consumed) | 57 trades, +0.091R, CI95 [−0.122, +0.309] | crosses zero |
| Paper (scorecard 2026-11-13) | 9 trades, mean −0.365R, cum −3.29R | too few to judge alone |

**Strongest characteristics.** A positive out-of-sample walk-forward mean with a CI above zero; above all 200
random-entry controls (p = 0.005, the floor of 1/201); 5 of 6 walk-forward years profitable and no month above 7%
of profit (recorded in G1); modelled cost is not binding over 1–2x; the runner's timing gap is small and conservative.

**Main weaknesses.**
1. The only evidence is uncorrected, and the bug touches about two-thirds of trades through the volatility window.
2. G1 fails on the deflated Sharpe at the trial count in force (0.669). At B's Sharpe the gate needs about 890 trades
   *(unregistered)*; on the development span it has 415. It is bound by sample size, not permanently out of reach.
3. The paper programme cannot answer its own question in useful time (section 6).
4. One exit, the 2R target, carries most of the profit through 22 trades (section 3.3): the edge is concentrated.

**Further investment.** Only the owed corrective work and a paper execution audit. No tuning of v1. Provisional
verdict: **SUSPEND** research investment in v1; paper keeps running under G2a and the DEC-0037 stop line. DEC-0061's
table then decides between ABANDON, SUSPEND (with a REDESIGN proposable as a new hypothesis) and REFINE.

## 2. Strategy architecture map (Deliverable 2) (code-read)

| Stage | Where | What happens |
|---|---|---|
| Config | `research/active_strategies/B_intraday_momentum_qqqm.yaml`, `config/risk.yaml` | frozen v1; QQQ signal, QQQM orders, long only, 2R target, flatten 10 min before close, 1% risk, one trade a day; stop rule −6.0R / 30-trade review / 2027-01-30 |
| Start-up | `src/wt/live/runner_b.py` (`paper-b`) | MODE must be paper; runner lock; paper-only adapter (`src/wt/brokers/alpaca_paper.py`, `src/wt/core/safety.py`); refusals turn entries off, never exits |
| Stop rule at arming | `src/wt/risk/stop_rule.py` | replays the journal's B trades; firing latches the account and pages |
| Resume, reconcile | `runner_b.py`, `src/wt/oms/manager.py` | adopts plans and orphan positions; books unrecorded closes; broker is the source of truth |
| Data | `runner_b.py` | IEX 1-minute bars on a filled minute grid; IEX quotes; 15 s deadlines |
| Signal | `src/wt/signals/setups.py` `b_intraday_momentum` | half-hour marks from 10:00; first qualifying mark only; volatility from the prior 14 sessions |
| Eligibility | `runner_b.py:831` | kill file, latch, one a day, exposure, macro events, stale bars > 150 s, QQQM spread > 0.10%, clock skew ≤ 2 s; **no entry at or after close − 30 min** (15:30; 12:30 on a half day) |
| Order | `runner_b.py`, `src/wt/risk/pretrade.py` | stop-limit DAY buy, limit trigger + 0.1R; QQQ levels scaled to QQQM by mid ratio; working entry cancelled at 15:30 (`:829`, also on half days) |
| Fill, protection | `src/wt/oms/manager.py` | server-side GTC stop on first fill; idempotent client order ids |
| Exits | `runner_b.py:795-829` | target: marketable limit when QQQM mid ≥ target; T−10 limit, T−5 market, T−2 flat check; a short is never auto-covered |
| Recording | `Books`, `src/wt/risk/virtual_account.py`, `src/wt/core/ledger.py` | one `trade_closed` per close; hash-chained journal; T+1 settlement; latches at −2% day / −4% week / −10% drawdown |
| Measurement | `src/wt/analytics/g2.py`, `b_replay.py`, `scripts/weekly_scorecard.py`, dashboard | G2a/G2b, replay agreement, stop-rule view |

**Runner vs research:**

| Difference | Research | Runner | Effect |
|---|---|---|---|
| Last entry | any mark, 15:30 included | none at or after close − 30 min | measured: 19 trades (4.0%) the runner cannot take, mean −0.111R; the rest +0.124R. No early-close trade falls after its 12:30 cutoff (6 trades on early-close days) |
| Target exit | resting limit filled on touch | marketable limit on mid crossing | touches only 22 trades, but they carry +43.9R: a small fill difference there moves the total. Unmeasured (H1) |
| Cash | unlimited at $6 risk | settled-cash cap, T+1 | skipped days, unsigned |
| Bars | SIP | IEX on a filled grid | different signals possible; scorecard agreement 23/24 at the bar |
| Scaling | QQQ prices | QQQ levels scaled to QQQM, 1-cent ticks, 1–10 shares | R distortion at a $6 budget, unmeasured (H7) |

## 3. Baseline report (Deliverable 3)

### 3.1 The frozen rule over the development span (in sample, descriptive)

| | Value |
|---|---|
| Trades / win rate | 479 / 56.4% |
| Avg win / avg loss | +0.698R / −0.638R |
| Expectancy / sd | +0.115R / 0.834R |
| Profit factor | 1.41 |
| Per-trade Sharpe / skew / kurtosis | 0.138 / 0.32 / 2.51 |
| Max drawdown | −10.18R over 64 trades |
| Longest losing run | 6 |
| Total | +55.1R |
| Top 5 / top 10 trades' share of total | 18% / 36%; without the top 10, +0.075R |
| Minimum track record (Sharpe > 0 at 95%) | 138 trades |

By year (trades, mean R): 2019 64 +0.153 · 2020 79 +0.042 · 2021 70 +0.284 · 2022 69 +0.150 · 2023 78 +0.158 ·
2024 72 +0.087 · 2025 (to 09-25) 47 −0.145. The 2025 figure is the worst of seven years picked after the fact,
about 2 standard errors out, and the holdout after it is positive: not evidence of decay on its own (H6).

The trade and day-block intervals coincide because no date has more than one trade (479 unique dates). Regime
dependence is therefore not addressed by either.

### 3.2 Entry marks and the runner's cutoff

Mean R by entry mark (New York; trades): 09:30 +0.486 (2, both R-C1 artefacts) · 10:00 +0.154 (80) · 10:30 +0.096
(84) · 11:00 +0.147 (64) · 11:30 +0.303 (61) · 12:00 +0.081 (35) · 12:30 +0.168 (43) · 13:00 −0.191 (18) · 13:30
−0.044 (16) · 14:00 +0.186 (14) · 14:30 −0.040 (25) · 15:00 +0.027 (18) · 15:30 −0.111 (19). Afternoon cells are
small; a rule drawn from this table would be mined (H5). The runner's cutoff is computed per session from the NYSE
calendar *(unregistered refinement)*; it removes the same 19 trades as a fixed 15:30.

### 3.3 Exits

| Exit | Trades | Mean R | Sum R |
|---|---|---|---|
| Flatten before close | 353 (74%) | +0.331 | +117.0 |
| Stop | 104 (22%) | −1.017 | −105.7 |
| 2R target | 22 (4.6%) | +1.993 | +43.9 |

The flatten bucket offsets the stops almost exactly; the 22 target exits carry +43.9R of the +55.1R total (without
them, +11.3R). The edge is therefore concentrated in the few trades that run 2R. Winners keep 65% of their best
excursion on average; losers' mean best excursion is +0.28R, and 1.9% of losers were ever 1R up *(unregistered
split)*: B rarely gives back a winner, but the profit depends on a thin tail. A different exit is a redesign question
(H4), not a v1 tweak.

### 3.4 Data quality *(unregistered)*

Eight trades are entries clean bars cannot produce: before 10:00 or at :15/:45 (2019-08-01 09:45, 2020-12-01
11:45, 2021-03-01 10:45, 2023-06-01 11:15, 2024-03-01 10:15, 2024-04-01 09:45, 2024-11-01 10:15, 2025-04-01 12:15),
all on a month's first session: the R-C1 footprint. In all, 19 trades fall on first sessions (+5.8R), and 325 have a
first session inside the 14 prior sessions that set their volatility band.

### 3.5 Selection and overfitting

- **DSR (gate method, variance 1/n).** G1 series: 0.707 at 65 trials, 0.669 at 87. Frozen rule (in sample,
  descriptive): 0.744 at 65, 0.708 at 87. A sensitivity bound using the Sharpe variance across the 12 development
  configurations (two strategies on two symbols, so heterogeneous) gives about 1e-6; the gate method is the figure of
  record. Reaching 0.95 at 87 trials needs a per-trade Sharpe of about 0.187 at 479 trades, or about 890 trades at
  Sharpe 0.138 *(unregistered)*.
- **PBO (CSCV, 16 blocks, 12,870 splits, 12 configurations, 1,056 trade dates; the 14 most recent dates dropped to
  fill whole blocks).** 0.074. B on QQQ with the frozen exit is the in-sample best in 11,254 of 12,870 splits *(pick
  counts unregistered)*. With most competitors being negative A configurations, a low PBO is close to mechanical: it
  says B on QQQ outranks these eleven, not that its mean is above zero, and it ignores the 75 other trials. It is not
  used in the verdict rules. Over B's two exits alone, PBO is uninformative.
- **Random-entry control.** p = 0.005 against 200 control means, the floor (above all 200).

### 3.6 Costs

Expectancy falls about 0.015R per +1.0x of the recorded cost and 0.028R per +1.0x of the traded-ETF cost, from three
points between 1x and 2x (EXP-0005; its 1.0x point is 0.1276R on a slightly different series). A linear break-even
near 5x is an extrapolation, and stop slippage is not stressed here. Modelled cost does not bind at 1–2x; real
execution may (H1).

## 4. Root causes, ranked by impact and confidence (Deliverable 4)

| # | Cause | Impact | Confidence | Evidence |
|---|---|---|---|---|
| 1 | Evidence base uncorrected; 8 visible artefacts; 68% of trades read a corrupted volatility window | unknown sign; decides everything | high | DEC-0011; 3.4 |
| 2 | Too few trades for the trial count: Sharpe 0.14 over 415 trades against 87 trials | G1 cannot pass on this span | high | DSR 0.669; needs ~890 trades |
| 3 | The paper gate cannot measure the edge in useful time | the programme's question is unanswerable as designed | high | section 6 |
| 4 | Profit concentrated in 22 target exits | fragile to any fill or exit difference | medium | 3.3 |
| 5 | Real execution may cost more than modelled | possibly large | low | paper −0.365R over 9 trades; unpaired and under 1 SE from the development mean's interval, so only the reason EXP-0048 goes early |

## 5. Research hypothesis backlog (Deliverable 5)

Candidates, not registered hypotheses. A rule-changing item needs its own HYP and EXP before any affected P&L is
viewed, judged only on data not used to form it: the holdout is consumed and the development span seen, so the only
clean samples are sessions after 2026-09-25 and the paper record.

| Id | 1 Problem | 2 Explanation | 3 Mechanism | 4 Change | 5 Why | 6 Validates | 7 Falsifies | 8 Trade-off | 9 Risk | 10 Experiment | Priority |
|---|---|---|---|---|---|---|---|---|---|---|---|
| H1 | paper −0.365R (9) vs development +0.115R | live fills worse than modelled, above all on the 22-trade target tail | QQQ→QQQM scaling, stop-limit slippage, marketable exits, share rounding | none until measured | locates the real cost | a paired per-trade shortfall, statistic and threshold fixed in its registration | no shortfall | — | paper n tiny | EXP-0048 | 1 |
| H2 | record built on R-C1 data | duplicated bars move signals and the volatility band | positional bar counting | none (correction) | the true baseline | corrected G1 items | — | — | — | EXP-0043/0044/0045/0046 | 1 |
| H3 | paper gate underpowered | 0.27 trades a session, sd 0.83R | sampling | owner decision on what G2b claims; a sequential test | honest gating | — | — | longer programme | — | a decision record; EXP-0049 | 2 |
| H7 | $6 risk with 1-cent ticks | R distorted at tiny size | share rounding | none for v1 | explains paper vs model | measured distortion | none | — | — | inside EXP-0048 | 2 |
| H6 | 2025 negative | regime change in intraday momentum | crowding, volatility regime | none | — | corrected 2025 negative and post-2026-09 negative | positive | — | post-hoc year pick | read inside EXP-0044 | 4 |
| H4 | profit in a thin 2R tail | continuation into the close | momentum | an exit that follows the move | aligns exit with mechanism | out-of-sample gain on post-2026-09 sessions | no gain | more variance | already tried as M4 | new HYP + EXP on unseen sessions | 3 |
| H5 | afternoon marks weak | late breakouts lack time | — | no entries ≥ 13:00 | fewer weak entries | gain on unseen sessions | none | fewer trades | pure data mining | only on unseen sessions | 5 |
| H8 | first signal only, fixed size | other formulations scale by volatility and re-enter | — | redesign | robustness | — | — | complexity, new trials | — | REDESIGN path only | 6 |

## 6. What the paper record can show, and the roadmap (Deliverable 6)

**Power.** For a one-sided z-test of mean R > 0 at α 0.05 with the development sd (0.834R): 325 trades give 80%
power if the true edge is the development +0.115R; 1,300 if it is half that; 517 at the holdout's +0.091R. At the
paper rate of 9 trades in 33 armed sessions (0.27; exact 95% range 0.12–0.52 *(unregistered)*), 325 trades is about
4.7 years (roughly 2.5–10). DEC-0037 sets G2b as a count of 50 trades with no test; if read as that test, 50 trades
have 25% power at the full edge. The minimum track record for a Sharpe above zero at 95% is 138 trades.

**SPRT design (registered, not applied).** H0 mean 0 vs H1 +0.058R (half the development edge), sd 0.834, α 0.05,
β 0.20: on cumulative R the "no edge" boundary is −18.85R + 0.029R × trades, and the "edge" boundary +33.55R +
0.029R × trades; expected length about 564 trades with no edge, 802 with it. Its error rates differ from the −6.0R
line's, so the two are not compared here; EXP-0049 measures the line's own error rates.

**Roadmap, in order** (each registered with a manifest before it runs):
1. DEC-0011 re-runs under new ids: EXP-0043 data-only re-run of EXP-0005b; EXP-0044 corrected method
   (`g1_eval --method dec0011`); EXP-0045 holdout re-score (can demote, never promote); EXP-0046 controls re-run (it
   supplies EXP-0044's random-control p); EXP-0047 IWM/DIA re-run.
2. EXP-0048 paper execution audit: per trade, runner fill vs the backtest fill model on the same bars; statistic,
   minimum n and threshold fixed in its registration.
3. EXP-0049 stop-line operating characteristics: how often the −6.0R line and the 30-trade review fire with no edge
   and with the corrected edge (simulation, no new data).
4. A record applying DEC-0061's table.
5. Only on its SUSPEND-with-redesign outcome: new HYP/EXP for H4 or H8, judged on sessions after 2026-09-25.

## 7. Risk audit (Deliverable 7) (code-read)

- **Strategy:** one instrument, long only, one trade a day: no correlation stacking. The −10.2R in-sample drawdown
  (−6.6R in the G1 series) is at or beyond the −6.0R paper stop line, so a B with a real edge can trip it (EXP-0049).
- **Portfolio:** QQQM only; the other desks are separate accounts.
- **Execution:** stop-limit entries can miss on gaps (collar 0.1R); marketable exits cross the spread; spread guard
  0.10%; R distortion at 1–10 shares (H7); the profit's dependence on 22 target exits makes target fills the
  sensitive point.
- **Operational:** paper-only lock at the adapter and before every order; KILL blocks entries and keeps exits;
  latches on the stop rule and account limits, cleared only by a new decision; idempotent client order ids and
  journal keys; broker-led reconciliation; server-side GTC stop on fill; stale-data and clock-skew blockers; not flat
  at close leaves a GTC stop and alerts; a short is never covered automatically (alert only). No path found that lets
  B trade uncontrolled. Open items: the short-position path relies on a human; on a half day the working entry is
  cancelled at 15:30 rather than at the 12:30 entry cutoff (`runner_b.py:829`), so an unfilled entry can stay working
  after the cutoff until close.

## 8. Proposed improvements (Deliverable 8)

Supported by evidence now: none to B's rule. For the programme:
1. Run the owed DEC-0011 re-runs (approved 2026-10-25).
2. Measure real execution before believing any edge (EXP-0048), starting with the target exits.
3. Show on the dashboard, in numbers, what the paper record can and cannot show, so a passed G2a is never read as a
   validated strategy (done: the Robot B page).
4. For the owner: the half-day entry-cancel time (section 7) is worth a hotfix decision of its own.

## 9. Implementation (Deliverable 9)

`src/wt/research/b_audit.py` (pure statistics, strict typing), `scripts/b_audit.py` (driver with `--check`),
`tests/unit/test_b_audit.py`; `scripts/robot_b_evidence.py` and the dashboard's `/robot-b` page, which shows this
experiment's numbers only.

## 10. Final recommendation (provisional)

**SUSPEND** research investment in B v1. Keep the paper desk running under G2a and the stop line as an execution
and plumbing check; it is not evidence of edge. Do the owed corrective work, EXP-0048 and EXP-0049, then apply
DEC-0061's table. At B's Sharpe and trial count, G1 needs roughly twice the development span's trades, so v1 has no
near-term path to promotion; the open question is whether the mechanism deserves a REDESIGN judged on unseen sessions,
or ABANDON.
