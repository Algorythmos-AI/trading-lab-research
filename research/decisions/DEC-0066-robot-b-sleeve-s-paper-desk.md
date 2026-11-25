# DEC-0066: Robot B, sleeve S: a paper book for the round-3 stock rules

- **Status: ACCEPTED on 2026-11-20** by the owner, in chat ("i accept it"), after reading the state of section 5
  set out in the note of 2026-11-20 below. PROPOSED on 2026-11-19 from a plan the owner approved in chat that day
  ("Robot B evolves: an order-capable stock desk (sleeve S)"). It takes effect when the pull request that changes
  this line is merged. `wt.live.runner_s` reads this line and refuses entries while it does not say ACCEPTED.
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
   (`scripts/s_parity.py`, after the counts-only pass). Item 4 is met on constructed sessions only
   (`tests/unit/test_runner_s.py`); replays of real recorded sessions, reported for their mechanics and never
   their R, are still owed.

### 2026-11-20: acceptance, the state of section 5, and one amendment

The owner accepted this record on 2026-11-20, including the numbers the note of 2026-11-19 proposed (the
10-second quote age, the QQQ book's loss latches not applying to sleeve S, the handling of positions the desk did
not open, and what the first slice leaves out).

**Section 5 at acceptance.**

1. Item 1: met by this change.
2. Item 2: met for signals, orders and fills. On ten sessions fixed by date (2026-11-05 to 2026-11-18) the replay
   harness led the unchanged `runner_b` to the same signal bar, the same orders and the same fills as the live
   runner had journaled, on all ten. Exits rest on two trades: one the same, one different, and the different one
   is the live runner's own defect of that date, since fixed by DEC-0063 (on the recorded tape the target was never
   reached). The record is `section5_item2_harness_vs_sleeve_q.json` in EXP-0051's folder.
3. Item 3, the CI half: met. The runner and the batch simulation take the same trade on the same fixture days
   (`tests/unit/test_runner_s.py`).
4. Item 4: met on constructed sessions. A replay of ten real recorded sessions of the forward period, reported
   as counts only, was still running at acceptance.

**Amendment to section 5, item 3 (the real-session half).** As written it asks for a parity run on real
development-span sessions. That contradicts this record's own rule that HYP-0069 and HYP-0070 read no development
data, which is why they sit outside the global trial count. The real-session half is therefore replaced by: the
live code is replayed on real recorded sessions of the forward period (from 2026-09-28), chosen by date and never
by outcome, and reported for its mechanics only (counts of scans, signals, orders, fills and exit classes; never R,
a price or equity). Nothing of sleeve S is run on the development span or the holdout span without a record first.

**What acceptance does and does not start.**

- The owner asked for the order path to be proven on sleeve S's paper account. That is a smoke test of the order
  manager against the broker (one share, bought and sold at once, or a resting order placed and cancelled), made
  outside `runner_s`. It is not a trade of either trial: it is not journaled in sleeve S's journal, not booked in
  its virtual account, and never counted in EXP-0051.
- The first live paper session of `runner_s` is not run until item 4's real-session replay has reported and its
  counts are in EXP-0051's folder. EXP-0051 counts trades from that first session on.
- Sleeve S's paper account is its own (its number ends `HJU0…` on the owner's login). Its key pair is on the
  owner's console machine only. The host has neither the keys nor a job, and under systemd the runner manages exits
  only: a host session waits for the release that adds the job, its lease and its pages.

### 2026-11-20: the host job

The pull request that carries this note adds what the notes above said the first slice left out: the `paper-s` job
and its unit, sleeve S's own primary lease (`paper-s`), and phone pages. So the sentence "under systemd the runner
manages exits only" no longer describes the code. On the host the runner now trades when all of these hold: the
unit is installed, sleeve S's key pair is in the host's secrets, and the session holds the `paper-s` lease. Without
the key pair the job is refused before the runner starts; without the lease entries are off and exits are managed.

Not changed by it: nothing in section 3 or 4, and the desk is still not an entry of its own in the desk table, so
its journal is backed up with `data/live` but its hash chain is not yet verified or anchored by the nightly job.

One rule follows for the owner: once the host timer is on, console sessions stop. A console checkout takes no lease,
so a console session and the host job on the same account would each adopt and sell the other's position.


### 2026-11-20: the owner's direction, and nothing is switched on

The owner set the desk's direction on 2026-11-20, in chat:

