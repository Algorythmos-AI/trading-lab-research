# Owner clarifications, 2026-09-28 (recorded verbatim)

These are the owner's answers in chat to the questions raised while SPEC-0001 was planned. Bracketed
numbers such as [1] are the owner's citations into their own source notes, which aren't held in this repo.
Each "Q" is the question as it was asked. Each "A" is the owner's answer, unedited except for Markdown
indentation.

---

## C1 — Scope: which items are in scope (message "Trading setup and scanning rules")

1. The $1.50–$2.00 Price Slice
   * In Scope: Ross Cameron's Gap Scanner criteria explicitly defines the preferred stock price range as $1.50 to $10.00. In some Trade-Ideas scanner filter configurations, the absolute price minimum is set as low as $1.00. Excluding stocks in the $1.50–$2.00 range would miss valid low-float Gap and Go candidates that meet preferred criteria.
2. Pre-Market Bull Flag & 1-Minute Bars
   * In Scope: Evaluating the pre-market chart for a pre-market bull flag or flat-top consolidation is an explicit step on the pre-market checklist. Because entry triggers (such as the pre-market high or opening range breakout) are defined using 1-minute and 5-minute intraday bars during extended hours, pre-market 1-minute bar data is essential for charting and strategy execution.
3. Discretionary "Clean Chart / Windows" Criterion
   * In Scope: Having a "clean daily chart with windows and triggers" is explicitly listed as item #9 on the core momentum trading checklist.
     * A clean chart requires the stock to trade above key daily moving averages (20, 50, and 200 EMA) with clear technical levels.
     * A window refers to a gap on the daily chart where there is no overhead support or resistance, allowing the stock room for a swift price move.
4. Catalyst-Classifier Check
   * In Scope: Determining and classifying the fundamental catalyst is a mandatory requirement before adding a stock to the daily watch list. The strategy mandates verifying high-quality breaking news (such as FDA approvals, earnings leaks, or clinical trial results) while filtering out poor catalyst types, such as buyout offers or unconfirmed rumors.

## C2 — The "musts" (message "can you make sure these are included")

### 1. Scanner & Stock Selection "Musts"
* **Disregard Buyouts**: Any stock appearing on the gap scanner that is gapping due to a buyout **must** be disregarded and skipped immediately, as its price is fixed and lacks trading opportunity.
* **Understand the Catalyst**: When a stock surges pre-market, traders **must** understand the fundamental reason behind the move by researching press releases (e.g., earnings, FDA approvals, clinical trials, or price target upgrades).
* **Pre-Market Consolidation**: Gap and Go contenders **must** be consolidating near the top of their pre-market range, with a fundamental catalyst actively driving the move.
* **Clean Daily Chart**: The daily chart **must** be clean, displaying clear "windows" (open chart room) and "triggers" (breakout levels).

### 2. Momentum & Gap and Go Mandatory Entry Requirements
* **Volume at the Open**:
  * **Gap and Go Trades**: **Must** have at least **100,000 shares of volume** in the first 1 minute of trading at the market open.
  * **Momentum Trades**: **Must** have at least **1,000,000 shares of volume**.
* **Relative Volume (RVOL)**: The stock **must** exhibit high relative volume of at least **2.0 or higher**.
* **Profit-to-Loss Ratio**: Every trade setup **must** allow you to reasonably achieve at least a **2:1 profit-to-loss ratio** before entering.
* **Pattern Clarity**: The technical chart pattern **must** be obvious and clear.
* **Predetermined Risk Levels**: The entry price and stop-loss price **must** be determined before placing the order.

### 3. Risk Management & Execution "Musts"
* **Immediate Resolution ("Breakout or Bailout")**: Apex entries require immediate volume and price movement; if a trade does not work within **5 minutes**, you **must** cut the position to keep losses minimal.
* **No Dollar Cost Averaging**: Traders **must never** dollar cost average or add shares to a losing position.
* **Mandatory Technical Analysis**: Day traders **must** use technical analysis tools and market data indicators to guide every entry and exit decision.

## C3 — The five areas to cover (message "check again if you have these all")

