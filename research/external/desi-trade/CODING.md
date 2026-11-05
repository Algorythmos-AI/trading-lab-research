# Coding rules

How each coded field in `posts/*.jsonl` is filled. A coder reads `text` (and `quoted_text` for context) and
applies these rules literally. **When a rule does not clearly apply, leave the field empty** (`null`, `[]`, or
`"none"`). Never guess a price, a time, or a result.

The schema is `schema.json`. The mechanical fields (`ts_et`, `session`, `text_clean`, `symbols`, `month`) are
computed by `scripts/external_posts.py` and are never hand-edited.

## kind (one value)

Pick the first that fits, in this order. `swing` comes first so that every position held past the session is
counted the same way. A futures trade opened and closed inside one overnight session is a `trade`; it becomes
a `swing` only when it is held across the cash open or close into another session. A `swing` needs a position he
says he holds; a higher-timeframe chart he likes but does not say he holds is a `plan`.

| kind | Use when the post... | Example |
|---|---|---|
| `swing` | is about a position held past the session: multi-day options or shares, LEAPS, the long-term portfolio, an overnight hold | "Picked up +50 shares on MCD off 2020/2022 structure.", "Still riding IBM runner" |
| `trade` | reports an intraday trade he took or is in: entry, exit, fill, P&L of that trade | "Shorted NQ on the loss of PDH and let it flush towards PDC." |
| `recap` | sums up a day, week or month of results, or reviews his own mistakes, without one main trade | "$36,889 to end September!", "Lost control today..." |
| `plan` | gives a forward-looking thesis or game plan with a condition or a level | "If we lose 7718 on ES, you have free fall into the 20DMA & 7650." |
| `level_call` | points at a level and how price reacted, without his own trade | "7774/7784 on the dot", "PDL on the dot." |
| `lesson` | states a general trading rule, habit or mindset | "Chop doesn't kill accounts. Forcing trades in chop does." |
| `promo` | advertises a product, stream, video, discount, giveaway, partner, or reposts praise | "Sunday Prep is LIVE", "use code DESI" |
| `personal` | is about anything else: sport, food, travel, family, house, jokes | "Best Burger in Chicago" |

A post that is a video link with a trading thesis is `plan` (or `recap`), not `promo`. A stream or video title with
no thesis ("Close the week strong!", "Eyes on the 20DMA today!") is `promo`. A watch with a view but no level or
condition ("Semis look strong") is `plan`. A post that is only a link or a one-word reaction ("Wow", "nice...") is
`personal` unless the quoted post makes it a trade. A post that praises a follower's trade is `promo`. A joke is
`personal` even when it names a ticker.

Three tie-breakers:

