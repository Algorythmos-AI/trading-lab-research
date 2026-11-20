# DEC-0067: The options lab's recording v2: freshness counted, the tier-1 cap widened, EXP-0041 replaced by EXP-0052

- **Status: ACCEPTED (2026-11-20).** Proposed 2026-11-20 (#559). The owner asked on 2026-11-20 for an independent
  audit of the lab to make its data research-grade, and accepted this record in chat on 2026-11-20, before the
  session of 2026-11-20 and before any v2 statistic existed. This record carries the audit's changes that alter a
  frozen rule of EXP-0041; the code changes that alter no rule (detection, integrity, recovery, the archive, the
  reader) shipped in #559 and are listed under "Not a rule change". The acceptance pull request sets the tier-1 cap
  to 300 (point 4).
- **Written before any counted session.** EXP-0041 has counted nothing: one shadow session exists (2026-11-19) and
  no table, statistic or entry of any kind has been worked out from it. What the author has seen of it is listed in
  "Disclosure".
- **Amends:** DEC-0060 sections 2 and 3 as below. EXP-0041 closes unread, before its first counted session; EXP-0052
  replaces it (EXP-0041's own rule: "a changed value is a new experiment"). No desk, board, signal, clone or limit
  changes; no blind is narrowed.

## Why

The audit (2026-11-20) checked the recorder against the first real session. Four findings change what a session
measures or when it counts, so they need a record:

1. **Stale option quotes counted as full coverage.** Coverage on 2026-11-19 read 99.99%, because a sample counted
   when it was answered, not when it was new. Replaying the tape name by name showed:
   - for three of the four focus names, Alpaca's OPRA snapshots answered with the **previous day's quotes from 09:30
     until 10:29:40, 10:32:40 and 10:32:40** (the first quote under a minute old, by name);
   - only one name was fresh from 09:30. Its quotes then stopped changing from 10:27:05 to 10:29:40 while stock quotes
     kept arriving every tick: this is the 155-second "freeze" first seen;
   - 39% of tier-2 rows in the 09:00 hour were also over an hour old.

   A test over the whole sweep calls every one of those ticks fresh, because one name was moving. A table built on
   them would price the 10:00 entries of three names from yesterday's close. Freshness has to be judged name by
   name.
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

1. **Freshness, name by name.**
   - A name is *fresh* at a tick when the newest tier-1 quote ever answered for it is at most 30 seconds old.
   - The 30 seconds come from 2026-11-19: outside the stale spans, the live name's longest gap between new quotes was
     24.7 seconds and every name's 99th percentile was about 5 seconds.
   - A quote stamped before the open is never fresh.
   - A tier-1 sample of a stale name is a missed sample.
   - The recorder writes, per session, `coverage_fresh`, `stale_ticks` (ticks with any name stale),
     `stale_ticks_by_name`, `first_fresh_tick_by_name` and `longest_stale_s` (the longest run of any one name), and
     two gap rows for each name's stale run.
2. **Expected samples** are counted from the freeze or from 09:35 (five minutes in, when the freeze is due), whichever is
   earlier (`samples_expected_strict`). A late start, a crash or a stop is missed coverage, never a smaller
   denominator.
3. **A session counts** when:
   - it is a regular New York session with a focus list for it;
   - the opening tier-1 set is complete;
   - `coverage_fresh_strict` >= 0.99;
   - `longest_stale_s` <= 300 (so 2026-11-19 would not count);
   - the clock offset at the start and at the end is within 250 ms;
   - `tier1_crossed_share` <= 0.005;
   - `ticks_down` == 0, or the session is marked partial and its missing span is listed in every report.
4. **The tier-1 cap** becomes 300 contracts per name, nearest strikes first. This takes effect only with this
   record's acceptance, in the acceptance pull request (`tiers.Rules.t1_max_per_name`, set to 300 there).
   - **Budget check.** At six names that is 18 tier-1 requests every 5 seconds (216 a minute). Add tier 2 (about 50),
     stocks (12) and chains (about 12): under 300 of the recorder's 400.
   - **Candidates the cap still keeps out** are written to the tape (`member` rows, event `cap`) and counted in the
     manifest. A table may not use a contract's 5-second samples from before it joined tier 1.
5. **Open interest is used only with an `open_interest_date` earlier than the session.**
   - No morning read is added. On 2026-11-19 Alpaca's listing was dated 2026-11-17 in the evening, and still the same
     afterwards, so a morning read would give the same figure.
   - About 27% of listed contracts had no open interest at all (1,267 of 4,716, spread across expiries). They are
     counted (`null_open_interest`) and left blank.
6. **Tables read the tape only through `wt.lab.read`.**
   - A quote at an instant is the last row received by that instant, and only if the contract was asked for and
     answered at the last sweep before it. Otherwise it is missing.
   - Entries are placed only on fresh ticks; entries skipped as stale are counted per table.
7. **The shadow period starts again.**
   - A *v2 session* is one whose manifest says `"recorder": 2` and was recorded after this record's acceptance reached
     the host. The first five are shadow sessions.
   - The v1 session (2026-11-19) is kept in the archive and counts for nothing.
   - **Open question for the shadow period.** If at least two of the five shadow sessions show the same stale first
     hour, no session can pass point 3, and the owner chooses in a dated line, before the sixth session, between:
     - (a) counting each name from its first fresh tick, with that span left out of every table and reported;
     - (b) the websocket stage (DEC-0060's S6), which streams quotes instead of polling snapshots.
8. **EXP-0052** is EXP-0041 with these changes. Its tables, buckets, read points, intervals and cell minimums are
   EXP-0041's, unchanged.

## Not a rule change (shipped in the same pull request, no acceptance needed)

The recorder writes:
- a `sample` stream (every request: asked, answered, changed, newest quote time, what was missing);
- a `member` stream (when each contract joined a tier);
- its code commit, tier rules and settings;
- the signed clock offset at the start and at the end.

Its session rows' timestamps come from one clock (the after-close rows are stamped by the host's wall clock, the same clock on the host).

Recovery:
- tier-2 rows carry the tick they were sampled in;
- a promotion to tier 1 is never dropped;
- downtime is written as a gap;
- the after-close pull runs once; a killed pull's parts are removed, never kept; a failed pull is recorded in the manifest, never costs it, and is not redone;
- ticks left after a stop count as down;
- a day left unfinished is closed by the next run.

The archive:
- uses the lab's own token only (a missing value no longer falls back to the backup's), and only a `wt-lab-*` bucket;
- keeps receipts outside the session folders;
- re-reads every object before a local copy is pruned;
- checks every archived manifest weekly, plus a seeded sample of parts;
- uploads the whole folder;
- does not let one bad session stop the others.

After the close:
- open interest is pulled first;
- the prints wait for 16:15 on a full day, so the index and ETF contracts' last fifteen minutes are in them;
- failed pages are retried;
- missing and null open interest are counted.

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
