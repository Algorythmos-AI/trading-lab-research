# DEC-0066: Robot B, sleeve S: a paper book for the round-3 stock rules

- **Status: PROPOSED on 2026-11-19.** Drafted from a plan the owner approved in chat on 2026-11-19 ("Robot B
  evolves: an order-capable stock desk (sleeve S)"). It takes effect when a pull request changes this line to
  ACCEPTED and the owner merges it. Until then no code may send a sleeve-S order: `wt.live.runner_s` reads this
  line and refuses entries while it does not say ACCEPTED.
- **Amends:** DEC-0023 section 1 item 3 ("No stocks code books a simulated order") and section 5 ("No desk-wide
  limit ... is added by this record"), for sleeve S only. Everything else in DEC-0023 stands: the forward ledger
  stays the book of record for the ten round-3 trials, and its views, counts and sealed shadow outcomes are
  unchanged.
- **Does not amend:** DEC-0010 (the ten trials and their gates), DEC-0011, DEC-0037, DEC-0061, DEC-0062,
  DEC-0063, DEC-0064. No rule, exit, size, limit, gate, latch or stop line of Robot B's QQQ rule changes.
- **Trials:** 2 new, HYP-0069 and HYP-0070, counted in a new family **S** of `config/trial_registry.yaml`. The
  global count stays at 87. The global count is of configurations evaluated on development data (DEC-0005); these
  two read none: they are judged only on paper sessions after this record is accepted. If either is ever run on
  the development span, it joins the global count by a record first. Robot B's deflated Sharpe and EXP-0042's
  committed results are therefore unchanged by this record.
- **Experiment:** EXP-0051 (the sleeve-S paper book), registered with this record.

## Why

Since 2026-09-28 the stocks desk has scanned the market every morning and placed no stock order other than
Robot B's QQQM trades. The causes, read from the code and records at `a894a826`:

1. There is no order path for any symbol but QQQM, and DEC-0023 forbids a small-cap book.
2. The registered funnel's qualified tier was empty in all 26 compared sessions, on the dry run and on the
   after-close record. DEC-0010's count guard for Set P depends on the EXP-0015 counts-only pass, which has
   not run, so `R3_P_RELAX` in `scripts/forward_test.py` is still empty.
3. The registered signals are computed after the fact, once, at 11:31. Nothing stages an order.
4. The order manager cannot sell half a position and move the stop, which the registered gap exit needs.
5. The reversal and micro-pullback trials choose their day's universe from that day's completed daily bar
   (`scripts/r3_intraday.py`, `mp_day` and `rev_superset`). No live process can do that.

Items 1, 3 and 4 are engineering. Item 2 is settled by the registered route, not by loosening a filter. Item 5
is a defect in the recorded results and is disclosed below.

## Decision

### 1. Two sleeves

Robot B becomes two sleeves that share nothing at run time.

| | Sleeve Q | Sleeve S |
|---|---|---|
| Rule | B version 1, the QQQ signal traded in QQQM, frozen (DEC-0007, DEC-0062) | the round-3 rules of SPEC-0001, as section 2 lists them |
| Strategy tag and `config/risk.yaml` key | `B` | `S` |
| Runner, job, lock | `wt.live.runner_b`, `paper-b`, `paper-b-runner` | `wt.live.runner_s`, `paper-s`, `paper-s-runner` |
| Paper account | the existing one (`APCA_API_*`) | its own (`APCA_S_KEY_ID`, `APCA_S_SECRET_KEY`) |
| Journal | `data/live/journal.jsonl` | `data/live/smallcap_journal.jsonl` |
| Plans, state, kill file | `data/live/plan_*.json`, `var/`, `KILL` | `var/smallcap/plans/`, `var/smallcap/`, `var/smallcap/KILL` |
| Stop rule | DEC-0037, unchanged | section 4 |

Sleeve S refuses to arm without its own key pair, and refuses if its account number equals sleeve Q's. It never
falls back to sleeve Q's keys. Results are reported per sleeve and never pooled (ADR 0005, sleeves).

### 2. What sleeve S trades, and in what order it is built

It trades registered rules only, each switched on by a dated note in this record once its live code passes the
parity test of section 5.

1. **REV-1 on a causal universe (HYP-0070).** First, because it is the only round-3 trial that has produced
   forward trades, and its registered exit sells the whole position at one target.
2. **The gap entries GG-1 to GG-4 and MP-1,** on Set F and on Set P with whatever relaxation the count guard
   has ruled by then. Sleeve S imports `R3_P_RELAX` from the forward test, so the two cannot disagree. MP-1
   runs on a causal universe, defined in the note that switches it on.

Every entry and exit rule, the 2:1 room check, the US$0.05 spread must, the strict collar of 10% of R, the
stagnation stop and the two-attempt limits are SPEC-0001's, unchanged.

### 3. The book (HYP-0069)

One virtual account of US$600 with T+1 settled cash, 1% of equity at risk per trade, and a day stop across all
of sleeve S's trades: entries stop for the day after three consecutive losers or at −2R realised. DEC-0023
section 5 says a limit across trials is new trials; it is counted here as one, the book (family S).

Hard limits in `config/risk.yaml` under `S` (added by the pull request that adds the runner):

| Limit | Value |
|---|---|
| `max_qty` | 600 shares |
| `max_notional` | US$700 per order |
| `max_entries_per_day` | 6 |
| `max_orders_per_day` | 60 |
| `max_open_positions` | 1 until the order manager can protect several plans, then 2 |

The session's allowlist is the day's Set F, Set P and causal scan names, built at run time. Spread, quote age
and last-print age block an entry for sleeve S (they are log-only for sleeve Q). A name with no print or no
fresh quote is treated as halted: no entry, and the blocked signal is counted.

### 4. Stop rule for sleeve S

Read by `wt.risk.stop_rule` from `S.stop_rule`, on sleeve S's own journal:

- cumulative R at or under **−6.0R**; or
- at **30 trades**, the 95% bootstrap upper bound of mean R is below zero; or
- **2027-03-31**, whatever the count.

When it fires, entries latch off and exits keep running. Only a decision record clears the latch or changes a
number.

### 5. What must be true before the first order

1. This record reads ACCEPTED.
2. The session replay harness reproduces sleeve Q's forward-ledger rows on recent sessions.
3. The live code for the rule being switched on matches the batch simulation
   (`scripts/r3_run.py` / `scripts/r3_intraday.py`) on fixture days in CI, and on real development-span
   sessions in `scripts/s_parity.py`: the same entry time, the same entry and stop to the cent, the same exit
   reason. Days are taken by date from a counts-only pass, never by outcome, and never from the holdout span
   (2025-09-26 to 2026-09-25).
4. Replayed sessions show the whole lifecycle through the runner: an entry that reaches its target, a
   stop-out, a stagnation exit, a session with no valid setup, a crash and resume while in a position, a
   refused sell, and the kill file raised during a position.

### 6. What the paper book is evidence of

Execution: that the desk finds, decides, orders, protects, exits and records as the rules say, and what the
fills cost against the quotes at the time. It is not proof of edge. G1 on development data (DEC-0010, read at
the count in force) remains the only route to "proven", and EXP-0015 is still the registered test of the ten
trials. A trial that fails EXP-0015 is switched off in sleeve S by a dated note here.

### 7. Data

All market data and news come from the Alpaca plan the desk already pays for, through `wt.data.alpaca`, with
SIP named on every stock request (DEC-0064). A headline counts toward a catalyst only if it was created at or
before the decision time. The journal stores a headline's id, time and category, never its text.

## Disclosure: what had been seen before this record was written

- The forward ledger to 2026-11-13 for the ten trials: REV-1 five trades, mean −0.157R; the other nine, no
  trades. The two re-specified flags (HYP-0032, HYP-0033): two trades each.
- The G1 and round-2 results of the earlier small-cap families (DEC-0007, DEC-0009), all negative or
  inconclusive.
- No development-span result for any round-3 trial exists. The parity script of section 5 will show
  development-span trades for the rule it checks; it runs only after the count guard is settled.
- **A defect in recorded results.** REV-1 and MP-1 take their universe from the completed daily bar of the day
  being traded. Their forward rows, and any batch run, carry that look-ahead. HYP-0070 is REV-1 without it.
  The existing rows are not rewritten; reports that show them say so.

## What this record does not do

- It enables no real-money trading and adds no route to it.
- It does not relax any chart must, change Set F, or decide the selectivity question of DEC-0024 section 5.
- It does not adopt, from the owner's version 3 configuration file of 2026-11-19, the marketable limit entry,
  the short-sale-restriction score term, price-band halts, the half-dollar buffer or the midday quiet period.
  Each is a candidate trial for a later record.

## What follows

1. EXP-0015's counts-only pass, the count guard applied in DEC-0010's order, and a tally of the funnel's
   rejection reasons (counts only).
2. The replay harness, then the REV-1 slice and the runner, then the order manager's partial exit, then the
   gap entries.
3. An acceptance pull request for this record, opened when item 2's first slice has passed section 5.
4. Owner steps: accept this record; create the sleeve-S paper account, funded above US$25,000 so the broker's
   day-trade rule cannot block an exit, and store its keys; install the `paper-s` unit after its release.

## Notes

### 2026-11-19: what the first slice's runner fixes that this record left open (proposed with the record)

Written with the pull request that adds `wt.live.runner_s`. These take effect when this record is accepted; an
objection to any of them is a change to make before acceptance.

1. **Quote age.** Section 3 says quote age blocks an entry and gives no number. Proposed: a quote older than
   **10 seconds** at the decision blocks it (`S.max_quote_age_s` in `config/risk.yaml`). No quote at all fails the
   spread must, as SPEC-0001 says.
2. **No print.** Section 3 treats a name with no print as halted. In the runner that is the rule that a signal is
   acted on only when it forms on the newest closed minute bar, and that bar is the minute that has just ended.
   A signal found on an older bar is journaled as missed and never traded.
3. **The QQQ book's loss latches do not apply to sleeve S.** `wt.risk.virtual_account` latches the QQQ book at
   −2% on a day, −4% in a week and −10% from its high-water mark. Sleeve S uses the same account class for its
   US$600 and T+1 cash with those three switched off: its limits are the day stop of section 3 and the stop rule
   of section 4, which is what this record lists. At 1% risk a trade, the day stop (−2R) and the QQQ book's daily
   latch would fall at the same loss, but the latch needs the owner to clear it and the day stop ends with the day.
4. **Attempts.** As in the batch run: two filled entries per name per day; a signal refused for its spread or its
   collar, or an order that does not fill, ends the name for the day.
5. **Positions the desk did not open.** A long position on sleeve S's account with no plan is adopted, protected
   by a stop 1% under its average price and sold at once. One larger than section 3's hard caps cannot be sold
   by this desk's orders: it is journaled and left for the owner. A short is never covered automatically.
6. **Not in the first slice.** Phone pages, the host job and its lease, and the desk's entry in the backup and
   status tables. Until they exist the runner refuses entries under systemd and runs from a console checkout
   only; its journal is the only record of a fault.
7. **Still owed from section 5.** Item 2 (the replay harness against sleeve Q's forward-ledger rows on recent
   real sessions; it has been checked on constructed sessions only) and the real-session half of item 3
   (`scripts/s_parity.py`, after the counts-only pass). Item 4 is met in replay by `tests/unit/test_runner_s.py`.
