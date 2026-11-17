# DEC-0054: Three of the options clone's rule gaps, each replayed against the frozen clone on sessions not yet seen

- **Status: PROPOSED on 2026-11-17.** Drafted at the owner's request ("Yes, draft them", 2026-11-17, after the
  debrief of #454, #459, #462 and #466). The owner accepts it by merging a pull request that changes this line to
  ACCEPTED, and by that merge registers HYP-0062, HYP-0063 and HYP-0064 with EXP-0037.
- **Amended 2026-11-17, before acceptance and before any session on the list:** the session list is fixed by rule
  instead of being written by hand, and the host job `exp0037` fetches the inputs and runs the replay (section 2).
  The owner asked for this ("you need to automate it we cant rely on manual commond"). Nothing else changed.
- **Changes nothing that trades.** The clone keeps every number DEC-0030 and EXP-0029 freeze. Nothing here starts a
  paper experiment. A variant that passes is a reason to write a further record, which would freeze a new config
  and start a new paper experiment with new trials. It is never a reason to change EXP-0029 while it runs.
- **Registers** three trials in family O: HYP-0062 CLONE-ROOM-OPEN-SKY, HYP-0063 CLONE-RETEST-FREE-CONFIRM and
  HYP-0064 CLONE-REJECTION-SPY-TREND, replayed by EXP-0037. Family O goes from 38 to **41** when this record is
  accepted. Until then the registry row is `proposed` and the count in force stays 38.
- **Experiment:** EXP-0037. **Hypotheses:** HYP-0062, HYP-0063, HYP-0064.
- **Depends on:** DEC-0030 (the clone and its gates), DEC-0031 (the dry-run replay EXP-0037 reuses), DEC-0040
  (EXP-0029, whose config is the control).

## Why

On 2026-11-16 and 2026-11-17 the author read the clone's code while measuring why valid-looking setups did not
trade. Three rules refuse a whole class of setups for reasons the strategy does not state:

1. **A break past every mark can never trade.**
   - `setups.next_level` finds no mark beyond the entry, so `room` (`setups.gate`) has no next level and fails, and
     so does `reach`.
   - This means a break of the day's highest (or lowest) watched level, often the cleanest break of the session,
     is always refused.
2. **A retest gets exactly one confirming bar.**
   - `setups.retest` completes only on the first bar after the touch to close beyond the touch bar's close
     (`first_away != last`).
   - If that bar comes while the clone cannot enter (a position already open, the loss pause, or the name's
     cooldown), the setup can never complete later, though nothing about the break has changed.
3. **The rejection setup nearly contradicts the trend gate.**
   - A put on a rejection at resistance needs the name below its VWAP (`setups.gate`, `trend`).
   - A name that rallies into resistance is usually above its VWAP, so most rejections are refused by the trend
     gate the setup was not designed around.

Each is a hypothesis that the setups refused this way are worth taking, not a known edge. EXP-0025, the clone's
dry run, lost money on both setups, so "more trades" is not the goal: the added trades must be good on their own.

## What has already been seen

This record is not blind to everything, and it says what was seen:

- **EXP-0025's report:** every trade of the dry run, 2026-03-02 to 2026-10-16.
- **The live decision lines of 2026-11-05 to 2026-11-16,** as tallies of refusals by gate and reason. These
  showed that trend, room and contract refuse most signals.
- **EXP-0029's running figures by setup** (trades, mean return on premium, range by session). The author saw them
  in the nightly review log on 2026-11-16, while checking the host.

None of these contains the outcome of a trade any of the three variants would add: those setups were refused, so
they were never priced. To keep the test clean of everything above, EXP-0037 replays **only sessions after this
record is accepted** (section 2). No session it reads has been looked at when the variants are frozen.

## Decision

### 1. The control and the three variants

- **Control:** `wt.options.dryrun` (DEC-0031) under `config/options_clone.yaml` as EXP-0029 freezes it, at the
  commit that merges EXP-0037's replay code.
- **Each variant changes one rule and nothing else.** Each is replayed on its own against the control; they are
  never combined. The rules are worded in the hypotheses, in full:
  - **HYP-0062 CLONE-ROOM-OPEN-SKY:** with no mark beyond the entry, a measured level stands in.
  - **HYP-0063 CLONE-RETEST-FREE-CONFIRM:** a confirmation lost to a passing block may come on a later bar.
  - **HYP-0064 CLONE-REJECTION-SPY-TREND:** for rejections, the trend gate reads only SPY.

