# DEC-0070: the Radar's candidates enter the Options desk's universe, through a fail-closed gate, after the research

- **Status: ACCEPTED on 2026-11-23.** approved_by: owner. Proposed on 2026-11-22 (#594) and accepted by the owner's
  merge of the pull request that changed this line.
  - The owner asked for this accepting change on 2026-11-23, in chat. The merge is the acceptance.
  - **The owner's choices (section 5):** the groups are taken over S's whole universe (item 3, *Proposed*), and
    HYP-0053's fixed rule stays over the desk's 12 (item 4, *Proposed*).
  - `config/options_universe.yaml` at acceptance: `universe_sha` `bf1db9a4e7749f36086cc25a4cc7bb754c32d5db96b8ccb6d7d927628ce5e890`.
  - Acceptance selects, publishes and trades nothing. The shadow runs (section 6). No Radar name joins the universe
    while the gate's thresholds are unset (section 3), and the published focus changes only with DEC-0048.
- **Why now:** the owner asked on 2026-11-20 and 2026-11-22 for one connected pipeline: the Radar researches broadly
  and publishes a validated dataset, and the Options desk's deterministic rules filter and rank it. The owner also
  set the scope: the Radar is for options only; Gap Hunter (DEC-0068) is a separate stock robot with its own
  discovery and is not touched.
- **Kind:** a change to a selection rule (AGENTS rule 2). Written before any affected P&L is viewed: no outcome of any
  pick, no ledger result, no journal and no backtest of this selection was viewed or run to write it.
- **Amends** (each only where it says so; everything else in them stands):
  - DEC-0046 section 1 (the universe) and section 3's timing (section 2 and 4 below);
  - DEC-0047 sections 1, 2 and 6, and EXP-0032's `config.yaml`, before EXP-0032's first counted session (section 5);
  - DEC-0055 section 7 and its HYP-0067 (section 7).
- **Reverses, and says so:** the owner's decision of 2026-11-17 ("keep 12 names; measure first"), and DEC-0055 section
  7's order (the Radar would supply names beyond the 12 only after HYP-0065 is supported). The owner's words of
  2026-11-22 replace both.
- **Does not amend:** DEC-0035 (the card), DEC-0046 sections 3 to 5 apart from the timing (every Stage 1 rule, weight,
  tie-break and frozen value; `config/options_select.yaml` and its params_sha `08617613…`; `levels.py`, `select.py`,
  `events.py`, so `picker_ref` does not move), DEC-0060 and DEC-0067 (the lab tape records the desk's 12), DEC-0064,
  DEC-0068, the options clone's records (the clone trades the desk's 12).
- **Trials:** none added. On acceptance the R family's total drops from 3 to 2 (HYP-0067 withdrawn, section 7); the
  F family stays at 5.

## What has already been seen

- The records DEC-0046, DEC-0047, DEC-0055 and EXP-0032, the funnel audit `docs/radar-method.md` in
  trading-options-funnel, and the code paths of the Radar edition, the cloud picker's copy and `select.py`.
- `docs/radar-method.md` states a Radar result: DAILY RADAR beat SPY on 8 of 15 sessions (25 Sep to 22 Oct), and it
  counts BREAKOUT lines. The author read that tally. It is the Radar's own prose scorecard from the prior close, not an
  outcome of any desk selection, and nothing in this record was set from it.
- Status counts only, for the timing in section 4: the Radar's build fires at 05:30 New York and stores its edition
  between about 05:50 and 06:15 (`radar-pipeline-slots.ts`, the run beacons); the site freezes a session's focus at
  09:25 New York (`dashboard/src/lib/premarket.ts`).

## Why

1. **No path existed.** The four names on the Options page were picked by a cloud routine after the prior close,
   from the desk's fixed 12. Nothing read the Radar into any picker. The Radar for a session is built about 13 hours
   after that session's pick, so even a wire could only have carried yesterday's research.
2. **The pick must follow the research.** Stage 1 scores the finished session D's daily bars, which are final after
   D's close; running it on the morning of S, after the Radar, changes none of its inputs except the names. DEC-0047
   section 1 already allows Stage 1 until 09:30 on S.
3. **The research needs a contract, not a copy.** A deterministic reading of the stored edition gives a record with a
   hash, a freshness rule and no prose, which a replay reproduces.
4. **A wider universe needs a gate.** `select.py` has no optionability or liquidity check, and it treats an unknown
   earnings date as a caution only. For the desk's 12 that is safe (their dates are kept by hand); for a name the
   Radar found this morning it is not. The gate fails closed.

## Decision

### 1. The pipeline

```
Radar edition for S (stored)  →  candidates (wt.options.radar_candidates)  →  gate (wt.options.universe)
  →  Stage 1 bundle for D over the universe (select_fetch.fetch_stage1)  →  Stage 1 (select.run_bundle, unchanged)
  →  picks for S  →  Stage 2 Pass A 08:50, Pass B 09:20 (unchanged)
```

Code: `src/wt/options/radar_candidates.py`, `src/wt/options/universe.py`, `src/wt/options/radar_select.py`; config
`config/options_universe.yaml` (its `universe_sha` is recorded in every record; at acceptance `bf1db9a4e774…`, in full above);
earnings rows for non-desk names `config/events/earnings_radar.csv`.

### 2. The universe (amends DEC-0046 section 1)

The universe for S is the desk's 12 names (`config/options_desk.yaml`, unchanged) followed by at most `max_additions`
Radar candidates that pass the gate, in the gate's order. When the Radar's edition for S is missing, stale or invalid
the universe is the 12, and every record says which (`radar_missing`, `radar_stale`, `radar_invalid`).

- **Candidates** come only from the lists named in `radar.lists_in_scope` (DAILY RADAR, MEGA CAP OPTIONS, BREAKOUT
  WATCH). Every other list, and any list name not written there, supplies nothing and is counted.
- **Freshness:** the edition's `edition_date` is S, its `as_of` after D's close and before the run, its `prices_as_of`
  within `prices_max_age_minutes` of the run.
- **Symbols** are normalised (upper case, one class letter after a dot, `GOOG` folded into `GOOGL`) and deduplicated.

### 3. The gate (new)

Applied to Radar names only; the 12 never pass through it. In order, the first failure names the reject:
Stage 1's own validity checks on D's bars; a price floor; a 20-bar median dollar-volume floor; an option chain with
an expiry within `chain_expiry_max_days` of S, at least `chain_ntm_strikes_min` contracts within `chain_ntm_pct` of
the close, prior-session volume of at least `chain_volume_min` and a median spread of at most `chain_spread_max_pct`;
the next report known (Stage 1's `earnings_date_unknown`, promoted to a reject: a row in either earnings file, or a
recent one); and no report on D, S or the session after S in the Radar's own calendar (used only to reject).

**The five numeric thresholds are unset (null).** While any is unset, every Radar name is rejected `gate_unset` and
the universe is the 12. They are set by a dated amendment to this record from status frequencies on saved data only
(how many Radar names each value would keep over the shadow sessions), never from outcomes: DEC-0046's method for
Stage 2. `max_additions` is 8 and `chain_ntm_pct` 0.05, `chain_expiry_max_days` 7: limits on work and shape, not
results.

**A known limit:** the repository has no earnings source for names outside the 12. Until rows are added to
`config/events/earnings_radar.csv` (from the company's own announcement or a named source, like `earnings.csv`), or
the Radar publishes structured earnings dates (an owner edit of the cloud skill), almost no discovered name passes
the earnings check. That is the intended failure: a name whose report date is unknown is never selected.

### 4. When Stage 1 runs (amends DEC-0046 section 3's "after the close")

Stage 1 for S runs at 06:45 New York on S, after the Radar's build, on the bundle for D. It retries the Radar read
until 07:45 New York and then runs on the 12. Its picks must be ready by 08:40 New York; a later run is recorded and
marked late, and its picks are not published.

### 5. EXP-0032 and DEC-0047 (amended before the first counted session)

EXP-0032 has counted no session. Its `config.yaml` allows a decision record to amend it before the first one. The
changes:

1. **Section 1, early ends:** "a change to the universe (`config/options_desk.yaml` `names`)" stays an early end.
   Added: a change to `config/options_universe.yaml` after the first counted session is an early end too, as is a
   change to the code of `radar_candidates.py` or `universe.py` that the record does not name as a non-change.
2. **Section 2, the unit:** "each of the twelve names" becomes "each name of S's universe". A Radar name in the
   universe is scored by the same rule as a desk name, so the switch (DEC-0048) must publish card fields for every
   universe name, not only the picks.
3. **The groups.** Chosen on acceptance (2026-11-23): *Proposed*.
   - *Proposed:* *Picked* and *the rest* are taken over S's whole universe, as written for the 12. The sizes vary by
     session (4 against 8 to 16); the test statistic in section 5 is already a per-session difference of group means,
     so it needs no change.
   - *Alternative:* the groups are taken over the desk's 12 only, and Radar names are reported descriptively (section
     7). The experiment then tests the scoring on the 12 as registered, and says nothing about the Radar's names.
4. **HYP-0053, the fixed rule** (SPY, QQQ and the two highest-ATR% names). Chosen on acceptance (2026-11-23): *Proposed*.
   - *Proposed:* the fixed rule stays over the desk's 12. It is the baseline the selection must beat, and it should
     not move with the Radar.
   - *Alternative:* the fixed rule is taken over S's universe.
5. **Sessions on the 12 alone** (the Radar missing, stale or invalid, or no Radar name admitted) are counted like any
   other session; each record says so.

The blind rule (DEC-0047 section 8) is unchanged and covers Radar names: no outcome of a name that was not picked is
shown or computed before the read.

### 6. The shadow, and what the switch needs

Before the switch, the job runs as a shadow: it writes its records under `var/options-select/<S>/` and publishes
nothing; the four names on the Options page are still the cloud routine's. DEC-0046 section 7's five clean sessions
(an operational gate: the code runs correctly on real data; not evidence of skill) are counted on this pipeline.

The switch is DEC-0048 (not written). It names: the first session on which the published focus is this pipeline's
picks; the owner's step that turns off the cloud after-close pick; the card fields for every universe name (section 5
item 2); and the board's handling of a non-desk pick (section 6a).

