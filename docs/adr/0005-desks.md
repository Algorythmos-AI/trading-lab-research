# ADR 0005: Desks

- **Status:** accepted, 2026-10-04; the crypto desk has since left (see the addendum at the end)
- **Context:** the owner's decision of 2026-10-04 to bring the Kraken crypto bot into the lab as a second,
  separately viewable desk

## Context

Until now the lab ran one thing: strategy B on one Alpaca paper account, in US equity hours, published as one
snapshot. That assumption is written into about 25 places: one `KILL` file, one journal, one lease key, one
runner lock, one snapshot slot, a watchdog that sleeps outside New York session windows, a backup that runs on
weekdays, and a deploy gate built on the equity calendar.

A crypto desk differs on every one of those points. It trades around the clock, it sizes in fractions, its
venue has no paper endpoint, and an outage at 03:00 on a Saturday matters.

The bot being migrated (`kraken-bot`, TypeScript) is a prototype: no exits, a daily-loss limit that could not
trigger, no tests, state lost on redeploy. It is rebuilt here, not copied.

## Decision

1. **A desk is a named record** (`wt.core.desk.Desk`): its state directory, kill file, journal, lease key, lock
   names, session model (`us_equity` or `always_open`), alert-key prefix and snapshot schema id.
   - `stocks` points at today's paths exactly. Nothing moves and no unit text changes.
   - `crypto` lived under `var/crypto/` (it has left: see the addendum).

2. **A desk owns** its state, kill switch, limits (`config/risk.yaml`, one top-level key per desk strategy),
   journal, snapshot and watchdog state. **The lab shares** the host, the job runner, deploys, alert delivery,
   backups, CI and the dashboard site.

3. **Nothing crosses desks.**
   - Alert keys carry the desk's prefix; each snapshot and each health banner shows only its own.
   - A broken evidence chain switches off entries on its own desk only.
   - Each desk has its own snapshot slot. Ingest picks the slot from the signed body's `schema`, never from a
     header.

4. **The crypto desk is paper by construction.**
   - Kraken has no spot sandbox, so paper means the lab's own simulator (`wt.crypto.book`) on live public
     quotes.
   - `wt.crypto` uses public market-data endpoints only. The host holds no Kraken credentials, and
     `tests/unit/test_broker_isolation.py` fails on any private endpoint, auth header or key variable.
   - `AGENTS.md` rule 1 names `wt.crypto` as the only other place that may book a (simulated) order.

5. **A round-the-clock desk runs as an interval job, not a daemon.** One run per 15-minute bar through
   `wt.ops.jobs.run_job`, so it takes the job lock, waits out a deploy, runs preflight and writes a heartbeat
   like every other job. A deploy takes the interval jobs' locks before it changes the checkout. The equity
   deploy gate is unchanged.

   A desk may run several **sleeves**: one registered strategy and one paper book each, with its own limits
   and loss latch (DEC-0014, DEC-0015). Sleeves share the desk's kill switch, its job and its one journal,
   where each row names its sleeve. Their results are reported per sleeve and never pooled.

6. **Off-host monitoring follows the desk's session model.** The crypto watchdog window is always open; a desk
   that has never published is "new" and does not page.

7. **A desk can leave, and then runs nothing here** (added 2026-10-11, for the crypto desk's move to its own
   repository). While the file `<state directory>.MOVED` exists (`var/crypto.MOVED`), `wt.ops.jobs.run_job`
   returns before it takes a lock or starts the job: no child process, no heartbeat, no check-in ping, no
   state. The desk also stops counting as installed, so the backup and the cadence check leave it alone.
   - Why it is needed with the timers disabled: installing the units enables every timer this code still
     renders, and a run without the desk's state would create an empty desk and publish it as healthy.
   - The marker is beside the state directory, not inside it, because the directory is moved away.
   - It covers jobs started by the scheduler. A module run by hand (`python -m wt.crypto.cycle`) does not
     pass through `run_job`.
   - Removing the marker brings the desk back: that is the rollback.

## Consequences

- A third desk (FX) is a new `Desk` record, a venue package and a snapshot schema; the shared layers do not
  change again.
- The stock order types stay integer-share; the crypto book has its own `Decimal` types. Unifying them is a
  separate decision.
- The nightly backup becomes daily, because evidence is now written on weekends.
- Two snapshots mean two publishers, two freshness pills and two watchdog states to keep green.

## Addendum: the crypto desk has left (org decision D-026)

The crypto desk moved to its own repository, `Algorythmos-AI/crypto-lab`, with its code, its tests, its research
records and their history. It runs there from its own checkout on the same host, under units named
`cryptolab-*`. The desk registry here now holds one record, `stocks`.

What was removed here, after the cutover had run clean:

- `wt.crypto`, `wt.ml`, the desk's scripts, configuration, lockfile, runbook and tests; the `crypto` record in
  `wt.core.desk`; its four jobs, their units and dead-man slugs; the machine-learning environment's sync in the
  deploy; the `ml` check; risk keys `C`, `CT`, `CD`, `CH` and trial family `C`.
- **Decision 4** no longer describes anything here. `AGENTS.md` rule 1 now says no crypto code may be added.
- **Decision 7, the moved-marker guard, is removed with the record it guarded.** It stood between the timers this
  code rendered and a desk whose state had been moved away. This code renders none of those timers any more, the
  job runner refuses a job name it does not know, and `sudo wt-install-units` removes the four old units because
  they are no longer rendered. The file `var/crypto.MOVED` may stay on the host: nothing reads it, and it keeps a
  rollback to an earlier `runtime-*` tag safe, because the code at that tag still has the guard.

What a desk that left leaves behind, and what is done about it (`wt.core.desk.RETIRED`):

- **Alert keys.** Every key that was firing at the cutover stays recorded as firing in `var/alerts/state.json`,
  and nothing here can resolve it: the desk's own `crypto:*` keys, its jobs' `job:<name>` and
  `refuse:<name>:<day>` keys, and `deploy-ml`. The stocks desk owns every key no other desk claims, so they would
  have shown on its pages as firing for good. They are dropped from the state by the first job that starts after
  the deploy, with one log line, no notice and no history row (nothing recovered; the desk raises its own alerts
  where it runs now). Until then neither the snapshot nor `make status` shows them.
- **Heartbeats.** The last runs of its four jobs stay in `var/heartbeats`. The stocks snapshot and `make status`
  leave them out.
- **Research ids.** Its records keep their ids in the other repository. `research/MOVED.md` lists them so that
  none is given to a new record here.

What remains shared:

- **The host.** One server, two checkouts, two unit prefixes. The backup here stays daily.
- **The dashboard site.** It still shows the crypto desk, from the snapshot `crypto-lab` publishes under the same
  schema id, in the same slot, with the same watchdog state. The schema and its fixture are copies of that
  repository's `contracts/` files at a tagged commit, pinned by `dashboard/src/lib/crypto.contract.lock.json`
  (ADR 0006 describes the same arrangement for the HFT desk). The dashboard is deployed before a publisher that
  sends new fields.
- **The ingest key and the alert topic.** Unchanged by the move.

Decisions 1 to 3, 5 and 6 still describe how a desk is added: a `Desk` record, a venue package, a snapshot schema.
The shared layers keep desks apart for the next one, and the tests hold them to it with a made-up second desk.
