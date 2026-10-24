# Incidents and false alarms

One entry per event: what was seen, what it was, and what changed. Newest first.

## 2026-10-10 onward: "Cannot read properties of null (reading 'r')" in the dashboard's e2e logs (false alarm)

- **Seen:** the line `TypeError: Cannot read properties of null (reading 'r')` in the `[WebServer]` output of the
  dashboard's browser tests, on 10, 13 and 23 October. Several sessions read it as a production bug on Overview.
- **What it is:** the e2e fixture `poison` (`dashboard/src/lib/fixture-variants.ts`, `poisonedOptions`) stores an
  options edition whose paper record holds a `null` row, on purpose. The paper scorecard
  (`dashboard/src/components/options.tsx`) reads `p.r` from that row and throws. Its pane boundary catches it and
  shows "Paper scorecard" as failed; the test "a corrupt paper record breaks the scorecard and nothing else"
  (`dashboard/test/e2e/desk.spec.ts`) asserts exactly that. The server still prints the error, so it appears in the
  log of every passing run.
- **Production:** not reachable. Ingest validates every edition against its schema, which forbids a null paper
  row, before it is stored.
- **Changed:** nothing in code. This entry exists so the line is not chased again.
