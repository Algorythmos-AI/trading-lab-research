# Not flat at the close

**Signal:**
- ntfy priority 5 "Paper B NOT FLAT at the close".
- The journal (`data/live/journal.jsonl`) contains `END_OF_DAY_NOT_FLAT`.

**What already happened:**
- At T−5 the runner sent a market sell and checked again at T−2.
- If shares were still held after the close, it left a **GTC stop** at the plan's stop price, so the position stays
  protected overnight.

**Steps:**
1. Open the Alpaca paper dashboard. Check the QQQM position and its open orders; there should be exactly one sell
   stop.
2. If the position is still open and you want it gone, sell it in the Alpaca UI.
3. Then cancel any remaining `wt-B-…` orders, so no stop can outlive the position.
4. Run `make status` and read `logs/paper_b_<date>.log` to find the cause (data timeout, rejected exit, …).
5. Record it: add a lesson under `research/lessons_learned/`. Incident-free sessions count towards G2.