* **Scanner Thresholds & Filter Criteria**: Exact parameters for Pre-Market Gap Scanners[1], High-of-Day Momentum Scanners[3], and Reversal Hybrid Scanners.
* **Daily & Intraday Technical Filters Checklist**: Key moving average alignments (20, 50, 200 EMA)[4], chart window/ATR requirements[5], and pre-market structure verification[4].
* **Strategy Execution Rules**: Precise entry triggers, stop-loss placements, and profit targets for both **Gap and Go**[6] and **Micro Pullback** strategies[9][10].
* **Daily Pre-Market Routine Timeline**: Step-by-step workflow from 8:00 AM to 10:00 AM EST for building watch lists and staging orders[11][12].
* **Mandatory Risk Management Disciplines**: Core rules including the 2:1 profit-to-loss ratio[13][14], the "Breakout or Bailout" rule[15], hard daily stop limits, and the strict no-averaging-down policy[15][16].

Sources supplied with it: the spec text (`spec_text_2026-09-28.txt`), schema v1 (`schema_v1.json`) and the
indicators sheet (`indicators_sheet_2026-09-28.csv`, from
https://docs.google.com/spreadsheets/d/1d0Ko69EvHUpHtipnRXAaubpoF6EYFzRqdVz43QeWQCc).

## C4 — Q: What does the bull-flag "less than 25% of initial move" apply to?

A: the **25% limit applies to the price retracement of the initial breakout move (the "flagpole")**[1].

Specifically, Ross Cameron states: *"The best bull flags will pullback less than 25% of the move"*[1].

* **Price Retracement (25% Rule)**: If a stock surges **$1.00** on its initial move (e.g., rising from $4.00 to $5.00), the healthiest bull flag will pull back **no more than $0.25** (holding above $4.75) before consolidating and breaking out again[1]. A shallow pullback of less than 25% indicates that buyers remain aggressively in control and sellers are unable to push price down[1][2].
* **Volume Requirement**: During the 1–3 pullback candles forming the flag, volume **must decrease significantly** relative to the initial breakout surge[2]. Light volume during the pullback confirms a lack of selling pressure; conversely, heavy volume during the pullback is a warning signal that shorts or profit-takers are entering, increasing the risk of a trend reversal[3].

### Level 2 & Tape-Reading Signals for Bull Flag Breakouts

When trading a Bull Flag setup, Level 2 (Market Depth) and Time & Sales (The Tape) provide the real-time confirmation needed to time the entry right before the price surges[1][2].

1. **Heavy Ask Absorption at the Breakout Apex**
   * **The Setup**: A large seller or "ask wall" often sits at the breakout level, apex point, or whole/half-dollar mark[2][3].
   * **The Signal**: Instead of avoiding the large seller, watch Time & Sales for **large green prints** (orders executed at the ask) rapidly buying up shares[4].
   * **The Trigger**: As the large ask size is rapidly absorbed down to the last remaining shares, place the buy order right before the level breaks to catch the breakout momentum[1].
2. **Stepping-Up Bids (Visual Floor of Support)**
   * **The Setup**: Bids on the left side of Level 2 begin stacking higher or a large buyer steps up directly below the consolidation range[1].
   * **The Signal**: A strong buyer appearing on the Bid provides a **visual level of support**, giving confidence that the price is held up while the ask is tested[1][3].
3. **Speed & Color of the Tape (Time & Sales Streaming)**
   * **The Setup**: Time & Sales transition from slow or mixed prints to a **rapid, continuous stream of green**[5][6].
   * **The Signal**: Fast green tape confirms that both momentum buyers and short sellers covering their positions are aggressively taking liquidity at the Ask[5].
4. **Tight Bid-Ask Spreads**
   * **The Setup**: The spread between the highest bid and lowest ask should be **$0.05 or less**[11].
   * **The Signal**: Tight spreads ensure high liquidity and minimal slippage during entry and exit, whereas wide spreads indicate higher risk and erratic price moves[11].
5. **Warning Signals on Level 2 (False Breakout Indicators)**
   * **Tape Freezing**: If Time & Sales suddenly slows down or grinds to a halt immediately after entry, momentum has stalled[2][5].
   * **New Ask Walls**: A massive new sell order suddenly appearing on the Ask right after the initial breakout attempt[12].
   * **Execution Rule**: If resolution is not immediate or the tape freezes, exit breakeven or cut the position quickly ("breakout or bailout")[2].

## C5 — Q: Should former-runner history be a hard requirement?

A: framework, **a former runner history is a high-priority preference and validator, rather than an absolute mandatory binary filter**[1][2].

Why it should be false (or a ranking booster) in a strict JSON schema:
1. **Definition**: Ross Cameron defines a former runner as a stock that has made intraday moves or parabolic daily chart moves in excess of **100%+ over a few days in the past**[1].
2. **Role in Selection**: Former runner status confirms that a ticker has the chart memory, liquidity, and retail interest required for "home-run" breakouts when new catalyst news hits[1].
3. **Hard vs. Soft Filter**: The core mandatory scanner filters that a stock **must** meet to be considered on the Gap Scanner are **price ($1.00–$10.00), gap % (>+5%), float (<50M), relative volume (RVOL >= 2.0), and a news catalyst**[2][3].
4. **Impact of a Hard Constraint**: Setting `former_runner_history_required: true` in a hard schema filter would mistakenly reject valid first-time gappers, recent IPOs, or new catalyst breakouts that meet all primary momentum criteria[2][3].

Recommended JSON adjustment: `former_runner_history: {required: false, description: "Verification of prior 100%+ multi-day moves. Used to boost watchlist priority score rather than hard-reject candidates."}`

## C6 — Q: Which watch-list depth should the faithful set trade?

A: methodology, the **Top-10 scanner view** and the **2–3 stock watch list** are not in conflict — they represent two different stages of a **3-tier selection funnel**[1].

* **Tier 1: Scanner Pool (Top 10–20 Results)** — the raw quantitative discovery pool[2]. Filters the entire market down to stocks meeting baseline rules (gapping >+4/5%, float <50M, price $1–$10, pre-market volume >50k)[2].
* **Tier 2: Daily Watch List (Top 2–4 Candidates)** — the qualified watchlist after qualitative screening[1][3]. By 9:15 AM EST, you filter the Top 10 down to **2–4 stocks** by verifying strong fundamental news catalysts (and discarding buyout offers) and inspecting daily charts for clean "windows and triggers"[1].
* **Tier 3: Primary Watch Stock (The #1 Focus)** — the main execution candidate for the 9:30 AM market open[1][5]. The single stock with the highest gap %, heaviest relative volume, cleanest pre-market bull flag or flat-top consolidation, and strongest news catalyst[1]. Order entry windows and hotkeys are pre-staged specifically for this ticker between 9:15 AM and 9:30 AM EST[1][5].

Which should the faithful set trade?
* **At Market Open (9:30 AM – 9:35 AM EST)**: Trade **strictly from the Top 2–4 Watch List, prioritizing the Primary Watch Stock (#1)**[1][5]. Ross Cameron specifically warns that monitoring or jumping across 10 stocks at the open causes split attention, leading traders to miss apex entry triggers or get chopped up[4].
* **Intraday Trading (9:35 AM – 11:30 AM EST)**: Re-open the aperture to watch the broader **High-of-Day Momentum Scanner**[11][12]. This captures midday news releases, secondary bull flags, or fresh volume breakouts on stocks that were not part of the initial pre-market watch list[11].

(Schema v2 supplied with this answer: `schema_v2.json`.)

## C7 — Q: Which is the hard price filter for the faithful set?

A: For the faithful set, the true hard scanner filter is **$1.00 to $20.00**, while **$1.50 (or $1.00) to $10.00** is the preferred focus range used for ranking. The Trade-Ideas Gap Scanner hard parameters are set with a $1.00 floor and a $20.00 ceiling so that higher-priced low-float runners are not inadvertently blocked from the Tier-1 discovery pool, whereas the $1.50 to $10.00 range represents the sweet spot where retail buying power generates the highest momentum leverage. Therefore, any stock between $1.00 and $20.00 validly enters the initial scanner pool, but candidates sitting in the $1.50 to $10.00 window receive higher priority scoring when filtering down to the Tier-2 watchlist and Primary Watch Stock.

## C8 — Q: The 5-minute rule: a stagnation stop or a hard maximum trade duration?

A: The rule is a **conditional time stop ("Breakout or Bailout")**, not a hard 5-minute limit on trade duration.

* **Conditional Time Stop (The Actual Rule)**: When entering a momentum trade at the apex or breakout level, you expect **immediate resolution**. If the stock sits sideways, freezes, or fails to break out within **~3 to 5 minutes**, the lack of immediate buying volume indicates weakness, triggering an exit ("bailout") to free up capital.
* **Winning Trades (No Hard Time Cap)**: If the trade *does* break out as expected, you **do not** close the entire position at 5 minutes. Instead, you scale out partial profits at your target (e.g., 2:1 R/R) and hold the remaining runner as long as price holds above the 9 EMA or previous 5-minute lows — which can last for **15, 30, or 60+ minutes**.

Corrected JSON (`execution_rules_correction.json`): `time_stop_unresolved_minutes: 5`, `max_trade_duration_minutes: null`, `exit_on_stagnation: true`.

## C9 — Q: Does a 1-minute ORB break on a later candle count?

A: **No, a break on a later candle does not count as a 1-minute Opening Range Breakout (ORB)**.

* **Strict 1-Minute ORB Definition**: The 1-minute ORB specifically requires the **second 1-minute candle** to break above the high of the first 1-minute candle.
* **Transitioning to 5-Minute Chart / Pullbacks**: If the 1-minute ORB does not trigger in those first couple of minutes, Ross Cameron does not keep waiting for a delayed 1-minute break. Instead, he **switches to the 5-minute chart** to look for a **5-minute ORB** or waits for the **first pullback setup** (such as a 1-minute/5-minute bull flag, flat-top breakout, or 9 EMA touch).
* **15–20 Minute Cut-off**: If an ORB setup fails to form within the first **15 to 20 minutes** of the market open (by ~9:45–9:50 AM EST), he abandons that stock and moves on to another candidate on his watch list.

If a stock consolidates after the open and breaks out on a later candle before 10:00 AM EST, it is classified and traded as a **bull flag or flat-top breakout**, not a 1-minute ORB.

## C10 — Q: How should Level 2 depth and 10-second charts be handled without that data?

A: Use technical proxies and alternative timeframe structures directly supported by Trading principles:
1. Handling Level 2 Depth (Ask Walls & Stacked Bids): Use Level 1 (Top-of-Book) + Time & Sales: Ross Cameron explicitly notes that he does not subscribe to full Level 2 depth (like Nasdaq TotalView), finding it displays too much information; instead, he relies on top-of-book Level 1 data and trade prints. Volume Spikes as Proxy for Ask Walls: Track real-time volume surges on trade executions at key psychological thresholds (whole and half-dollar levels, or pre-market highs). A massive surge in green prints (trades executed at the ask) with minimal price slippage signals that a heavy ask wall is actively being absorbed. Spread Threshold Filter: Use Level 1 top-of-book bid/ask quotes to enforce the strict bid_ask_spread <= $0.05 constraint, ensuring tight liquidity before entering.
2. Handling 10-Second Charts (Micro Pullbacks): 1-Minute Wick & Small Candle Representation: On standard 1-minute or 5-minute charts, a 10-second micro pullback appears structurally as a single tiny red candle or a 1-minute candle with a long lower wick before price surges higher. 1-Minute High Breakout Fallback: Rather than needing sub-minute bars, trigger entries when the price crosses above the high of the single 1-minute pullback candle or lower wick. Tick-Data Aggregation: If your free data feed includes raw trade prints (Time & Sales), you can programmatically aggregate those raw trade ticks into custom 10-second OHLC bars inside your application logic without paying for pre-built 10-second chart vendor feeds.

## C11 — Q: How does the ~9:50 cutoff apply?

A: The **~9:50 AM (15–20 minute) cutoff applies specifically to the Opening Range Breakout (ORB) strategy setup**, rather than serving as an absolute block on the stock itself.

1. **Why the 9:50 Cutoff Applies to ORBs** — Peak Open Volatility: the 1-minute and 5-minute ORB strategies rely on the immediate, explosive volume that occurs right when the market bell rings at 9:30 AM EST. ORB Expiration: if a stock fails to break out above its opening 1-minute or 5-minute candle high within the first 15 to 20 minutes (by ~9:45–9:50 AM EST), the initial open-driven momentum has dissipated; attempting a delayed "ORB" carries high risk of chop or a false breakout.
2. **How Later Consolidation Setups Work (9:50 AM – 10:30/11:00 AM)** — Pattern Transition: if a stock does not trigger an ORB but stays above its key moving averages on high relative volume, it transitions into a standard **5-minute Bull Flag, Flat-Top Breakout, or ABCD pattern**. New Technical Anchor: these later breakouts (9:50 AM – 10:30+ AM) are not judged by the opening candle; they require a fresh multi-candle consolidation (an orderly pullback to the 9 EMA or a 5-minute flat-top resistance level) and a new volume spike as the breakout apex breaks.
3. **Engine structure**

| Time Window | Active Strategy Classifier | Evaluation Criteria |
|---|---|---|
| 9:30 AM – 9:50 AM EST | 1-Min / 5-Min ORB | High of 1st 1-min or 5-min candle; requires immediate open volume. |
| 9:30 AM – 10:00 AM EST | Pre-Market Bull Flag / Gap & Go | Break of pre-market high or pre-market flat-top apex. |
| 9:50 AM – 11:00 AM EST | 5-Min Bull Flag / Flat-Top / ABCD | Fresh 5-minute consolidation; pullback <25%; break of 5-min candle high / apex. |

**Summary Rule**: Past 9:50 AM EST, the system **expires the ORB trigger**, but retains the ticker on the active watchlist to evaluate any new **5-minute Bull Flag or Flat-Top consolidation** that forms before the morning session ends.

## C12 — Q: What bull-flag volume threshold should be fixed?

A:
1. Recommended Fixed Thresholds:
   * **Peak Bar Ratio Limit (`max_pullback_bar_vol_ratio`)**: each pullback candle's volume is **< 50%** of the single highest volume bar on the flagpole.
   * **Preferred Ratio (`preferred_pullback_bar_vol_ratio`)**: for high-conviction setups, target pullback bar volume **< 25% to 30%** of the peak flagpole bar.
   * **Moving Average Fallback (`max_pullback_vol_vs_20ma`)**: pullback candle volume must sit **below the 20-period volume average**, whereas the initial breakout candle should be **≥ 200% (2x) of the 20-period volume average**.
2. Why: the explicit **25% metric** refers to **price retracement**. For volume, the rule is qualitative ("orderly pullback on light volume"). A pullback candle above **50% of the breakout peak bar** signals heavy short-selling or profit-taking.

Chart layout (supplied with the same answer):
1. **The Core 3-Chart Layout** — **Daily** (past 3 to 6 months, or ~90 days: major horizontal support/resistance, open "windows" and "triggers", 20/50/200 EMA alignment), **5-minute** (today's structure: 5-minute bull flags, 5-minute ORBs, ABCD, 5-minute candle-over-candle reversals; midday momentum trades almost exclusively off the 5-minute chart), **1-minute** (fast action at the open: timing aggressive entries at the breakout apex, 1-minute ORBs, early Gap and Go entries before a 5-minute candle completes).
2. **Sub-1-Minute** — 10-, 15- and 24-second charts to observe price action and order flow while 1- and 5-minute candles form. The **10-second chart** is used to identify sub-minute flat-top consolidations and micro pullbacks in hyper-strong momentum stocks.
3. **Multi-Timeframe Alignment** — a level respected on the **daily** chart carries far greater weight than one on a 1- or 5-minute chart; moves often start on small timeframes and cascade into larger ones; **9 EMA, 20 EMA and 200 EMA** are applied consistently across daily and intraday timeframes.

## C13 — Other owner decisions (multiple-choice answers)

- Test approach: historical + forward (both).
- Catalyst labels: Claude labels blind; the owner reviews disagreements (plus 20 blind owner labels, per plan rev 3).
- Trial budget: accept 10 trials (global 75 → 85).
- Backup: new private GitHub repo → `Algorythmos-AI/trading-lab-research` (the name was corrected to the org's product-first rule, and the owner confirmed it).
