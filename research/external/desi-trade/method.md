# His method, in our words

A plain-English description of how @Desi_Trade trades, drawn from 1,305 original posts (2025-10-30 to
2026-11-05). Every claim cites post ids; open a post with `grep -h <id> posts/*.jsonl` or at
`https://x.com/Desi_Trade/status/<id>`. All results quoted are **his own claims**. The numbered, decision-ready
version is [`rules.md`](rules.md); how each point maps to our options clone is in
[`options-playbook.md`](options-playbook.md).

## 1. What he trades

- **Index first.** Most intraday trades are on /NQ and /ES (and their micros MNQ and MES), plus QQQ, SPY and SPX
  options taken off the same levels. He draws the levels on QQQ or SPY and trades the future: a break and retest of
  a QQQ level, traded on /NQ (2111106866952483213, 2110750020618109030).
- **Liquid single names on the options side**: META, AMD, NVDA, TSLA, PLTR, MSFT, MU, NBIS, HOOD, GOOG, AVGO.
  He avoids names with wide spreads (2042626980827287795).
- **Swings and a long-term book**: 1 to 3-month calls, LEAPS and shares bought into panics (1996652429677678844,
  2053566766534545456, 2118013487242957229).
- He says the same setup runs on options and futures alike (1985542644890501490).

## 2. Levels come first

- **Higher timeframe picks the level, lower timeframe gives the entry.** Find the level on the daily, weekly or
  4-hour chart; enter on the 1-minute to 1-hour chart for a tighter stop (2077476647893184740 and its thread;
  2053979790772691393).
- **Kinds of level he uses**: previous day high, low and close; pre-market high and low; overnight high and low;
  the open and the high and low of day; named prior swing highs and lows ("Thursday low", "October monthly low":
  2075179134871912916, 1991915295498534985); event candles such as the CPI high and FOMC low
  (2064720075756630206, 2070089697246810350); gap edges; the prior all-time high (2044809762609508436); the daily
  20, 50, 100 and 200-day averages (2082567992278221054); channel edges; volume voids (2036759795189907795,
  2097824918045901234); resting size (2009609702653788360); a Fibonacci "golden zone" (1985673732304650463).
- **Levels are zones**, typically 10 to 15 ES points wide, drawn from prior swing structure.
- **A level earns trust by being defended**: a prior double top that held as support on several daily closes
  before he sized in (2053979790772691393).
- **Structure**: in an uptrend, the old structure's highs must hold as the new structure's lows
  (2115468753357918478).

## 3. Four triggers, all of them a reaction at a level

He waits for price to react at the level before entering; the level alone is not the entry
(2097337957703197175).

| Trigger | What happens | Example posts |
|---|---|---|
| Break and Retest (B&R) | a level breaks, price comes back to it, it holds, price continues | 2064720075756630206, 2044809762609508436, 2053979790772691393 |
| Retest Rejection | a level fails, price retests it from the other side and rejects | 2117239630831714744, 1985542644890501490 |
| Reclaim Ripper | price sweeps below a low or demand, reclaims it, runs | 1987938181858107702, 2031049500023009727, 2054955036438851854 |
| Pop and Fade (trap) | price pushes above a high (pre-market high, PDH, HOD), fails back below, short | 2117290715336397290, 2079217000082006201 |

- **Bias flip**: when the fade he planned fails and the level holds, he takes the other side
  (2031049500023009727).
- **Entry timing**: the first pullback to VWAP or the EMA after the reaction (2051678736127312243,
  2069800886881104166); confluence of a retest, a VWAP trap and a 50% retracement (2018779249700683931);
  sometimes order-book absorption (2009700232846770348).

## 4. Gap rules

- Gap fill first, continuation second; buying a gap up is his weakness (1995910129867280672).
- Never short a gap down (1989376054751068176).
- Know where the 100-day average is before shorting the open (1991111860175999396).
- The morning short trap is the most dangerous trade on a recovery day (2019416830906081657).

## 5. When he does not trade: the No-Trade Zone

- Inside a range he does not trade options; he trades futures or nothing (2006033553759392017,
  2005694445497299029).
- Trades go only from channel edge to channel edge, never in the middle (2074067593250373746); if price stays in
  the range, stand aside (2069730473463456121, 1988938640903307289, 2092578371909669299).
- His losing periods were ranges: February's "channel of death" (2027082140362395733, 2027417728928129381,
  2026340261563973768) and six flat weeks in November and December 2025 (2001389839195775126).
- Forcing trades in chop is what loses money, not the chop itself (2112853495636185376).

## 6. Context he checks

- **Leaders**: the Nasdaq follows the semiconductors (2077425916712530392, 2072393762584645804,
  2056755125805351279); he also watches memory names, software, staples and small caps (2113647170918257080).
- **Higher-timeframe trend**: above the 200-day average, pullbacks are longs.
- **Events**: on FOMC days he trades before 14:00 (1998779952464855373); he trims before earnings
  (2085038221608571286); after an event, its candle is a level (2064720075756630206).

## 7. Options handling

- **Expiry fits the expected hold.** When moves stretch into the afternoon, short expiries decay before they pay
  (2049909177162551468); a poor expiry made him impatient, so he moved to later months (1998152669966290976);
  do not swing contracts that expire on Monday (2018327476926112092).
- **Vehicle fits the conditions.** Shares when the option premium or spread is poor (2036111194142986540,
  2042626980827287795); futures to hold without theta (2008244395381047801); a futures short to hedge an
  overnight stock option (1985514136382415231).
- **Implied volatility.** High-IV earnings weeks make option gains hard (2015848617748074945); after an event the
  IV drop hurts (2016903353997922348).
- **Exits are his stated edge.** Most traders exit too early on winners (2044889388900102164,
  2048146950982176837). He scales out in pieces (2118013487242957229, 2054283920628199877,
  2100659752959123756), trails the runner on an EMA "cloud" (2082506348042879287, 2098431182153155030,
  2044801611763982460), holds until there is a technical reason to exit (2057551009082204614), and re-enters
  when the setup resets (2013648198414356652).
- **Losers stay small.** Several small losses then one winner make the month (2037182718883066049,
  2037262649285661057).

## 8. Size and discipline

- One trade and done, as a rule he tested in March (2029584573756060141).
- His focus fades after the first hours; he trades his window and walks away (2110033606324220371,
  2110498812447830514).
- He scales down on volatile days and after a bad month, and builds consistency before sizing back up
  (2116188841237258690, 1991900269484105760).
- He sizes up only on a structure he calls size-up worthy (2036134925246611869, 2053979790772691393).
- His two largest losses came from trading on in a sideways market and from larger size in chop
  (2077787451939070190, 2087235306764505259).
- A red day must not carry into the next (2115877543035244691).

## 9. Regimes

The setup stays the same; holding period, vehicle and size change with the market. In trending months he holds
for days (2053566766534545456: most of May's profit came from swings). In ranges he takes base hits or stands
aside (2039040567061905554, 2001389839195775126). See [`timeline.md`](timeline.md).