### 2. What is replayed

- **Names, bars, contracts, prices, fees, management and the day's limits:** as DEC-0031 sections 1 to 4. The
  premium cap and spread cap are EXP-0029's (`config/options_clone.yaml`), not DEC-0031's $2.00.
- **Sessions:** fixed by rule, with nothing to write by hand. They are every session of the exchange calendar
  (`wt.options.levels.is_session`) after the day this record is accepted, in order, until 40 sessions or
  2027-04-30, whichever comes first (`wt.options.exp0037.due`).
- **Inputs, as each session passes:** the host job `exp0037` (`scripts/exp0037_replay.py nightly`, 17:15 New York,
  Monday to Friday) runs the evening each session closes. It fetches that session's inputs into `data/exp0037/`
  and writes their sha256 to `var/research/exp0037/input_sha256.json`. It replays nothing, and no one reads those
  inputs. A session it cannot fetch is tried again each evening. After 3 failed evenings it is recorded as
  skipped: it stays on the list, is never replayed, and the report names it.
- **Run once,** by the same job, the evening the list closes. It runs all four configs at the same commit, after it
  checks every saved hash again and runs check_first. The engine is the one that merged EXP-0037's replay code
  (`af9b3590e638`). If any engine file (`wt.options` dryrun, variants, setups, regime, session, bs, levels and
  intraday) differs on the host from that commit, the run stops until a decision record names the engine. It writes `result.json` and `report.md` under
  `var/research/exp0037/` and pages the owner. The result is then committed into EXP-0037 by a pull request, and
  read as section 4 says.

### 3. What is compared

- **Unit:** a trade. A trade is matched across configs by (session, name, setup, side, signal bar).
- **Groups, for each variant:**
  - *Added:* trades the variant takes that the control does not.
  - *Displaced:* trades the control takes that the variant does not, which happens because one position is held
    at a time. These are counted and reported, but not tested.
- **Measure:** return on premium, after the spread and fees, at 1× and 2× DEC-0029's spread (DEC-0031 section 2).

### 4. The verdict, read once

- **Supported** when all of the following hold, for a hypothesis with at least **30 added trades in at least 15
  sessions**:
  - The lower end of the bootstrap range of the added trades' mean return on premium at 1× the spread is **above
    0**. The range is the 0.833rd percentile, the Bonferroni-corrected 95% across the three hypotheses. It
    resamples sessions with replacement, 5,000 times, using numpy's PCG64 generator seeded with the hypothesis's
    seed and numpy's linear percentile.
  - The added trades' mean at 2× the spread is also above 0.
  - The variant's total over all its trades minus the control's total, at 1× the spread, is not below 0.
- **Falsified** otherwise.
- **Too few:** fewer added trades or sessions than above means no verdict. That is an exploratory mark, not proof.
- **No verdict by itself changes the clone.** A supported variant may be proposed in a further record, which
  freezes it for a new paper experiment.

### 5. Gaps found in the same debrief, not registered here, and why

- **The feed-fitness switch can end a session on one slow contract,** and **the contract's volume floor reads the
  day's cumulative volume early in the morning.** Both need the live quote record, which history does not have
  (DEC-0031 section 2 leaves out the delta, volume and open-interest gates). The nightly scorecard (#459) now
  counts `feed_unfit` and the refusals by reason, so how often these bind can be measured before a record is
  written.
- **A touch exactly on the retest tolerance can be missed by floating-point rounding** (`setups.retest`, the
  `<= near * a` test). This is a fidelity question, not a strategy one, and its effect is expected to be
  negligible. If it is worth fixing, it goes as a fidelity note in EXP-0029 with its own pull request.
- **Robot B acts on the first signal of the day only.** That is Robot B's record set (the global trial count),
  not family O. It needs its own record.
- **The board and the clone differ** in how they read a break. That is DEC-0052 and DEC-0053.

### 6. Trial count

Family O: 38 before this record, **41** with HYP-0062, HYP-0063 and HYP-0064 (`config/trial_registry.yaml`). The
row is `proposed` until the owner accepts this record.