- **Content first.** A post that names a ticker but carries no trade, level, condition, result or rule ("$CAT is
  now an AI stock", "$ARM up 18% 😂", "Play nice for me $NQ") is `personal`.
- **His results are his trades.** "Clean 100pts on /NQ off our 29400 demand" or "$4,290 realized on $IWM" is a
  `trade` (or `swing`), even without "I". `level_call` is for a level that worked with no result of his.
- **Forward or past.** A view of what price may do next ("looks automatic here", "first sign of lower highs",
  "top watch", "must hold") is a `plan`. A reaction that already happened at a level ("on the dot", "perfect
  rejection", "what a level") is a `level_call`.
- **A general rule is a `lesson`**, even when a trade or chart illustrates it. A day of several trades with one
  total is a `recap`; one main trade is a `trade`.

`signal` is `true` exactly when kind is trade, plan, level_call, lesson, recap or swing.

## setups (zero or more)

Name a setup only when the post states it or describes it unambiguously.

| code | His words | Meaning |
|---|---|---|
| `BR` | break & retest, B&R, B/R, retest long, "old resistance becomes support" | price breaks a level, retests it, holds, continues |
| `RETEST_REJECT` | retest rejection, bear-flag B&R, "fail back below ... retest" | price fails a level, retests it from the other side, rejects |
| `RECLAIM_RIPPER` | Reclaim Ripper, PDL reclaim, "sweep the lows and reclaim" | price sweeps below a level, then reclaims it and runs |
| `POP_FADE` | pop & fade, trap above PMH/PDH/HOD, fade into supply, "sweep over HOD" | push above a level, fail back below, short |
| `GAP_FILL` | gap fill, gap close reversal, "fill the gap" | trade toward or off an open daily gap |
| `HTF_RETEST` | weekly / daily / 4HR retest, "Holy Grail" (retest of prior ATH) | break-and-retest seen on a higher timeframe, usually a swing |
| `VWAP_RECLAIM` | VWAP reclaim, VWAP retest, first pullback to VWAP | entry is defined by VWAP |
| `PULLBACK` | pullback long into demand, 20DMA pullback, dip into level | buying a pullback into a level without a break first |
| `OTHER` | a setup is named but fits none above (H&S, bear flag alone, ORB, volume void) | |

## vehicle (one value or null)

Only when the post says it. A percent gain on a stock ("100% on $QQQ") strongly suggests options but is not
stated: leave `vehicle` null. `future` (/NQ /ES /MNQ /YM /GC ...), `option_0dte` (same-day, "0DTE", SPX scalp), `option_short` (expires within
14 days; weeklies), `option_swing` (15 days to 9 months: "January calls", "June contracts"), `leaps` (over 9 months
or called LEAPS), `shares`, `mixed` (two or more of these in one trade). Null when not stated. An options trade on
the day with no expiry stated is `option_0dte` only if he trades it intraday and calls it 0DTE or SPX; otherwise
`option_short`.

## direction

`long`, `short`, or `neutral` (a two-sided plan, e.g. "Retest Rejection or Reclaim Ripper?"). Null for non-signal
posts and for lessons.

## levels (zero or more)

Only numbers he writes. One object per number: `{"symbol": "NQ", "price": 29400, "type": "DEMAND"}`. A zone
written "7774/7784" is `{"price": 7774, "price_hi": 7784}`. Types:

PDH PDL PDC (previous day high, low, close) · PMKH PMKL (**pre-market** high and low; he writes "PMH", which in
this lab means previous *month*, so we store PMKH) · ONH ONL (overnight) · HOD LOD · OPEN (opening print or wick) ·
SWING_HIGH SWING_LOW (named prior highs and lows: "Thursday low", "August channel lows", "October monthly low") ·
EVENT (CPI high, FOMC low, data high) · GAP · PRIOR_ATH · ATH · MA20 MA50 MA100 MA200 (daily moving averages) ·
CHANNEL · SUPPLY · DEMAND · VOID (low-volume area) · TARGET · PIVOT (an inflection level of no other kind).

Also ENTRY: his own fill price with no level named ("Long 25,700 $NQ", "Shorting ES off 6,950"). When he names
the level he traded off ("retest long off the 30,964 demand"), store that level's type, not ENTRY.

- Use only numbers in the post's own `text`, never numbers that appear only in `quoted_text`.
- The post must name the instrument the number belongs to (SPY 674 is `SPY`, not `ES`). If it names none, store
  no level; do not infer it from earlier posts or from the price.
- A shorthand number may be expanded only from a full number in the same post ("targets down at 44 & 42" after
  "6,950" on ES gives 6944 and 6942).
- A moving average named without a number is not stored.

## entry_time_et

`HH:MM` only when the post states the entry time ("the flip between 10:08-10:16" gives `10:08`) or a fill table
in the text shows it. Never use the post time.

## outcome_claim and the claim numbers

- `outcome_claim` follows the post's main subject: the trade for `trade` and `swing`, the period for `recap`.
  `win` or `loss` when he says so in words or numbers ("green", "W", "nice day", "+$4,716"), `scratch` for
  breakeven, `none` otherwise. Unrealized gains or losses are `none`. A month recap takes the sign of its net figure.
- `pnl_usd_claim`: the realized or stated dollar figure for that same subject, signed ("-$14,117" gives -14117;
  "$10,000/day" gives 10000). On a `trade`, a month-to-date or year-to-date figure is not the trade's result:
  leave it null. On a `recap`, use the figure for the period the post is about. Slang amounts ("5 rackys") are
  null. Unrealized figures are stored only on `swing` posts.
- `pct_claim`: percent return he states on the trade ("100% runners" gives 100).
- `points_claim`: index or futures points he states ("40pts on /ES" gives 40).

## lesson

For every signal post: one sentence of **at most 25 words, in our own plain English**, saying what an options
trader should take from it. Not a copy of his wording. Examples:

- "Wait for a failed push above the pre-market high to close back below before shorting; take profit into the
  flush."
- "In a sideways range he stops trading options; the losses come from forcing trades inside it."
