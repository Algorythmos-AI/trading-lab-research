# Him and the lab, side by side

What we already do, what we lack, and what happens to each gap. Status follows [`rules.md`](rules.md).

| Area | His practice | The lab today | Gap | Action |
|---|---|---|---|---|
| Instruments | /NQ, /ES and QQQ/SPY/SPX options off the same levels; liquid single names | US stocks, ETFs and their options; no futures | futures | rejected: the same levels on QQQ and SPY carry the same signal |
| Level source | daily, weekly and 4-hour charts, drawn as zones | `src/wt/options/levels.py`: day, week, month, pre-market, averages, supply/demand zones | swing highs and lows, event candles, gaps, prior ATH, overnight | new codes ONH/ONL, SWH/SWL, EVH/EVL, GAPH/GAPL, ATH (tag only) |
| Triggers | B&R, retest rejection, Reclaim Ripper, trap | OC-RETEST, OC-REJECT on 2-minute bars; O-RECLAIM-PDL on hourly closes | fast reclaim, trap | fast-reclaim arm HYP-0047 and trap arm HYP-0046 (shadow) |
| Time of day | 09:30 to about 11:00 | clone 10:00 to 14:30; B checked from 10:00 | afternoon trades he would skip | early arm HYP-0042/0043 (tag) |
| Ranges | no options trades in the middle of a range | `Tape.word` marks "range" but does not block | stand-aside rule | NTZ arm HYP-0034/0035 (tag) |
| Gaps | fill first; no gap-up longs; no early gap-down shorts | `levels.state` marks gaps; no rule uses it | gap rule | gap arm HYP-0036/0037 (tag) |
| Leaders | semis confirm Nasdaq trades | SPY versus VWAP gate | SMH gate for QQQ | leader arm HYP-0038/0039 (tag) |
| Events | trade before FOMC; trim before earnings; event candle as a level | FOMC and macro blackouts; earnings blackout | event candle level | new EVH/EVL codes |
| IV | avoids buying high IV | quotes carry IV; no rule uses it | IV cap | IV arm HYP-0040/0041 (tag) |
| Exits | scale out; trail a runner; technical exits | -25% stop, breakeven at +25%, +50% target, 5-minute time stop | the right tail | **runner arm HYP-0044/0045 (shadow), first priority** |
| Size | one and done; scale down after losses | 1 contract; 5 entries a day; loss latches | one-and-done rule | deferred |
| Expiry | matched to the expected hold | 0DTE or nearest | expiry rule | deferred |
| Swings | daily and weekly B&R, 1 to 3-month options, LEAPS | none | a swing family | deferred: needs its own spec |
| Discretion | sizes up on clean structure; reads order flow | none, by design | | rejected |

The arms are pre-registered in DEC-0041 (pull request #342) before any result is viewed. Tag arms place no orders; shadow arms log
virtual trades only. Neither changes EXP-0029.
