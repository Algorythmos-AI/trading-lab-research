# SPEC-0001 — Requirements

_Generated from `traceability.csv` for spec v1.0.0 (draft); spec.yaml sha256 `cf7886f04b93f2ba`. Do not edit by hand: run `scripts/spec_docs.py SPEC-0001`._

**112 requirements:** INFO 10, MUST 95, SHOULD 7. **Status:** n_a 2, needs_data 1, planned 109.

Levels:
- **MUST:** a hard rule, enforced by code and tested
- **SHOULD:** used for scoring or ordering
- **INFO:** recorded, or out of scope

Statuses:
- `planned`: not built yet
- `implemented`: code plus test
- `proxy`: implemented through an approximation
- `needs_data` and `n_a`: see `not_implementable` in spec.yaml

## Candidate pool

| ID | Level | Requirement | Operational definition | Source | Status |
|---|---|---|---|---|---|
| `POOL-01` | MUST | Universe is selected causally at 09:25 | 1-minute SIP bars 09:00-09:25 for every symbol with split-adjusted prior close $0.95-21; last print <= 09:25 is the price; nothing at/after 09:25 used (D1) | plan D1 | planned |
| `POOL-02` | MUST | Gap is measured against the split-adjusted prior close | gap = price_0925 / (raw prior close x f(d)/f(prev)) - 1 where f = raw/split-adjusted close (D2) | plan D2 | planned |
| `POOL-03` | MUST | Suspected unrecorded splits fail closed | close-to-close ratio within 3% of a common split ratio (>= 1.45x or its inverse) on a day whose dollar volume is < 5x its prior-20-day median -> symbol-day fails chart musts; genuine runners (dollar-volume surge) are not flagged (D22) | plan D22 | planned |
| `POOL-04` | MUST | News is point-in-time | headline created_at <= 09:25 (gap scanner) or <= t (HOD) | plan D17 | planned |

## Scanners

