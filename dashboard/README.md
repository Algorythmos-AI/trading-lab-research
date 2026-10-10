# Trading Lab status dashboard

A private, read-only status page for the paper-trading research lab, built with Next.js and hosted on Vercel.
It shows the owner, on a phone or a laptop, whether last night's jobs ran, what the research says, how the paper
account is doing and whether anything needs attention. It cannot trade, stop, reset or change anything.

## Architecture

The dashboard never reaches into the Mac. The Mac pushes; Vercel stores and serves.

```
Mac (launchd job)                         Vercel project (Vercel Authentication on every deployment)
─────────────────                         ─────────────────────────────────────────────────────────
wt.ops.publish                            POST /api/ingest            (production only)
  collect  → sanitize (allowlist) ──────▶   size cap 3.5 MB → HMAC + ±300 s → schema + denylist
  sign HMAC-SHA256, POST with the           → compare with the stored run_id / as_of
  automation-bypass header                  → private Blob snapshots/latest.json   (ifMatch etag)
                                            → private Blob snapshots/history/YYYY-MM-DD/HH.json

                                          Pages (server components, never cached)
                                            read snapshots/latest.json (useCache: false)

                                          GET /api/cron/watchdog      (Vercel Cron, every 10 min)
                                            late / stopped / recovered pages during trading windows,
                                            one "Mac offline" note a day otherwise → ntfy
                                            alert state in private Blob alerts/state.json
                                            prunes history older than 90 days, once a day
```

- **Contract.** `src/lib/snapshot.schema.json` is generated from the Python allowlist (`make schema`) and is
  read-only here. `pnpm gen:types` regenerates `src/lib/snapshot.types.ts` from it. Every field may be null or
  missing, and every page renders "—" for missing values instead of failing.
- **Ingest** (`src/lib/ingest.ts`): previews never accept writes. Accepted outcomes are `stored`, `duplicate`
  (same `run_id`) and `older` (409, `as_of` not newer than the stored one); an etag conflict is retried once.
- **Radar** (`/radar`): the daily pre-market radar's editions, signed with key id `radar` and validated against
  `src/lib/radar.schema.json` (owned here; `pnpm gen:types` regenerates `radar.types.ts`). Stored at
  `radar/latest.json` plus `radar/editions/YYYY-MM-DD.json`, where a same-day refresh replaces that date's copy.
  It has no expected windows, so the watchdog never pages for it.
- **Options** (`/options`): the after-close options levels editions (support and resistance for the next session,
  close strength, expected move, optional recent daily bars for the level map, and the paper record of the probation
  entry rules), signed with key id `radar` and
  validated against `src/lib/options.schema.json` (owned here; `options.types.ts` is generated). Stored at
  `options/latest.json` plus `options/editions/YYYY-MM-DD.json`, one per session the levels are built for. Like the
  radar it has no windows and no watchdog.
