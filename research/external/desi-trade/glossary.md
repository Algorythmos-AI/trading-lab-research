# Glossary: his words, our codes

| His term | Canonical code in `posts/` | Lab equivalent | Meaning |
|---|---|---|---|
| B&R, B/R, break & retest | `BR` | OC-RETEST (HYP-0029) | a level breaks, price retests it, it holds |
| Retest rejection, bear-flag B&R | `RETEST_REJECT` | OC-REJECT (HYP-0030) | a failed level is retested from the other side and rejects |
| Reclaim Ripper | `RECLAIM_RIPPER` | O-RECLAIM-PDL (hourly); fast-reclaim arm HYP-0047 | a sweep below a low or demand, then a reclaim |
| Pop & fade, trap, fade into supply | `POP_FADE` | trap arm HYP-0046 | a push above a high fails back below |
| Gap fill, gap close reversal | `GAP_FILL` | `levels.state` GAP ABOVE/BELOW | trading toward or off an open daily gap |
| Weekly / daily / 4HR retest; Holy Grail | `HTF_RETEST` | none (swing family deferred) | a break and retest on a higher timeframe; the Holy Grail is the retest of the prior ATH |
| VWAP reclaim, VWAP retest | `VWAP_RECLAIM` | VWAP gate | entry defined by VWAP |
| Pullback long, 20DMA pullback | `PULLBACK` | none | buying a dip into a level |
| PDH / PDL / PDC | `PDH` `PDL` `PDC` | same | previous day high, low, close |
| **PMH / PML** (pre-market high, low) | `PMKH` `PMKL` | `PMKH` `PMKL` | **Our `PMH`/`PML` mean previous month.** His PMH is our PMKH. |
| Overnight high, low | `ONH` `ONL` | new | the Globex session's high and low |
| HOD / LOD | `HOD` `LOD` | same | high and low of day |
| Thursday low, Monday highs, October monthly low | `SWING_HIGH` `SWING_LOW` | new (SWH/SWL) | a named prior high or low |
| CPI high, FOMC low, data high | `EVENT` | new (EVH/EVL) | the high or low of an event's candle |
| P-ATH, previous ATH | `PRIOR_ATH` | new | the prior all-time high, now retested |
| 20/50/100/200DMA | `MA20` … `MA200` | MA20/50/200 | daily moving averages; "contract adjusted" means drawn on the futures contract |
| Supply, demand | `SUPPLY` `DEMAND` | supply and demand zones | zones where price reversed before |
| Volume void, low volume | `VOID` | none | a price area with little traded volume that price tends to move through fast |
| NTZ, no-trade zone | (kind or lesson) | NTZ arm HYP-0034/0035 | the middle of a range, where he does not trade |
| Cloud, ride the cloud | (lesson) | `Tape.ema_fast` trail | an EMA band (fast and slow EMA) used to trail a runner |
| Runners | (lesson) | runner arm HYP-0044/0045 | the part of a position kept after first profits |
| One & done | (lesson) | deferred risk rule | stop for the day after one good trade |
| LVLS, TTL ("Trust The Levels") | (promo) | none | his levels product and slogan |
| Lucid, TPT, Vanquish | (promo) | none | prop-firm accounts he trades |
| 0DTE | `option_0dte` | clone contracts | options expiring the same day |
| LEAPS | `leaps` | none | options more than 9 months out |
