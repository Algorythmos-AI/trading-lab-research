# SPEC-0001 — Conflicts and operational choices

This register covers every place where the sources disagree, and every place where a qualitative rule
needed a number to be testable.

Resolution precedence:
1. The owner's explicit clarification (C4–C13).
2. The spec text and schema v2.
3. Schema v1 and the indicators sheet.
4. The knowledge base.

Rows marked **operational** are my own choice of number for a rule the sources state qualitatively. They are
frozen with DEC-0010 and can only change through a new pre-registration.

| ID | Topic | Sources in tension | Resolution | Basis |
|---|---|---|---|---|
| K-01 | Minimum gap | schema v1 `min_gap_percentage: 4.0`; spec §1 "+4% to +5%" · spec §8 and C5 ">+5%" | **> 5%** | Routine and funnel both say > 5%; the stricter reading wins |
| K-02 | Hard price band | schema `price_range_usd [1, 20]` · C5/C6 funnel text "$1–$10" | **$1.00–20.00 hard; $1.50–10.00 ordered first** | Owner, C7 |
| K-03 | Bull-flag shape | KB catalog: 2+ red candles, ≤ 50% retrace · sheet and C4: 1–3 candles, ≤ 25% | **1–3 flag candles, ≤ 25% price retrace** | Owner, C4 |
| K-04 | ATR as a scanner filter | sheet "ATR > 1" · one KB record "ATR_max 1" | ATR is used **only** for window height (window > ATR14) | Spec §4; the two scanner uses contradict each other and neither is a must |
| K-05 | 5-minute rule | schema v1 `max_trade_duration_minutes: 5` · spec §7 "does not resolve" | **Stagnation stop:** at 5 minutes, exit unless the first target is hit or price is ≥ entry + 0.5R. Runners have no time cap | Owner, C8; the +0.5R threshold is the catalog's M2 definition |
| K-06 | Offerings / dilution | Spec excludes only buyouts and rumours · KB excluded offerings | **Non-qualifying** (fails "strong catalyst") rather than a separate exclusion. Same effect in set F | Spec §1 "strong breaking news" |
| K-07 | 1-minute ORB timing | Spec §5 "2nd candle breaks the 1st candle's high" | **The 09:31 candle only.** Otherwise the 5-minute ORB (09:35–09:50) | Owner, C9 and C11 |
| K-08 | Former runner | schema v1 required: true · C5 booster | **Score booster (0.15), never a filter** | Owner, C5 |
| K-09 | ABCD retrace | Sheet gives the pattern but no depth | **C retraces ≤ 61.8% of AB**, with C a higher low above A | Operational: the sheet's Fibonacci row lists 61.8% as the key level |
| K-10 | "2,000% 5-minute volume surge" | Spec §2 · "or strong 15-minute rate of change" | **5-minute volume ≥ 20× its time-of-day norm**. The 15-minute alternative has no number and isn't used | Operational: Trade-Ideas expresses surge as % of normal |
| K-11 | HOD volume floor | Spec §2 100k scanner floor · C2 "momentum trades must have ≥ 1M" | **≥ 1,000,000** | The C2 must |
| K-12 | HOD float | Spec §2 "max 20M (up to 50M)" | **≤ 20M** | Stated maximum; 50M is the outer tolerance |
| K-13 | Daily-chart lookback for levels and windows | C12 "past 3 to 6 months (or ~90 days)" · KB 250 sessions | **90 sessions** | Owner, C12 |
| K-14 | "New volume spike as the apex breaks" | A resting stop order fills before bar volume is known | **Enter with the stop order; if the breakout bar closes below 2× its 20-bar average volume, exit at the next bar's open** | C11, C12; keeps the rule causal (plan D32) |
| K-15 | Flag volume "decreases significantly" | C4 qualitative · C12 numbers | **Each flag candle < 50% of the pole's peak-volume candle**; < 30% tagged high-conviction | Owner, C12 |
| K-16 | "Clean patterns close to the 9 or 20 EMA" (HOD) | Spec §2, qualitative | **Pullback low within 0.5 × ATR14(1m) of EMA9 or EMA20 (1m)** | Operational |
| K-17 | "Single small red candle or bottom wick" (micro pullback) | Spec §6, qualitative | **Red candle with body ≤ 50% of the prior candle's range, or a candle whose lower wick ≥ 2× its body** | Operational; the wick ≥ 2× body comes from the sheet's hammer row |
| K-18 | "Immediate resolution" of a micro pullback | Spec §6 | **The entry order expires 2 bars after the signal**, and the stagnation stop applies after entry | Operational |
| K-19 | Reversal time window | None given | **09:35–15:30** (indicators warmed up from the prior session) | Operational: the whole session less the flatten buffer |
| K-20 | Attempts per stock | KB/sheet: max 2 per day · the entries' nature | GG-1 to GG-4 are **single-shot** (one level, one ORB, one fresh pattern, one reclaim). MP-1 and REV-1 allow up to 2 | Consistent with "first pullback" and ORB semantics |
| K-21 | Tier-1 price text | C5/C6 "$1–$10" · C7 "$1–$20" | **C7** | Owner, C7 (the later, explicit answer) |
| K-22 | Meaning of RVOL | Spec "2.0× average volume" | Gap scanner: **pre-market volume ÷ median same-window volume (20 sessions)**. Intraday: **cumulative volume ÷ (ADV20 × time-of-day share)**. Daily-projected RVOL is tagged | Scanner RVOL is time-of-day relative (Trade-Ideas convention) |
| K-23 | "Breaking news" breadth | Spec enum includes `breaking_news` | **Material company-specific news only:** contracts, partnerships, product or regulatory events, guidance. Generic PR (conferences, webinars) counts as `none` | Spec §1 "strong breaking news" |
| K-24 | Pre-staging vs first-minute volume | Spec §5/§8 pre-stage before 09:30 and "buy as/seconds before the break" · C2 ≥ 100k in the first minute | **Orders act from 09:31** (after the 09:30 bar shows ≥ 100k). A break inside the first minute is only tradable through the ORB/level break that follows. **Known limitation**, disclosed | Keeps the 100k must causal |
| K-25 | Level 2 signals | C4 depth signals · C10 Level 1 + Time & Sales | **Descriptive tags** from SIP trades and NBBO (TAP-01 to TAP-05); depth is `needs_data` | Owner, C10 |
| K-26 | Unrecorded splits (D22) | Plan: a 3x close-to-close jump fails closed · that would flag genuine 200% runners | **A jump near a common split ratio without a >= 5x dollar-volume surge** fails closed | Found during implementation; a real runner's dollar volume surges, a split's doesn't |
| K-27 | Pending-entry invalidation (D35) | Plan flagged it as missing | **Already implemented** in `engine.simulate`; covered by a test | Code review during implementation |
| K-28 | 5-minute and 2-minute bars (D36) | The existing helper groups rows positionally | **Clock-aligned buckets** for all SPEC-0001 code | Positional grouping drifts when a thin stock has minutes without trades |
| K-29 | Time-of-day volume curve (D37) | The HYP-0007 curve used all years and bar positions | **2019 only, by clock minute** | Removes mild look-ahead into the 2020+ out-of-sample span |
| K-30 | Entry collar vs spread slippage (D38) | The 10%-of-R collar silently capped fills at the limit | **Expected fill beyond the collar = no fill** for spec trials | Otherwise wide-spread costs vanish for tight stops (optimistic) |