- **Live prices** (`/api/quote?s=SPY,QQQ`, read by the Options page every 2 s while it is open, one poll shared by the
  glance strip, the level maps' live dot and the state chips; a quote older than 30 s shows as stale): last trades from
  Alpaca's free IEX feed, fetched on the server so the page keeps `connect-src 'self'` and never sees the keys. At most
  12 symbols, cached 10 s per instance; 503 until the keys are set, 502 when Alpaca fails. Fixture mode answers from
  the options fixture with no keys and no network. Research only: the keys are market-data keys and nothing here
  can trade.
- **Watchdog** (`src/lib/watchdog.ts`, pure and unit-tested): in a window a snapshot older than 35 min is late
  and older than 90 min is stopped (both priority 4); a fresh snapshot after an alert sends "recovered"
  (priority 2). Outside every window nothing pages. The alert state is committed with `ifMatch` before paging,
  so a double cron fire pages once. Page text carries R and % only, never currency amounts.
- **Health** (`src/lib/health.ts`) and the top-of-page **summary** sentence (`src/lib/summary.ts`) are pure
  functions of the snapshot and the current time.

## Local development

```sh
pnpm install
DASHBOARD_FIXTURE=1 pnpm dev        # serves test/fixtures/snapshot.json, no storage or secrets needed
```

| Script | What it does |
|---|---|
| `pnpm dev` / `pnpm build` / `pnpm start` | Next.js development server, production build, production server |
| `pnpm lint` | ESLint (Next.js core-web-vitals + TypeScript rules) |
| `pnpm typecheck` | `tsc --noEmit` in strict mode |
| `pnpm test` | Vitest unit tests: HMAC vectors, schema and denylist, health, summary, watchdog, ingest |
| `pnpm test:e2e` | Playwright smoke test of all six pages in fixture mode. CI only: it needs `pnpm build` first and a browser installed by the workflow (`pnpm exec playwright install --with-deps chromium`) |
| `pnpm gen:types` | Regenerate `src/lib/snapshot.types.ts` after the schema changes |

Fixture mode is refused on production deployments, and the page shows a banner whenever it is on.

## Environment variables

| Name | Where | Purpose |
|---|---|---|
| `BLOB_READ_WRITE_TOKEN` | Vercel **production only** (added when the private Blob store is connected) | Read and write snapshots and alert state. Previews must not hold it: they run with `DASHBOARD_FIXTURE=1` |
| `DASHBOARD_INGEST_SECRET` | Vercel production + the Mac's `~/trading/.env` | Shared HMAC key for `/api/ingest` |
| `RADAR_INGEST_SECRET` | Vercel production + the radar's cloud environment | HMAC key for key id `radar`. It may only publish research editions (`stocksdelta/radar`, `stocksdelta/options`); unset means the radar key is refused |
| `ALPACA_API_KEY_ID`, `ALPACA_API_SECRET_KEY` (or Alpaca's own `APCA_API_KEY_ID`, `APCA_API_SECRET_KEY`) | Vercel production only | Alpaca paper-account keys, used only for the free IEX market data behind `/api/quote`; unset means the Options page shows live prices as off |
| `ALPACA_DATA_URL` | Vercel (optional) | Market-data base URL, default `https://data.alpaca.markets` |
| `CRON_SECRET` | Vercel production | Bearer token Vercel Cron sends to `/api/cron/watchdog` |
| `NTFY_TOPIC` | Vercel production and preview + the Mac | Secret, random ntfy topic for pages; unset means log and skip |
| `NTFY_SERVER` | Vercel (optional) | ntfy server, default `https://ntfy.sh` |
| `DASHBOARD_FIXTURE` | Local, CI and Vercel preview | `1` serves the fixture snapshot (ignored in production) |
| `DASHBOARD_INGEST_URL` | The Mac | `https://lab.algorythmos.com/api/ingest` |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | The Mac | Lets the publisher through Vercel Authentication |

`scripts/provision_secrets.sh` creates or rotates all of these in one go, for the owner to run once. It never
prints a secret; it prints only the ntfy topic and how to subscribe to it.

## Security model

- **Vercel Authentication on all deployments.** Only the owner's Vercel login can open the site. The only
  exception is the automation bypass secret, which only the Mac's publisher holds.
- **Signed writes.** `/api/ingest` accepts only production writes signed with HMAC-SHA256 over
  `"<timestamp>.<body>"` with a ±300 s window, compared in constant time. Bodies are capped at 3.5 MB.
- **Schema plus denylist.** Every snapshot is validated against the JSON Schema (`additionalProperties: false`
  everywhere), and a server-side denylist refuses restricted keys (decision titles, hypothesis names and
  statements, spec title and open items, headlines, review URLs, subjects, statements) even if a future schema
  allowed them. Validation errors name paths, never values.
- **Read-only UI.** No page has a control that trades, kills, resets or changes anything. The only buttons
  switch the colour theme and copy a command to the clipboard.
- **No secrets client-side.** Storage, HMAC and cron checks run only in server code; nothing secret is sent to
  the browser. Logs are one JSON line per event and never include bodies, headers or secret values.
- **Headers.** `vercel.json` sets a strict Content-Security-Policy, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, a restrictive `Permissions-Policy`,
  `X-Robots-Tag: noindex, nofollow` and `Cache-Control: no-store` on pages and APIs; `robots.txt` disallows all.

## Data classes

The repository is restricted (see `AGENTS.md`). The dashboard only ever receives what the publisher's allowlist
lets through, and the ingest denylist is a second line of defence:

- **Restricted** material (specifications, decision and hypothesis prose, reports, setup names, news headlines,
  the knowledge base) is never published. Registries appear by ID, status and date only.
- **Private** material (paper account balances, host details, log lines, commit subjects) is shown only behind
  the owner's login, already redacted by the publisher.
- **Safe** material (counts, IDs, statuses, dates, R-multiples and statistics) makes up the rest.

## Deployment notes

- Set the Vercel project's root directory to `dashboard/` and connect a **private** Blob store.
- The watchdog cron runs every 10 minutes, which needs a Vercel plan that allows sub-daily cron jobs.
- CI: run `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`,
  `DASHBOARD_FIXTURE=1 pnpm build`, then install Chromium and run `pnpm test:e2e`.
