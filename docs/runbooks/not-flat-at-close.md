# Not flat at the close

**Signal:**
- ntfy priority 5 "Paper B NOT FLAT at the close", or "Paper B is SHORT" / "Paper B is SHORT at the close".
- The journal (`data/live/journal.jsonl`) contains `END_OF_DAY_NOT_FLAT` (with `"short": true` for a short) or
  `short_position`.

**What already happened:**
- At T−5 the runner sent a market sell and checked again at T−2.
- **Long left after the close:** it left a **GTC stop** at the plan's stop price, so the position stays protected
  overnight. The next session adopts the position and exits it at the open, even if that session refuses to trade
  (disk, state, calendars): a refusal only turns entries off.
- **Short:** the runner cancelled this strategy's sell orders (they would deepen the short) and **did not buy
  anything back**. Covering a short is always your decision.

**Steps:**
1. Open the Alpaca paper dashboard. Check the QQQM position and its open orders.
   - Long: there should be exactly one sell stop.
   - Short: there should be no `wt-B-…` sell orders left.
2. If the position is still open and you want it gone now, close it in the Alpaca UI (sell a long, buy to cover a
   short). Otherwise the next session exits a long at the open.
3. Then cancel any remaining `wt-B-…` orders, so no stop can outlive the position.
4. Run `make status` and read `logs/paper_b_<date>.log` to find the cause (data timeout, rejected exit, …).
5. Record it: add a lesson under `research/lessons_learned/`. A session with this incident does not count towards G2.
