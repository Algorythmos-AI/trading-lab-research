# Engine identity check over the last logged sessions

DEC-0051 section 8: before a release that changes DEC-0044's engine label reaches production, every fixture **and the
last 10 logged sessions** go through the old and the new engine. The fixture half is a test that runs in CI. This
runbook is the other half. It needs the production store, so the owner runs it on the Mac, never in CI.

It answers yes or no, with counts, for each label change. The answer becomes a dated line in EXP-0034's `README.md`
("Dates and commits"). For a rule change (DEC-0052), "rows differ" is the expected answer. For a defect fix, a
difference outside the boundary cases it names is a finding to report before the release.

## What it does

1. **Collect** (`dashboard/scripts/identity-collect.mjs`). This step is read-only. From the production store it copies:
   - every server record of the last N sessions that have one (`desk/log/<day>/<HHMM>.json`);
   - every edition copy of those sessions (`options/copies/<day>/`).

   It then reads the sessions' 2-minute bars again from Alpaca, on the feed you name. It writes all of this to a new
   folder outside the repo, owner-only, and prints counts.
2. **Replay** (`dashboard/test/validation/engine-identity-sessions.test.ts`):
   - It extracts each engine named by a git ref (`dashboard/src/lib` at that commit) into a temporary folder.
   - It rebuilds every logged slot's input and runs that input through every engine.
   - It prints, for each pair of labels, the slots, names and rows, how many differ (a side's state, `brokeAt`, card
     numbers), and the state changes.
   - It writes a private report beside the collected files, naming the slots and names that differ.

What a record does not keep is filled in the same way for every engine, so a difference comes from the engines:
- **Journal:** none is passed. The journal only sets the day's flags.
- **Snapshot high and low:** only the bars' are used.
- **Last trade time:** taken from the record's probe where it has one. The probe's clock is the start of the run's
  reads and the record's clock is their end, so this time can be up to about 3 s late. The report counts the names
  where that could put the trade on either side of the slot's end.
- **Records skipped and counted:** a record written on another feed than the bars collected, a record whose edition
  was another day's, and a record whose edition the store did not keep.

So this half does not exercise three things:
- the journal's day flags;
- the bad-data guards' pauses;
- the snapshot's own high and low.

The report says so on its last line. For a release whose engine change is in that code (trade rules, the day check,
the quote guards), take the answer from the fixture half or from a review.

The "inputs check" line says in how many slots the old engine rebuilt the rows it logged. That shows how close the
rebuilt inputs are to what production read. It is a quality figure, not the answer.

- **The day's limit.** The replay has no journal, so the limit reads as not used. Where the record says it was used
  (`day.day_limit_used`), the board drew no trade on every row not paused. The inputs check applies that, comparing
  rows as a set, and gives the in-order count without it beside it.
- **Read on the pairs' line.** Each pair's names line counts the differing names in those slots apart: the board drew
  no trade there, whatever the engines' sides say.
- **What stays unmatched.** The engine also takes the snapshot's day high and low, read at run time, about 110 s after
  the slot's end. The record holds no prices, so a slot where the next bar set a new extreme cannot be rebuilt.

## Steps (owner, on the Mac, after the close)

You need Node 22.18 or later, because the collector loads one `.ts` file directly. For 10 sessions the collector makes
about 2,000 reads of the store.

1. **Get a checkout of the code being released.** For example:
   ```
   git -C ~/trading fetch origin
   git -C ~/trading worktree add ~/trading-wt/identity-run origin/integration
   ```
   Then link or install `node_modules` in `~/trading-wt/identity-run/dashboard`.
2. **Put only the values it needs into a file outside any checkout.** It needs `BLOB_READ_WRITE_TOKEN`,
   `ALPACA_API_KEY_ID`, `ALPACA_API_SECRET_KEY` and `ALPACA_FEED` (production's, `sip`):
   ```
   mkdir -m 700 ~/identity-env
   ```
   Copy the four values from Vercel (the project's production environment variables, and Storage → the blob store →
   `.env.local` for the token) into `~/identity-env/identity.env`, one `NAME=value` per line.

   Pulling every production variable with `vercel env pull` also works. It needs the folder linked (`vercel link`), and
   it writes every production secret to disk, so copy only the four out of it and delete the rest at once. A variable
   marked sensitive comes back empty from the pull.
3. **Collect.** `--until` is the last session to include, as a New York date:
   ```
   set -a; . ~/identity-env/identity.env; set +a
   node --no-warnings scripts/identity-collect.mjs --out ~/identity-$(date +%Y%m%d) --sessions 10 --until 2026-11-16
   ```
   It refuses a folder inside any git checkout.
4. **Replay.** Name the engines oldest first: production's (`origin/main`), any label in between, and the release's.
   For the release that carries `e-05b589ff4f1c` and `e-d6053c7fdd0a`:
   ```
   IDENTITY_BUNDLE=~/identity-YYYYMMDD IDENTITY_ENGINES=origin/main,8cd5ff0d,origin/integration \
     npx vitest run test/validation/engine-identity-sessions.test.ts -t "logged sessions"
   ```
   It refuses a collected folder whose files changed since the collector wrote them, by their SHA-256 in
   `manifest.json`.
5. **Delete the values file:** `rm -P ~/identity-env/identity.env`. Keep the collected folder until the release has
   shipped, then delete it. It is PRIVATE.
6. **Write the result into EXP-0034's `README.md`:** a dated line under each label change's identity entry, with the
   answer and the counts as printed. For a release that changes the label, also add the DEC-0044 engine-table row.

## What it never does

- It never writes, copies or deletes in the store; a test holds the collector to `list` and `get`.
- It never places, stages or suggests an order.
- It never prints a symbol, a price or a level.
- It never writes inside the repo.