| ID | Level | Requirement | Operational definition | Source | Status |
|---|---|---|---|---|---|
| `SCN-GAP-01` | MUST | Price $1.00-20.00 | 09:25 price within [1.00, 20.00] | spec §1; C7 | planned |
| `SCN-GAP-02` | SHOULD | Prefer $1.50-10.00 | preferred band sorts first when choosing Tier 2 and the primary | spec §1; C7 | planned |
| `SCN-GAP-03` | MUST | Gap > +5% | gap_pct > 5.0 | spec §8; C5; conflicts K-01 | planned |
| `SCN-GAP-04` | SHOULD | Prefer gaps of 20%+ | gap subscore rises on a log scale to 50% | spec §1 | planned |
| `SCN-GAP-05` | MUST | Float < 50M | point-in-time SEC shares outstanding known and < 50,000,000 | spec §1; C5 | planned |
| `SCN-GAP-06` | SHOULD | Prefer float <= 20M (ideally <= 10M) | low_float subscore tiers 10M/20M/50M | spec §1 | planned |
| `SCN-GAP-07` | MUST | Pre-market volume >= 50k shares | sum of 04:00-09:24 1-minute volume >= 50,000 | spec §1 §8 | planned |
| `SCN-GAP-08` | MUST | RVOL >= 2.0 | pre-market volume / median same-window volume over 20 prior sessions (floor 1,000) >= 2 | spec §1 §7; C2; conflicts K-22 | planned |
| `SCN-GAP-09` | MUST | Strong catalyst required | best headline category in {earnings_release, fda_approval, clinical_study_results, price_target_upgrade, breaking_news} | spec §1 §7; C1; C2 | planned |
| `SCN-GAP-10` | MUST | Discard buyouts | any buyout_offer headline -> excluded | spec §1 §7; C2 | planned |
| `SCN-GAP-11` | MUST | Discard unconfirmed rumours | any unconfirmed_rumor headline -> excluded | C1; schema v1 | planned |
| `SCN-GAP-12` | INFO | 500k PM volume to trade pre-market | N/A-01 (no pre-market entries) | spec §1 | n_a |
| `SCN-HOD-01` | MUST | HOD scanner price $1.00-10.00 | price at t within [1, 10] | spec §2 | planned |
| `SCN-HOD-02` | MUST | Momentum trades need >= 1M shares | cumulative regular-session volume at t >= 1,000,000 | spec §2 §7; C2; conflicts K-11 | planned |
| `SCN-HOD-03` | MUST | HOD RVOL >= 2.0 | cumvol_t / (ADV20 x volume_curve(t)) >= 2; curve = mean cumulative share by clock minute from 2019 liquid names (D37) | spec §2 | planned |
| `SCN-HOD-04` | MUST | 5-minute volume surge >= 2000% | volume of the last 5 bars / (ADV20 x (curve(t) - curve(t-5))) >= 20; curve from 2019 by clock minute (D37) | spec §2; conflicts K-10 | planned |
| `SCN-HOD-05` | MUST | HOD float <= 20M | known point-in-time shares outstanding <= 20,000,000 | spec §2; conflicts K-12 | planned |
| `SCN-HOD-06` | MUST | New high of day | bar high >= regular-session high so far | spec §2 | planned |
| `SCN-HOD-07` | MUST | Spread <= $0.05 | NBBO ask-bid at t <= 0.05; unknown fails | spec §2; C4 §4; C10 | planned |
| `SCN-HOD-08` | MUST | HOD window 09:35-11:30 | qualification only in [09:35, 11:30) | C6 | planned |
| `SCN-HOD-09` | MUST | Catalyst present | required-category headline created <= t | C2; C6 | planned |
| `SCN-HOD-10` | INFO | Alerts: 52-week highs, daily breakouts, extreme volume | recorded as tags on MP-1 trades | spec §2 | planned |
| `SCN-REV-01` | MUST | Reversal price $15-250 | price at t within [15, 250] | spec §3 | planned |
| `SCN-REV-02` | MUST | Volume today >= 500k | cumulative volume at t >= 500,000 | spec §3 | planned |
| `SCN-REV-03` | MUST | 5-day ADV >= 300k | mean daily volume of the 5 prior sessions >= 300,000 | spec §3 | planned |
| `SCN-REV-04` | MUST | RVOL >= 1.0 | cumvol_t / (ADV20 x volume_curve(t)) >= 1 | spec §3 | planned |
| `SCN-REV-05` | MUST | >= 3 consecutive 5-minute down candles | last >= 3 completed 5m candles red | spec §3 | planned |
| `SCN-REV-06` | MUST | At or outside the lower Bollinger Band | 5m close <= BB(20, 2.0) lower band | spec §3 | planned |
| `SCN-REV-07` | MUST | RSI below 20 on 2m and 5m | RSI14 on the last completed 2m bar < 20 and on the 5m bar < 20 (prior-session warm-up, D8) | spec §3 | planned |
| `SCN-REV-08` | MUST | At low of day | signal 5m bar low == regular-session low so far | spec §3 | planned |
| `SCN-REV-09` | MUST | >= $0.30 to the 5m EMA9 and >= 2:1 | EMA9(5m) at signal - trigger >= max(0.30, 2R) | spec §3 | planned |
| `SCN-REV-10` | INFO | Overbought short side | N/A-02 (long only) | spec §3 | n_a |

## Catalyst classification

| ID | Level | Requirement | Operational definition | Source | Status |
|---|---|---|---|---|---|
| `CAT-01` | MUST | Classifier accuracy >= 85% on dev-span headlines | EXP-0015a: 100 stratified dev-span headlines; owner reviews disagreements and labels 20 blind | plan U2 D17 | planned |

## Selection funnel

| ID | Level | Requirement | Operational definition | Source | Status |
|---|---|---|---|---|---|
| `FUN-01` | MUST | Tier 1 = top 20 of the gap scanner | hard filters then v2 score; keep 20 | C6; schema v2 | planned |
| `FUN-02` | MUST | v2 scoring weights | 0.25 gap + 0.25 RVOL + 0.20 low float + 0.15 catalyst + 0.15 former runner | schema v2 | planned |
| `FUN-03` | MUST | Tier 2 = <= 4 names passing the chart musts | chart filters pass; take 4 by tier2_order | C6 | planned |
| `FUN-04` | MUST | Deterministic ordering with preferred band first | sort by (preferred band, score, rvol, gap, symbol) (D18) | C7; plan D18 | planned |
| `FUN-05` | MUST | Tier 3 primary | first Tier-2 name with an active PM pattern, else rank 1 | C6 | planned |
| `FUN-06` | MUST | Only Tier-2 names are traded at the open | GG entries in set F use Tier 2 only | C6 | planned |
| `FUN-07` | SHOULD | Former runner boosts score only | former_runner subscore; never a filter | C5 | planned |

## Daily and pre-market chart filters

