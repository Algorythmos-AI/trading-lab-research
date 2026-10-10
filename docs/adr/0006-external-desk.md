# ADR 0006: An external desk on the status site

- **Status:** accepted, 2026-10-11
- **Context:** the owner's decision to show the HFT platform, which is built in its own repository (`hft-lab`), as
  a third desk on the status site

## Context

ADR 0005 expected a third desk to be "a new `Desk` record, a venue package and a snapshot schema" in this
repository. The HFT desk is not that. It is a separate platform in a separate repository: it trades currencies on
a broker paper account, fully automatically. It records quotes, runs strategy sleeves, keeps a conservative shadow
book beside the broker's and retrains weekly.

This repository has no code for it and will not get any. It is not running yet, so no snapshot exists.

The status site is still the one place the owner looks to see whether everything is OK. A second site for one
desk would mean a second login, a second watchdog and a second thing to keep deployed.

## Decision

1. **The site shows the desk; this repository does not hold it.**
   - `hft` is a desk on the dashboard only (`dashboard/src/lib/desk.ts`): a label, a first page (`/hft`), a
     snapshot slot, a history prefix and a watchdog state.
   - Nothing under `src/wt/` knows it. There is no `Desk` record, no job and no publisher here, and nothing in
     this repository can place an order for it.

2. **The contract is owned by the other repository and vendored here.**
   - `dashboard/src/lib/hft.schema.json` is a copy of `contracts/hft-snapshot.v1.schema.json` in `hft-lab`.
   - `hft.contract.lock.json` records the source repository, path and commit, and the copy's SHA-256. A unit test
     recomputes the hash, so the copy cannot drift without a failing check.
   - `make schema` does not generate it, and CI's regenerate-and-diff step does not list it. `pnpm gen:types`
     builds `hft.types.ts` from it, as it does for the two edition schemas the dashboard owns.

3. **The contract carries no free text.** Version 1 holds ids, enumerations, timestamps, counts and numbers
   (data class SAFE). Every string is an enumeration or a short anchored pattern, every object is closed, and
   `mode` can only be `paper`. Reason codes are shown as codes.

4. **Publishing uses the same signed ingest.**
   - `POST /api/ingest`, HMAC over `timestamp.body`, with the same size cap, denylist, duplicate `run_id` rule and
     stale `as_of` rule as the other desks.
   - The body's own `schema` (`hft-lab/snapshot`) picks the contract, and the contract names both the validator
     and the slot (ADR 0005, decision 3). An HFT body cannot be filed under another desk, and no other body can
     be filed under HFT.

5. **The page is empty until the desk publishes.**
   - Before the first snapshot, `/hft` says what the desk is and that it has not published. It shows no numbers.
   - The watchdog skips a desk that has neither a snapshot nor an alert state (ADR 0005, decision 6).
   - `/api/health` reports `desks.hft.snapshot` as `missing`.

6. **Off-host monitoring follows the windows the desk publishes.** Currencies trade from Sunday evening to Friday
   evening in New York. Each snapshot's `expected_windows` must list the window that is open or the next one to
   open. When every listed window has ended, the watchdog falls back to US equity weekday hours.

## Consequences

- A fourth desk is one more entry in each per-desk record (the registry in `desk.ts`, the contracts in
  `validate.ts`, the watchdog's `DESK_DEPS`, the header's lookups), plus a loader and a page.
- A contract change ships in two steps, in this order: the dashboard (new copy, new hash), then the publisher.
  Ingest refuses fields it does not know.
- The first snapshot stored in the HFT slot arms its watchdog for good, and a test publish to production does the
  same. Disarming it means deleting `snapshots/hft/latest.json` and `alerts/hft-state.json`.
- Ingest's primary-host rule is not per desk. A snapshot signed with a key id other than `PRIMARY_HOST` is filed
  in the desk's shadow slot, which no page reads. Which key the HFT publisher signs with, and whether a key can
  be limited to one desk's schema, has to be settled before the desk first publishes. It is not settled here.
- Every page now reads three latest snapshots instead of two.
