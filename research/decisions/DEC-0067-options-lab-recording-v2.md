# DEC-0067: The options lab's recording v2: freshness counted, the tier-1 cap widened, EXP-0041 replaced by EXP-0052

- **Status: PROPOSED (2026-11-20).** The owner asked on 2026-11-20 for an independent audit of the lab to make its data
  research-grade. This record carries the audit's changes that alter a frozen rule of EXP-0041; the code changes that
  alter no rule (detection, integrity, recovery, the archive, the reader) ship in the same pull request and are
  listed under "Not a rule change". A later pull request that changes this line to ACCEPTED accepts it.
- **Written before any counted session.** EXP-0041 has counted nothing: one shadow session exists (2026-11-19) and
  no table, statistic or entry of any kind has been worked out from it. What the author has seen of it is listed in
  "Disclosure".
- **Amends:** DEC-0060 sections 2 and 3 as below. EXP-0041 closes unread, before its first counted session; EXP-0052
  replaces it (EXP-0041's own rule: "a changed value is a new experiment"). No desk, board, signal, clone or limit
  changes; no blind is narrowed.

## Why

The audit (2026-11-20) checked the recorder against the first real session. Four findings change what a session
measures or when it counts, so they need a record:

1. **A frozen feed counted as full coverage.** From 10:27:05 to 10:29:40 New York on 2026-11-19 no tier-1 option quote
   changed on any contract while stock quotes kept arriving every tick: Alpaca's option snapshots answered the same old
   quotes for 155 seconds. Coverage read 99.99%, because a sample counted when it was answered, not when it was new.
   A table built on those ticks would price entries and stops from quotes two minutes old.
2. **The tier-1 cap biases the sample.** The cap of 120 contracts per name applied to new candidates only. On
   2026-11-19 one focus name hit 120 at the open and another during the day, so no strike that came near the money
   later was ever sampled every 5 seconds. A move of the stock is exactly when that matters: the 5-second tables
   would see the morning's strikes on big days, and fewer at-the-money ones.
3. **Two counting conditions were lost to a YAML slip.** In EXP-0041's `config.yaml`, "clock offset <= 250 ms and
   crossed quotes <= 0.5% of tier-1 rows" is indented under `expected_samples` and parses as part of that string, so
   `counting.session_counts_when` holds two conditions where three were intended.
4. **A late start or a crash before the freeze shrank the denominator.** Expected samples were counted from the
   freeze, and a run that froze late (it crashed at 09:33 and came back at 10:30) counted only from 10:31.

## Decision

1. **Freshness.** A tier-1 tick is *fresh* when the newest quote answered in its sweep is at most 15 seconds old at the
   tick. Every tier-1 sample on a stale tick is a missed sample. The recorder writes, per session, `coverage_fresh`,
   `stale_ticks` and `longest_stale_s`, and two gap rows for each stale run.
2. **Expected samples** are counted from the freeze or from 09:35 (five minutes in, when the freeze is due), whichever is
   earlier (`samples_expected_strict`). A late start, a crash or a stop is missed coverage, never a smaller
   denominator.
3. **A session counts** when:
   - it is a regular New York session with a focus list for it;
   - the opening tier-1 set is complete;
   - `coverage_fresh_strict` >= 0.99;
   - `longest_stale_s` <= 300;
   - the clock offset at the start and at the end is within 250 ms;
   - `tier1_crossed_share` <= 0.005;
   - `ticks_down` == 0, or the session is marked partial and its missing span is listed in every report.
4. **The tier-1 cap** becomes 300 contracts per name, nearest strikes first.
   - **Budget check.** At six names that is 18 tier-1 requests every 5 seconds (216 a minute). Add tier 2 (about 50),
     stocks (12) and chains (about 12): under 300 of the recorder's 400.
   - **Candidates the cap still keeps out** are written to the tape (`member` rows, event `cap`) and counted in the
     manifest. A table may not use a contract's 5-second samples from before it joined tier 1.
5. **Open interest is also read at 09:26 New York** for each focus name's contracts to 14 days, before the open.
   - It is kept as the figure a trader could know that morning; the after-close pull stays as well.
   - A table may use open interest only with an `open_interest_date` earlier than the session.
6. **Tables read the tape only through `wt.lab.read`.**
   - A quote at an instant is the last row received by that instant, and only if the contract was asked for and
     answered at the last sweep before it. Otherwise it is missing.
   - Entries are placed only on fresh ticks; entries skipped as stale are counted per table.
7. **The shadow period starts again.** The first five sessions recorded by the v2 recorder are shadow sessions. The
   v1 session (2026-11-19) is kept in the archive and counts for nothing.
8. **EXP-0052** is EXP-0041 with these changes. Its tables, buckets, read points, intervals and cell minimums are
   EXP-0041's, unchanged.

## Not a rule change (shipped in the same pull request, no acceptance needed)

The recorder writes:
- a `sample` stream (every request: asked, answered, changed, newest quote time, what was missing);
- a `member` stream (when each contract joined a tier);
- its code commit, tier rules and settings;
- the signed clock offset at the start and at the end.

Its timestamps come from one clock.

Recovery:
- tier-2 rows carry the tick they were sampled in;
- a promotion to tier 1 is never dropped;
- downtime is written as a gap;
- the after-close pull runs once and never costs the manifest;
- a day left unfinished is closed by the next run.

The archive:
- uses the lab's own token only (a missing value no longer falls back to the backup's), and only a `wt-lab-*` bucket;
- keeps receipts outside the session folders;
- re-reads every object before a local copy is pruned;
- checks every archived manifest weekly, plus a seeded sample of parts;
- uploads the whole folder;
- does not let one bad session stop the others.

Prints are pulled to 16:15, with retries; missing open interest is counted.

The guards:
- every lab request is checked against a list of allowed URLs before it is sent;
- the import wall now also bans dynamic imports, exec and other processes.

None of this changes what EXP-0041 counts. `coverage` and `samples_expected` are kept with their frozen meaning
beside the new fields.

## Disclosure

The author worked these out from the session of 2026-11-19, on the host, for data checks: counts, rates and times
(rows, coverage, crossed and locked shares, quote ages, tick spacing, the freeze's span, per-name tier-1 counts, the
condition-code share left out, open-interest dates and the share missing). No spread, cost, fill, stop or price
statistic, and no figure by name, was worked out or seen.

## Not changed

DEC-0060's names (focus names only), feeds, tiers other than the cap, request budget, disk and memory limits,
EXP-0041's tables and every blind.