| ID | Level | Requirement | Operational definition | Source | Status |
|---|---|---|---|---|---|
| `CHT-01` | MUST | Above daily EMA 20/50/200 | prior-day split-adjusted close > EMA20, EMA50, EMA200 of closes to the prior day; >= 200 bars | spec §4; C1; C2 | planned |
| `CHT-02` | MUST | Window taller than ATR14 | nearest overhead level (90 sessions: daily opens, closes, swing highs, prior-day high/close) - price > ATR14; blue sky passes | spec §4; C1; C12; conflicts K-13 | planned |
| `CHT-03` | MUST | Discard tightly stacked overhead resistance | implied by CHT-02 (no level within ATR14 above price) | spec §4 | planned |
| `CHT-04` | MUST | Clear trigger level exists | entry level defined (PMH / pattern apex / candle high) | spec §4; C2 | planned |
| `CHT-05` | SHOULD | Former runner definition | within 250 sessions: max high / prior min low >= 2 inside any 5-session window, or a day high >= 2x its low (split-adjusted) | spec §4; C5 | planned |
| `CHT-06` | MUST | Consolidating near the top of the pre-market range | every 1-minute low 09:10-09:24 >= PM low + 0.75 x (PM high - PM low) | spec §7; C2 | planned |
| `CHT-07` | MUST | Daily history is point-in-time split-adjusted | history rescaled by f(d)/f(t), f = raw/split-adjusted close (D2) | plan D2 | planned |

## Patterns

| ID | Level | Requirement | Operational definition | Source | Status |
|---|---|---|---|---|---|
| `PAT-01` | MUST | Bull flag pole 3-5 green candles | 3-5 consecutive green candles form the pole | sheet Bull Flag; C4 | planned |
| `PAT-02` | MUST | Flag of 1-3 candles | 1-3 consolidation candles after the pole | sheet Bull Flag; C4 | planned |
| `PAT-03` | MUST | Flag retraces <= 25% of the pole | (pole high - flag low) / (pole high - pole low) <= 0.25 | C4; conflicts K-03 | planned |
| `PAT-04` | MUST | Flag volume clearly lighter | each flag candle volume < 0.50 x the pole's peak-volume candle (< 0.30 tagged high-conviction) | C4; C12; conflicts K-15 | planned |
| `PAT-05` | MUST | Flag holds EMA9 | flag lows >= EMA9 of the same timeframe | sheet Bull Flag; C11 | planned |
| `PAT-06` | MUST | Flat top | >= 2 highs within $0.01 forming resistance; higher lows; holds EMA9 | sheet Flat Top; spec §5 | planned |
| `PAT-07` | MUST | ABCD | 5m: B = leg high, C = higher low above A, (B-C)/(B-A) <= 0.618, above EMA9; entry on the break of B | sheet ABCD; C11; conflicts K-09 | planned |
| `PAT-08` | MUST | Breakout needs a new volume spike | breakout bar volume >= 2 x average of the prior 20 bars (same timeframe, pre-market included); else exit next bar open (D32) | C11; C12; conflicts K-14 | planned |
| `PAT-09` | MUST | Pattern must be obvious and clear | pattern detectors enforce PAT-01..07; no discretionary override | C2 | planned |
| `PAT-10` | SHOULD | Pre-market bull flag / flat top on 1m-5m pre-market structure | active PM pattern at 09:25 on PM 5m bars; price in upper half of the flag | spec §1 §8; C1 | planned |
| `PAT-11` | MUST | Intraday bars are clock-aligned | 2- and 5-minute buckets are assigned by ET clock minute; the positional resample drifted on thin stocks with missing minutes (D36) | plan D36 | planned |

## Entries

