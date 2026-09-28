# DEC-0010 — Round 3 pre-registration: SPEC-0001 (Warrior methodology)

- **Status: APPROVED, not yet in effect.** It takes effect when both conditions are met:
  1. ~~The owner approves SPEC-0001 v1.0.0.~~ **Met:** approved in chat on 2026-09-28; `spec.yaml` now says `status: approved`.
  2. The catalyst accuracy verdict (EXP-0015a, CAT-01) is recorded. **Open:** the owner's 20 blind labels are in, but the 19 disagreement verdicts are not. Interim result: sample 2 is at 84% decision level against a target of 85% (see `research/experiments/EXP-0015a-catalyst-accuracy/README.md`).

  Until it takes effect, no round-3 P&L may be computed or viewed. Counts-only runs are allowed (see the count guard below).
- **Date drafted:** 2026-09-28
- **Approved by:** owner, 2026-09-28 (in chat)
- **Specification:** `research/specs/SPEC-0001-warrior-methodology/spec.yaml` v1.0.0. Every rule and threshold comes from it; this record only freezes it. Configs are generated from it, and tests pin code defaults to it.

## Owner decisions (U1–U13)
The owner chose these in chat on 2026-09-28; they're recorded in `SPEC-0001/source/clarifications_2026-09-28.md` and `conflicts.md`:
- U1: historical + forward testing
- U2: catalyst labels by Claude, with owner review
- U3: the 25% flag rule is price retrace; each flag bar's volume < 50% of the pole's peak
- U4: former runner is a booster only
- U5: 3-tier funnel
- U6: hard price band $1–20, with $1.50–10 ordered first
- U7: the 5-minute rule is a stagnation stop
- U8: 1-minute ORB on the 2nd candle only, falling back to a 5-minute ORB, all expiring 09:50
- U9: time segments
- U10: Level 1 + Time & Sales proxies; 10-second bars from ticks
- U11: 90-session daily chart
- U12: 10 trials
- U13: private backup repo

## Trials: 10 (global trial count 75 → 85)
| Hypothesis | Trial | Hypothesis | Trial |
|---|---|---|---|
| HYP-0010 | F:GG-1 level break | HYP-0015 | P:GG-2 ORB ladder |
| HYP-0011 | F:GG-2 ORB ladder | HYP-0016 | P:GG-3 5-minute continuation |
| HYP-0012 | F:GG-3 5-minute continuation | HYP-0017 | P:GG-4 red-to-green |
| HYP-0013 | F:GG-4 red-to-green | HYP-0018 | MP-1 micro pullback |
| HYP-0014 | P:GG-1 level break | HYP-0019 | REV-1 reversal (long) |

B's DSR is recomputed at 85 trials and reported alongside.

## Data and method
- **Causal pool:** `scripts/build_pool.py` builds the pool from 09:00–09:25 full-universe snapshots, with split-adjusted gaps and chart musts measured as of each day.
- **Sets:**
  - **F** = the funnel's Tier 2 (≤ 4 names; the primary is funded first).
  - **P** = the frozen `ranking.yaml` Top-10 from the same pool, plus the chart musts. Catalyst is tagged only.
- **Execution musts:**
  - first-minute volume ≥ 100k (Gap and Go)
  - ≥ 1M shares (momentum)
  - spread ≤ $0.05 at the signal (unknown fails)
  - ≥ 2R of room
  - strict 10%-of-R collar (D38)
  - slippage = max($0.01, ½ the spread)
- **Exits:** `WT` for GG and MP-1: 50% at 2R, stop to breakeven, the runner exits on a broken prior 5-minute low or a 5-minute close below EMA9, and the 5-minute stagnation stop applies. `REV5` for REV-1. Flat at close − 10 minutes.
- **Day-level admission:** settled cash (T+1), 3 consecutive losers or −2R stops the day, max 2 attempts (the GG entries are single-shot), all at US$600 / 1,000 / 2,000.
- **Evaluation:** `scripts/r3_eval.py`, fixed-rule OOS 2020-01-01 → 2025-09-25 (2019 = warm-up; the single-variant families make walk-forward selection moot, D25).
  - **G1 gates:**
    - CI95 lower > 0 at 1.5× costs
    - DSR > 0.95 at 85 trials
    - random-entry control p < 0.05 (100 seeds through the same layers)
    - PF ≥ 1.2 at 1.5× costs
    - ≥ ⅔ of years profitable
    - no month > 25% of profit
    - n ≥ 100
- **Count guard (D16):** `--counts-only` runs write counts, never R. If a Set P trial has fewer than **60** dev trades, the musts are relaxed for Set P in this order, stopping as soon as it reaches 60, and each relaxation is recorded:
  1. window
  2. PM consolidation
  3. EMAs

  Set F is never relaxed; it's reported as descriptive if n < 100.
- **Holdout:** 2025-09-26 → 2026-09-25, run **once**, and only for trials whose OOS CI95 lower bound is > 0 (`r3_eval --holdout`).
- **Forward:** every trial also runs nightly in `forward_test.py` from the approval date onward.

## Disclosures: existing bugs found while planning round 3 (they affect earlier results)
| # | Bug | Effect on earlier work | Round 3 |
|---|---|---|---|
| D1 | The G1 watchlist builder chose what to fetch using the 09:30 open (prefilter open gap ≥ 2%) | Gappers that faded before the open were missing from G1 watchlists; this likely flatters the G1 S1/S5 results | Causal 09:25 snapshot pool |
| D2 | Daily bars are raw; reverse splits created fake gaps (5 Top-10 entries with gaps ≥ 400%, e.g. HUT 2023-12-04 +418%) and distorted any daily indicator across a split | G1 watchlists contain a few split artefacts | Point-in-time split factors; unrecorded splits fail closed |
| D7 | `forward_test.py` processes only the last completed session and writes the session marker even when a strategy fails | Missed or failed nights are lost | Catch-up and per-strategy markers (to be fixed outside the live window) |
| D24 | The G1 PMH-break entry order rested until flatten, so the W1–W3 windows were the same configuration | Three identical configs counted as three trials (conservative for DSR); 97% of fills were before 10:00 anyway | Orders expire |

G1 results are not re-run. Their conclusions stand with these caveats.

## Known limitations (accepted)
- **K-24:** orders act from 09:31, so a break inside the first minute is caught only by the ORB or level break that follows.
- **Level 2 depth is `needs_data`.** Tape features are descriptive.
- **10-second execution is proxied** by the 1-minute fallback.
- **The catalyst classifier's final accuracy** is set by EXP-0015a.
- **Survivorship:** Alpaca's inactive-asset list is incomplete (DEC-0003).
- **Small Set F:** the whole checklist is strict, so Set F n is expected to be small (the 2025-09-22/23 pools had 0 Tier-2 names).