- The stock robot is the broad-market funnel: it scans the whole market before the open, narrows it to the day's
  best names, and trades what comes out. Its display name is **Gap Hunter** (the paper account carries that
  nickname). The strategy tag, journal, job, lease and record ids keep their names.
- **HYP-0070 is paused.** The reversal rule on a causal universe was built and proven in replay as the first
  slice; the owner does not want it traded now. No live session of it was run, so EXP-0051 has no trade.
- The QQQ rule (sleeve Q) is to be retired. That is a record of its own, to follow.
- The funnel's daily-chart checks are to become a score. That is a rule change and a new trial, registered by a
  record of its own before any result exists.

**In the code, from the pull request that carries this note:** the runner reads `S.switched_on` in
`config/risk.yaml`, the list of trial ids it may trade, and refuses entries for a rule that is not on it. The list
is empty. Section 2 already said each rule is switched on by a dated note; the list is where the code reads that.
A rule is switched on by a note here together with its id in that list, in one pull request.


### 2026-11-20: no running sleeve Q (DEC-0069)

DEC-0069, accepted by the owner on 2026-11-20, retires the QQQ rule. From the release that carries it, the
two-sleeve table of section 1 no longer has a running sleeve Q: its job (`paper-b`) leaves the schedule, and its
journal, plans and virtual account stay as an archive. The sentence in section 1 "refuses if its account number
equals sleeve Q's" is withdrawn by that record: the desk still requires its own key pair and never falls back to
`APCA_API_*`, and no longer compares itself with that pair or its account. Nothing else in this record changes.

### 2026-11-22: HYP-0071 (Gap Hunter) is switched on

The owner switched Gap Hunter's rule on in chat on 2026-11-22. Shown the host's entry counts and asked to choose,
he chose "Switch it on as it is", and asked for everything to be made functional.

**DEC-0068's conditions, each met:**

1. The selection runs beside the frozen funnel, whose goldens are unchanged (#564).
2. The owner saw the counts on the host's pools first. They are filed as `before_switch_on_counts.json` in
   EXP-0053's folder: 40 sessions, 39 with a primary; the day's one attempt reached on 5, filled on 3 (an upper
   bound, since minute bars carry no quotes for the spread must).
3. The gap entries run live through `wt.live.runner_s` with the partial exit and match the batch simulation on
   fixture days (#570, with the review fixes of #572). The owner confirmed DEC-0068's eight readings on
   2026-11-22.
4. This note, with `HYP-0071` in `S.switched_on`, in one pull request.

**The switch-on itself:**

- `S.switched_on` is `[HYP-0071]`.
- HYP-0070 stays paused, as the owner set it on 2026-11-20. A session runs one trial, and with both listed it
  places no entry (DEC-0068's note of 2026-11-20, point 8).
- Nothing trades until this change is released and on the host, with Gap Hunter's own key pair
  (`APCA_S_KEY_ID`, `APCA_S_SECRET_KEY`) set there by the owner. Without the pair, the job refuses the session.
- EXP-0053 counts trades from the first session after that.
- The book, its limits, the day stop and the stop rule are this record's, unchanged: US$600 virtual, 1% risk,
  one trade a day under DEC-0068, −2R or 3 losers a day, and the −6.0R / 30-trade / 2027-03-31 stop rule.
- From the first session of the host job, console sessions on the Mac stop (note of 2026-11-20, "the host job").

### 2026-11-22: DEC-0073 proposes execution stops and a reading of the date stop

Written before Gap Hunter's first session; no Gap Hunter trade exists. At the rate EXP-0053's counts show, about
6.5 trades close by 2027-03-31, so no test of R can judge the rule by then. DEC-0073 keeps section 4 as written. It
proposes stops on execution faults that carry over to the next session, and fixes what the date stop means when
there are fewer than 30 trades. Section 4 changes only once the owner accepts DEC-0073.

### 2026-11-25: HYP-0072 (Gap Hunter with rotation) is switched on in place of HYP-0071

The owner switched DEC-0076's rotation rule on in chat on 2026-11-25. `S.switched_on` is `[HYP-0072]`; HYP-0071 is
off and HYP-0070 stays paused. The book, its limits, the day stop and the stop rule (section 4) are this record's,
unchanged, and keep counting sleeve S's journal across the switch. The conditions, the waived shadow wait and what the
runner now does are in DEC-0076's note of the same date. It takes effect once released to `main` and deployed.