| ID | Level | Requirement | Operational definition | Source | Status |
|---|---|---|---|---|---|
| `ENT-00` | MUST | Common entry mechanics | stop-limit at trigger +$0.01; stop -$0.01; orders act from the bar after the signal until meta expire_idx; a pending entry is cancelled if the stop trades first (already in engine.simulate; the D35 gap was a false alarm) | plan D35 | planned |
| `ENT-GG-1` | MUST | Pre-market high / pattern-apex break | 09:31-10:00; lowest unbroken of {PM pattern apex, PMH} above the 09:30 bar high; stop = pattern low or 09:30 bar low, max 20c; 1 attempt | spec §5; C11; plan D10 | planned |
| `ENT-GG-2` | MUST | ORB ladder | 1m ORB only on the 09:31 bar (stop = 1st candle low); else 5m ORB 09:35-09:50 (stop = 1st 5m candle low); 1 attempt | spec §5; C9; C11 | planned |
| `ENT-GG-3` | MUST | 5-minute continuation | 09:50-11:00; fresh 5m bull flag / flat top / ABCD formed after 09:45; trigger = pattern high; stop = pattern low; 1 attempt | C11; plan D11 | planned |
| `ENT-GG-4` | MUST | Red-to-green | 09:31-10:00; >= 1 close below the open, then the first candle making a new high above max(open, prior high); stop = LOD; 1 attempt | spec §5 | planned |
| `ENT-MP-1` | MUST | Micro pullback (1-minute fallback) | Tier-2 names 09:31-10:00 or SCN-HOD names 09:35-11:30; single small red candle or bottom-wick candle within 3 bars of a new HOD, near EMA9/20; trigger = its high; stop = its low; expires after 2 bars | spec §6; C10; conflicts K-16 K-17 K-18 | planned |
| `ENT-REV-1` | MUST | Reversal long | SCN-REV at a 5m close; trigger = exhaustion candle high (candle-over-candle) valid for 1 5m bar; stop = LOD; target = EMA9(5m) fixed | spec §3; C12; conflicts K-19 | planned |

## Execution musts

| ID | Level | Requirement | Operational definition | Source | Status |
|---|---|---|---|---|---|
| `EXE-01` | MUST | >= 100k shares in the first minute | 09:30 bar volume >= 100,000 for GG-1..4 | spec §7; C2 | planned |
| `EXE-02` | MUST | Spread <= $0.05 at the signal | NBBO at the signal minute; unknown spread fails (D28) | sheet; C4; C10 | planned |
| `EXE-03` | MUST | Minimum 2:1 reward-to-risk before entry | room to nearest overhead (daily levels + PMH above trigger) or to the target >= 2R (D14) | spec §7; C2 | planned |
| `EXE-04` | MUST | Entry and stop set before the order | EntrySignal carries trigger and stop; the stop never loosens | spec §7; C2 | planned |
| `EXE-05` | MUST | Never average down | no management style adds shares; qty never increases | spec §7; C2 | planned |
| `EXE-06` | MUST | Realistic costs | slippage per share = max($0.01, half the NBBO spread); stress 1.5x and 2x; an order whose expected fill (trigger + slippage) exceeds the 10%-of-R collar does not fill (D13, D38) | plan D13 | planned |
| `EXE-07` | MUST | Halts | gap of >= 5 minutes with no prints tagged as a halt; stop fills through the reopen gap | sheet LULD | planned |
| `EXE-08` | MUST | Technical analysis drives every decision | all entries and exits are defined levels, indicators or time rules (by construction) | spec §7; C2 | planned |

## Exits

| ID | Level | Requirement | Operational definition | Source | Status |
|---|---|---|---|---|---|
| `EXT-01` | MUST | Sell 50% at 2:1 and move the stop to breakeven | first target 2R (MP-1: its target); 50% (floor) then stop = entry | spec §5; schema v1 | planned |
| `EXT-02` | MUST | Partial needs >= 2 shares | qty < 2 exits 100% at the first target (D12) | plan D12 | planned |
| `EXT-03` | MUST | Runner exits on a broken 5-minute low | runner stop trails the prior completed 5m candle low | spec §5; C8 | planned |
| `EXT-04` | MUST | Runner exits below the 9 EMA | 5m close < EMA9(5m) -> exit next bar open | spec §5; C8 | planned |
| `EXT-05` | MUST | Breakout or bailout (stagnation stop) | at 5 minutes after entry, if first target not hit and close < entry + 0.5R -> exit | spec §7; C2; C8 | planned |
| `EXT-06` | MUST | No maximum trade duration | winning runners are not time-capped | C8 | planned |
| `EXT-07` | MUST | Micro-pullback target | next half or whole dollar above the trigger; must be >= 2R away | spec §6 | planned |
| `EXT-08` | MUST | Reversal target | 100% at EMA9(5m) fixed at the signal; stagnation stop applies | spec §3; plan D20 | planned |
| `EXT-09` | MUST | Never hold overnight | flatten 10 minutes before the (half-day aware) close | sheet Gap and Go | planned |

## Risk