#### 6a. The Trade now board and a non-desk pick (added 2026-11-23, before acceptance; a blocker for DEC-0048)

An audit of the dashboard on 2026-11-23 (code only; no outcome seen) found that the statement first written here, "a
non-desk pick shows NO TRADE", is true of the signal word only:

- `signal.ts` `signalWord` cannot say CALL or PUT for a name the event calendar does not keep: its shock gate is
  unread (`earnings_not_kept`), and CALL or PUT needs every market gate to pass. It can say WAIT or NO TRADE. Its only
  caller is the signal record (`signal-run.ts`); no page draws it.
- Every owner-facing surface draws from the row state (`trade-state.ts` `nameState`), which reads no calendar and holds
  no list of names: the Trade now board's row and notice (`trade-now.ts` `rowView`, `noticeKey`, `entryPrompt`), its
  browser notification and sound, the hero, the focus card and glance, the status rail and the manage card's "I'm in"
  form. A non-desk name in the entry zone would read ENTER ZONE with entry, stop and target, and nothing would check
  its earnings. No phone (ntfy) alert is sent from any trade state.

`trade-now.ts` and `trade-state.ts` are inside the engine closure (`desk-eval.ts` imports both), so a guard there
moves `ENGINE_VERSION`: the owner's change, by its own record. **Until such a guard is registered and merged, the
switch must not publish a non-desk name in the focus**, and DEC-0048 names this as its precondition. Before the switch
every focus name is a desk name (the cloud routine picks from the 12), so nothing on the board changes today.

