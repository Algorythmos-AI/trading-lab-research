# DEC-0060: The options lab records the focus names' option tape on the trading host, and measures execution on it

- **Status: ACCEPTED (2026-11-19).** Proposed 2026-11-18. The owner approved the plan this record implements on
  2026-11-18 (the Options Research Lab, which replaces the DEC-0041 arms), chose in chat on 2026-11-18 which names are
  recorded (section 2), and accepted this record in chat on 2026-11-19, after the probe passed (EXP-0041's README,
  dated line) and before the first recorded session.
- **Written before any tape exists.** No session has been recorded and no statistic of EXP-0041 exists. What the
  author had seen is listed in "Disclosure".
- **Amends nothing.** No rule, gate, exit, limit or latch of any desk changes; no blind is narrowed; no file the desk,
  the board, the signal or the clone runs is edited.
- **Depends on:** DEC-0005 (trial accounting), DEC-0045 point 8 and DEC-0051 section 5 (the blinds), DEC-0047
  section 8, DEC-0054 (EXP-0037), DEC-0059 (the arms stop).
- **Experiment:** EXP-0041 (descriptive measurements; no hypothesis). Family O stays at 47; no family changes here.

## Why

Alpaca's historical data has option trades and bars but no option bid and ask, so the only way to know what an
option really cost to buy and sell, and how its bid moved after a buy, is to record the quotes while they happen. A
session not recorded is lost. The lab's first questions are about mechanics, not about a setup's edge: how often a
premium stop is touched by ordinary movement, what the loss is when it is, what a round trip costs, and how often a
limit fills. Each has hundreds of observations a session and none needs a signal.

## Decision

### 1. Which names: the session's focus names only (the owner's ruling, 2026-11-18)