| ID | Level | Requirement | Operational definition | Source | Status |
|---|---|---|---|---|---|
| `RSK-01` | MUST | Risk 1% of equity per trade | qty = floor(min(risk$/R, available settled cash/price)) | plan rev 7 | planned |
| `RSK-02` | MUST | Small-account viability | report at US$600, 1,000 and 2,000 | plan rev 7 | planned |
| `RSK-03` | MUST | Cash account settlement | entries consume settled cash; proceeds settle T+1; unfunded signals counted (D4) | plan D4 | planned |
| `RSK-04` | MUST | Stop after 3 consecutive losers | entry blocked if the trades exited before it end in 3 consecutive losers (D5) | sheet Small Account; KB | planned |
| `RSK-05` | MUST | Hard daily stop | entry blocked once realised day R <= -2 (D5) | sheet Small Account; C3 | planned |
| `RSK-06` | MUST | Max 2 attempts per stock per day | per trial; GG entries are single-shot | KB; conflicts K-20 | planned |
| `RSK-07` | SHOULD | Primary stock gets cash first | coincident signals funded in tier order | C6 | planned |

## Tape and Level 1 (descriptive)

| ID | Level | Requirement | Operational definition | Source | Status |
|---|---|---|---|---|---|
| `TAP-01` | INFO | Tape speed | trades/s in the 60 s before the trigger vs the prior 5 minutes | C4 §3; C10 | planned |
| `TAP-02` | INFO | Green prints | share of volume at/above the ask (quote rule, tick fallback) | C4 §1 §3; C10 | planned |
| `TAP-03` | INFO | Ask absorption proxy | green-print volume surge at the level with price change per 1,000 shares (little slippage); NBBO ask-size depletion | C4 §1; C10 | planned |
| `TAP-04` | INFO | Stepping-up bids | count of NBBO bid increases in the 60 s before the trigger | C4 §2 | planned |
| `TAP-05` | INFO | Tape freeze after entry | trades/s in the 30 s after entry vs the 60 s before | C4 §5 | planned |
| `TAP-06` | INFO | 10-second bars | built from SIP trades for 3 minutes either side of MP-1 signals; descriptive entry comparison | C10; C12; plan D33 | planned |
| `TAP-07` | INFO | Level 2 depth | N/A-04 needs a depth feed | C4; C10 | needs_data |

## Pre-market routine (forward dry run)

| ID | Level | Requirement | Operational definition | Source | Status |
|---|---|---|---|---|---|
| `RTN-01` | MUST | 08:00 Tier-1 scan | routine writes tier1.json at 08:00 | spec §8 | planned |
| `RTN-02` | MUST | 08:30 daily chart analysis | EMAs, windows, ATR, triggers, former runners | spec §8 | planned |
| `RTN-03` | MUST | 09:00 Tier 2 and pre-market structure | <= 4 names; PM flag / flat top | spec §8; C6 | planned |
| `RTN-04` | MUST | 09:15 primary and staged tickets | trigger, stop, 2R target, size from a read-only US$600 virtual account (D31) | spec §8; C6 | planned |
| `RTN-05` | MUST | Opening-window logs | ORB 09:30-09:50, Gap and Go 09:30-10:00, patterns 09:50-11:00, HOD 09:35-11:30 | spec §8; C6; C11 | planned |
| `RTN-06` | MUST | No broker calls; data-source agreement | dry run only; IEX live view plus SIP re-evaluation, agreement reported (D23) | plan D23 | planned |
| `RTN-07` | MUST | Sessions only | calendar check; exits on non-sessions; half-day aware (D29) | plan D29 | planned |

## Evaluation

| ID | Level | Requirement | Operational definition | Source | Status |
|---|---|---|---|---|---|
| `EVL-01` | MUST | Ten pre-registered trials | F and P x GG-1..4, MP-1, REV-1; global count 85 | plan U12 | planned |
| `EVL-02` | MUST | Fixed-rule out-of-sample test | OOS 2020-01-01 -> 2025-09-25; 2019 warm-up (D25) | plan D25 | planned |
| `EVL-03` | MUST | One-time holdout | only for a trial with OOS CI95 lower bound > 0 | DEC-0005 | planned |
| `EVL-04` | MUST | Counts-only guard | no R written; relax order window -> PM consolidation -> EMAs if a set-P trial has < 60 dev trades (D16) | plan D16 | planned |
| `EVL-05` | MUST | Comparable controls | random entries through the same cash, risk and exit layers; stop distance bootstrapped from the set (D26) | plan D26 | planned |
