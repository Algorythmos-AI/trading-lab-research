# His playbook as numbered rules

Each rule is one claim, in our words, with the posts it rests on and what the lab does with it. **Status**:

- **testing**: pre-registered as a research arm on the options clone (family O, DEC-0041, HYP-0034 to HYP-0047).
- **have**: the lab already does this.
- **deferred**: worth doing, needs its own spec or decision first.
- **rejected**: not for this lab, with the reason.

Post ids are in `posts/*.jsonl`. His results are claims, not evidence; a rule is adopted only when our own test
passes.

## Levels

| # | Rule | Posts | Status |
|---|---|---|---|
| R01 | Mark levels before the open from the daily, weekly and 4-hour charts; trade only at them. | 2077476647893184740, 2053979790772691393 | have (levels engine, focus plan) |
| R02 | Treat levels as zones, not single prices. | 2053979790772691393 | have (`merge_zones`, supply and demand bands) |
| R03 | Trust a level more after it has been defended on several daily closes. | 2053979790772691393 | deferred (level-strength score) |
| R04 | Use named prior swing highs and lows, event candles (CPI high, FOMC low), gap edges and the prior ATH as levels. | 1991915295498534985, 2064720075756630206, 2070089697246810350, 2044809762609508436 | deferred (new level codes; built next, logged only) |
| R05 | Use the pre-market and overnight high and low. | 2117290715336397290 | have pre-market (PMKH/PMKL); overnight is new (ONH/ONL) |

## Triggers

| # | Rule | Posts | Status |
|---|---|---|---|
| R06 | Break and retest: enter when a broken level is retested and holds. | 2064720075756630206, 2044809762609508436 | have (OC-RETEST) |
| R07 | Retest rejection: enter when a failed level is retested from the other side and rejects. | 2117239630831714744 | have (OC-REJECT) |
| R08 | Reclaim: after a sweep below a low or demand, enter on the reclaim, on a fast bar, not an hourly close. | 1987938181858107702, 2031049500023009727, 2054955036438851854 | testing (fast-reclaim arm HYP-0047, shadow) |
| R09 | Trap: after a push above a high fails back below, enter short. | 2117290715336397290, 2079217000082006201 | testing (trap arm HYP-0046, shadow) |
| R10 | Wait for the reaction at the level; never enter on the touch. | 2097337957703197175 | have (closed-bar triggers) |
| R11 | Enter on the first pullback to VWAP or the EMA after the reaction. | 2051678736127312243, 2069800886881104166 | have (entry within 1.5 ATR of EMA9) |
| R12 | When the planned fade fails and the level holds, take the other side. | 2031049500023009727 | deferred |

## Context and when not to trade

| # | Rule | Posts | Status |
|---|---|---|---|
| R13 | Do not trade options inside a range; trade only from edge to edge. | 2006033553759392017, 2074067593250373746, 2069730473463456121 | testing (NTZ arm HYP-0034/0035, tag) |
| R14 | Do not buy into an unfilled gap up before it fills; never short a gap down early. | 1995910129867280672, 1989376054751068176, 1991111860175999396 | testing (gap arm HYP-0036/0037, tag) |
| R15 | For Nasdaq trades, the semiconductors must agree. | 2077425916712530392, 2072393762584645804 | testing (leader arm HYP-0038/0039, tag) |
| R16 | Trade the first hours; focus and edge fade by midday; no late-day trades. | 2110033606324220371, 2110498812447830514 | testing (early arm HYP-0042/0043, tag) |
| R17 | On FOMC days trade only before the statement. | 1998779952464855373 | have (FOMC blackout) |
| R18 | Above the daily 200-day average, pullbacks are longs. | 2082567992278221054 | deferred (trend context) |

## Options handling

| # | Rule | Posts | Status |
|---|---|---|---|
| R19 | Scale out; let a runner trail on the fast EMA to the next level. | 2044889388900102164, 2118013487242957229, 2082506348042879287 | testing (runner arm HYP-0044/0045, shadow) |
| R20 | Keep losers small; expect several small losses per big winner. | 2037182718883066049, 2037262649285661057 | have (premium stop, latches) |
| R21 | Avoid buying options when implied volatility is high, as in earnings weeks. | 2015848617748074945, 2016903353997922348 | testing (IV arm HYP-0040/0041, tag) |
| R22 | Do not hold options through earnings. | 2085038221608571286 | have (earnings blackout) |
| R23 | Pick the expiry from the expected hold; longer when moves extend into the afternoon. | 2049909177162551468, 1998152669966290976 | deferred (expiry rule) |
| R24 | Skip the option when the spread or premium is poor. | 2036111194142986540, 2042626980827287795 | have (spread cap, skip) |
| R25 | Do not swing contracts that expire on Monday. | 2018327476926112092 | deferred (with R23) |

## Size and discipline

| # | Rule | Posts | Status |
|---|---|---|---|
| R26 | One trade and done after a winner. | 2029584573756060141 | deferred (risk rule arm) |
| R27 | Scale down on volatile days and after a losing month. | 2116188841237258690, 1991900269484105760 | deferred |
| R28 | Size up only on the cleanest structure. | 2036134925246611869 | rejected: discretionary |
| R29 | Never let one red day carry into the next. | 2115877543035244691 | have (daily latch resets) |

## Regimes and other

| # | Rule | Posts | Status |
|---|---|---|---|
| R30 | Hold for days in a trend; take base hits or stand aside in a range. | 2053566766534545456, 2001389839195775126 | deferred (swing family spec) |
| R31 | Trade futures in ranges to avoid theta. | 2005694445497299029, 2008244395381047801 | rejected: no futures in this lab |
| R32 | Read inter-market moves (10-year yield, oil, bitcoin). | 2113647170918257080 | rejected: hard to pre-register without overfitting |
| R33 | Read order-book absorption. | 2009700232846770348 | rejected: no data |