### 7. DEC-0055 (PROPOSED) and HYP-0067

The Radar is for options only. HYP-0067 (SMALL CAP MOMENTUM against IWM) evaluates a stock list, which is Gap Hunter's
ground; it is withdrawn before DEC-0055 is accepted, and DEC-0055's family R totals 2. Section 7's order ("only after
HYP-0065 is supported") is replaced by this record. HYP-0065 and HYP-0066 stand as proposed; they measure the Radar's
DAILY RADAR list, not the desk's selection.

### 8. The options clone and the pipeline check take the desk's names only (added 2026-11-23, before acceptance)

The clone trades the desk's list (DEC-0030; this record does not amend the clone, above). Its code took every focus
name, so after the switch a Radar name in the focus would have been traded, outside EXP-0050's registered scope. Rule,
in `wt.options.clone_names.on_desk`, applied to the focus before `wt.options.session.names` by the runner and by the
pipeline check's copy of its choice (`eligible`). `wt.options.session` itself is not changed: EXP-0037's replay pins it.

1. The focus names are filtered to the desk's names (`config/options_desk.yaml`, read the same way by both) before
   the cap of `names.max_names`. The order, the de-duplication and the source word (`focus`) are unchanged.
2. When no focus name is left, the source is `fallback`, as for a focus picked for another day.
3. A name left out is never fetched, planned or traded; the `names` journal line lists it (`off_desk`). Top-up
   (DEC-0032) and the standing name (DEC-0058) apply as before.
4. An unreadable desk file leaves no focus name: the fallback trades.

`names.fallback`, `names.standing` and `names.top_up` are all desk names, and the cloud routine picks the focus from
the 12, so no session so far would have chosen differently: EXP-0050 is unchanged. The options lab's recorder and
probe already keep only desk names (DEC-0060, DEC-0067). Plan step 5's other part (the positions job reading hourly
bars and rule states for a non-desk focus name) waits for DEC-0048: nothing can reach it before the switch.

## What is not decided here

- The gate's five thresholds (a dated amendment, section 3).
- The switch (DEC-0048).
- Edits to the cloud Radar skill (dropping its stock lists; publishing structured earnings and scan counts): the
  owner's, in the claude.ai project.

## Consequences

- The Radar and the Options desk meet at one hashed record, and a replay reproduces a session from its saved inputs.
- On a wider universe Stage 1's ranks are relative to every name, so the 12's ranks can move when Radar names join.
- Until the thresholds are set and earnings rows exist for discovered names, the pipeline runs and records every
  candidate, and the universe stays the 12.
