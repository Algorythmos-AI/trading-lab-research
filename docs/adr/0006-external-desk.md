# ADR 0006: An external desk on the status site

- **Status:** accepted, 2026-10-11
- **Context:** the owner's decision to show the HFT platform, which is built in its own repository (`hft-lab`), as
  a third desk on the status site

## Context

ADR 0005 expected a third desk to be "a new `Desk` record, a venue package and a snapshot schema" in this
repository. The HFT desk is not that. It is a separate platform in a separate repository: it is being built
to trade currencies on a broker paper account automatically: to record quotes, run strategy sleeves, keep a
conservative shadow book beside the broker's and retrain weekly.

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

## Addendum, 2026-10-11: the HFT publisher's key

This settles the open consequence above: which key the HFT publisher signs with, and whether a key can be limited
to one desk.

1. **The HFT publisher signs with its own key id, scoped to the HFT desk.** It runs from another repository as
   another Unix user. It is never given the `PRIMARY_HOST` key, which can write every desk's page.
2. **A scope is a per-key entry in `DASHBOARD_INGEST_SCOPES`** on the site: a JSON map
   `{"<key id>": {"desks": ["hft"]}}`, read by `dashboard/src/lib/ingest-scope.ts`.
   - A key id listed there is the primary publisher of exactly the listed desks, whatever `PRIMARY_HOST` says.
   - It may publish only those desks' snapshots. Another desk's snapshot, a research edition, the options live
     document or a body that names no known schema is refused with 403 (`key-scope`), and nothing is stored, not
     even in a shadow slot.
   - A key id not listed keeps the `PRIMARY_HOST` rule, with one change: it is not primary for a desk that a
     listed key owns. Its snapshot for that desk is filed in the shadow slot. So the stocks key cannot overwrite
     the HFT page, and the HFT key cannot touch anything else.
   - Unset or `{}`, ingest behaves as it did before scopes existed.
3. **The scope holds no secret.** The key's secret is one more entry in `DASHBOARD_INGEST_KEYS`, as for any host
   (ADR 0004). The signature is checked before the scope is looked at, so a wrong signature gets the same answer
   whether or not its key id is scoped.
4. **A value that cannot be read is not half applied.** If the variable is not exactly the documented shape, no
   scope is in force: every other key follows `PRIMARY_HOST` alone, as if the variable were unset. Every word of
   the value that could be a key id is refused outright (503, `key-scope-config`) and each signed request logs
   `ingest.scopes` with a reason code.
   - Why refuse those ids: the alternative is that a key the owner meant to limit becomes an ordinary key because
     of a typing mistake.
   - Why not refuse everyone: a typing mistake in one optional variable would stop the other desks publishing.
   - What it costs: while the value is broken, the `PRIMARY_HOST` key is primary for the HFT desk again. The log
     event is how that is noticed.
   - One desk given to two keys, a field beside `desks` and the research key's id (`radar`) count as unreadable.

### What the owner sets, and in what order

The site first, then the publisher. In the other order the publisher's requests are unauthorized (401), which is
harmless but pages nobody.

1. Choose a key id for the HFT publisher (letters, digits, `.`, `_`, `-`; at most 40) and generate a secret for it.
2. On the site's production environment:
   - add the id and its secret to `DASHBOARD_INGEST_KEYS`;
   - set `DASHBOARD_INGEST_SCOPES` to `{"<that key id>": {"desks": ["hft"]}}`;
   - redeploy, so the new values are read.
3. In the other platform's secrets file, readable by its Unix user only: the ingest URL, the key id (sent as
   `x-wt-key-id`), that one secret, and the automation-bypass secret that lets a publisher through the site's
   login. Nothing else of this platform's goes there.
4. Start the publisher. Its first stored snapshot arms the HFT watchdog (see Consequences).

From step 2 on, no other key can write the HFT page, including before the publisher first runs.