- Until EXP-0032 is read, DEC-0051 section 5.1 (frozen in EXP-0034's `blind.exp_0032`) allows nothing to be worked
  out, logged or shown for a name that is not a focus name. So the tape holds **only the session's focus names**, and
  everything the lab works out is for them.
- **Which focus names.** At 09:25 New York the recorder reads the focus list once, from the same source the clone
  reads (`wt.options.clone_site.read_focus`, the dashboard's latest after-close edition). It keeps the list only if
  the answer's `session` is that day; it never uses the SPY and QQQ fallback or the clone's standing or top-up names.
  The sha256 of the answer (as canonical JSON) and the list are written in the session's manifest. No list that day: nothing is
  recorded. Focus names are at most six, all from `config/options_desk.yaml`.
- Widening the tape to all twelve desk names is a later record, after EXP-0032 is read.
- A guard in code: one function returns tape rows after a reference time; it refuses any name outside that session's
  manifest list, and a test proves no other lab module reads tape rows. No output carries a setup name or any of the
  keys `picked`, `rank`, `score`, `eligible`, `word`, `gate`, `caution` or `label`.
- **Never read by the lab:** the owner's trades and journal (DEC-0045), `data/exp0037/` (DEC-0054), the board's and
  the signal's logs.

### 2. The tape

1. **A recorder job on the trading host**, `lab-tape`, samples Alpaca's option chain snapshots (OPRA feed) and stock
   quotes (SIP feed) from 09:30 to the close (13:00 on a half day, by `market-calendar.json`). Every request names its
   feed.
2. **Two tiers**, by fixed rules applied at every sample to the stock's latest SIP mid; a contract once in a tier
   stays in it for the session (tiers only grow), with a cap:
   - tier 1, sampled every 5 seconds: contracts expiring within 5 regular sessions (today is 0), strike within 3% of
     the stock's mid, ask at or under $3.00; at most 120 contracts per name, nearest strikes first;
   - tier 2, sampled every 60 seconds: every other contract expiring within 14 calendar days with a strike within 8%.
3. **Raw fields only.** Bid, ask, their sizes and quote time, last trade price, size and time, day volume, Alpaca's
   greeks and implied volatility when sent, and the time the answer arrived. A row is written only when the quote or
   the trade changed. Zero bids are kept. Nothing is worked out while recording.
4. **After the close** the job fetches every option trade print of the day for tier-1 contracts, with condition codes,
   and each recorded contract's open interest. It stops by close plus 90 minutes and finishes its upload by close plus
   110 minutes, whether or not either is complete; what is missing is written in the manifest.
5. **Storage.** Files outside the repository on the host, one folder per session, with a manifest: each file's sha256,
   the focus answer's sha256 and list, the frozen opening tier-1 set, samples taken and expected, coverage, the host
   clock's offset, and the previous manifest's sha256. Each folder is uploaded write-once to the lab's own object store
   bucket and kept with no end date. Local copies are removed only after the upload is verified. The tape is PRIVATE:
   never committed, never published, never sent to the dashboard; only counts and coverage leave the host.
6. **It cannot touch trading.**
   - Its own process with CPU, memory and priority caps, listed in the jobs table so the deploy gate sees it.
   - Requests on a key pair the probe names; its own limiter file (never the shared one), capped at 40% of the limit
     the probe measured, and it backs off when Alpaca's remaining-requests header falls under 30% of the limit.
   - An off switch (`var/lab/OFF`). It stops itself when free disk falls under 17 GB (the 15 GB amber mark of
     `DISK_TARGET_GB` plus 2), far above the 3 GB floor where trading jobs refuse.
   - Its failures alert under its own desk, never as a trading fault, and never touch `KILL`.
   - It imports nothing from `wt.live`, `wt.oms` or `wt.brokers`, and a test proves it.

### 3. EXP-0041: execution measured on the tape

Every table, bucket, formula, threshold and read point is frozen in
`research/experiments/EXP-0041-lab-execution-truth/config.yaml` by this record, before any session exists. A changed
value is a new experiment.

- **Hypothetical orders are placed only at sample instants**, where the quote is known exactly, and trade prints are
  read forward from there. A print is never matched to a quote sampled seconds away.
- **A session counts** when it is a regular session, has a focus list, passes the data checks, and its opening tier-1
  set is complete and has at least 99% of expected samples. The opening set is frozen once the first minute of chain
  reading has finished and every focus name has been selected; a name still missing after five minutes leaves the
  set incomplete and the session uncounted. Expected samples are the opening set at every tick from the freeze to the
  close, whether or not the recorder was running, so a stop, an outage or a restart shows as missed coverage. Sessions left out are listed with the reason in every report, so
  fast days that strain the recorder cannot vanish silently.
- **Read points, not a running view.** Tables are worked out and shown only at 20 and 40 counted sessions, then every
  40. The first five recorded sessions are a shadow period that no table reads.
- **No trial here, and a rule taken from a table pays for it.** EXP-0041 tests nothing and selects nothing. A record
  that proposes a rule from it (a stop distance, a spread ceiling) must name every cell it looked at, count them as
  trials in its own family, and confirm the rule only on sessions after its own registration.
- **The grid audit.** At each read point each table's headline number is also worked out from every second sample. If
  it moves by more than the tolerance in `config.yaml`, the 5-second grid is too coarse and a streaming recorder needs
  its own record.
- **The other blinds.** The tables are not trades, signals or the owner's results, so DEC-0045 point 8 and DEC-0051
  section 5.2 do not cover them, and a lab table is none of EXP-0033's early ends. Seeing them may still change how
  the owner trades, so the date a lab table is first shown on the site is written as a dated line in EXP-0033's
  `README.md` by the pull request that shows it, as DEC-0051 section 5.2 did for the signal.
- **What reaches the owner.** Each table on a private lab page, then a record per table proposing a rule. Until
  EXP-0033 and EXP-0034 are read, no such rule edits `trade-rules.ts`, the signal's parameters, the card's numbers
  (DEC-0035) or the clone's config; it is a line on the lab page and a record.

## Order of the work

1. This record, PROPOSED.
2. The probe, written by the lab's builder, run once by the owner on the host. Pass marks are in `config.yaml`. If a
   mark is missed, tier 1 is narrowed in this order, each step a dated README line before any session: the ask cap to
   $2.00, then the strike band to 2%, then the expiry window to 3 sessions; a miss after all three goes to the owner.
3. Owner steps: the lab's object store bucket, its credentials (`sudo wt-set-secrets`), and the disk if the probe asks.
4. The recorder, its archive, and its job and unit, an owner-install release (`sudo wt-install-units`); then the
   tape's status line.
5. Acceptance of this record, before the first recorded session.
6. Five shadow sessions; counting from the sixth.

## Disclosure

- Read in planning: the approved plan file for the Options Research Lab, the code on `origin/integration`, and the
  records DEC-0005, DEC-0030, DEC-0041, DEC-0045, DEC-0047, DEC-0051, DEC-0054 to DEC-0059 and their experiments by
  title and rule, including DEC-0058's count of sessions with entries.
- Seen on 2026-11-18: a screenshot of the production Paper options page showing the clone's and the four shadow
  arms' running dollar totals and trade counts (disclosed in DEC-0059). Nothing in EXP-0041 uses a setup, a signal or
  any of those trades.
- No journal, plan file of a desk, decision line, shadow file, review output, owner trade or tape has been read.

## Not changed

- Every desk, the clone, the board, the signal, the card, the ticket and their records and blinds.
- `config/options_desk.yaml`, `config/options_clone.yaml`, `config/trial_registry.yaml`.
