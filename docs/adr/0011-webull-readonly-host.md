# ADR 0011: The owner's Webull account is read on the trading host, read only, by a client that cannot send orders

- **Status:** accepted on merge by the owner (asked for on 2026-11-15).
- **Context:** Webull Australia is where the owner places their own manual trades. The Trades page (`stocksdelta/journal`)
  has been fed by a cloud routine that read the account with Webull's official SDK, using a key kept in a shared
  cloud environment. Webull Australia's OpenAPI documents no read-only key: the key that reads orders can also place,
  replace and cancel US stock and ETF orders. (Options cannot be traded through it at all.) A full trading credential
  in a shared environment, driven by an SDK that carries order code, is more reach than a journal needs.

## Decision

1. **Webull is a read-only record of the owner's own trades.** Nothing in this repository places, previews,
   replaces or cancels a Webull order, now or later. Webull is not a market-data source and never an execution venue.
2. **Our own client, not the SDK** (`wt.webull.client`, standard library only). Every request goes through one
   function that refuses, before anything is sent, any method and path outside a fixed allowlist: six reads and the
   two token calls that Webull's sign-in approval needs. `tests/unit/test_webull_readonly.py` fails if an order path,
   the SDK or a second way to open a connection appears in the package.
3. **The key lives on the host only**, in `/etc/wt/webull.env` (root 0600), written by the owner with
   `sudo wt-set-webull-secret`. It is not one of the shared host secrets (`/etc/wt/secrets.env`,
   `/run/wt-secrets/env`), so no `wt` job, all of which run with order-routing code for paper trading, can read it.
4. **Its own user.** `wt-webull-pull.service` runs as the system user `wt-webull` and receives the key as a systemd
   credential (`LoadCredential=`), never as an environment variable. Its token stays 0600 in `/var/lib/wt-webull`.
   The unit is locked down (no capabilities, read-only system and home, no access to the shared secrets).
5. **Read and send are split.** The pull job writes what it read, group-readable, to `/var/lib/wt-webull/out`.
   `wt-webull-publish.service` runs as `wt`, holds the dashboard key but not the Webull key, builds the journal
   (`wt.webull.journal`, the same matching as the cloud routine) and sends it with this host's own dashboard key.
6. **The history is read from Webull itself.** The first evening run backfills every order since November 2023.
   Nothing is sent until that history is complete. The deposit and withdrawal history, which Webull's API does not
   give, is carried over once from the journal the site shows at cutover (`GET /api/editions/journal`).
7. **Logs carry counts and outcomes only**: no symbol, price, balance, account number, key or token.

## Consequences

- The owner resets the key's secret in Webull when it moves to the host, and removes the old values from the shared
  cloud environment ([docs/runbooks/webull-readonly.md](../runbooks/webull-readonly.md)). The cloud routine stops then.
- A new token needs the owner's approval in the Webull app. The job asks at most once every six hours and pages once.
  A token idle for 15 days lapses; the 2-minute session reads keep it in use.
- `wt-webull` is in group `wt` so it can run the checkout's Python. It can read what `wt` leaves group-readable (code
  and paper state) but not the shared secrets, which are `wt`-only and masked from its unit.
- Webull's open questions (a read-only key, options trading through the API, whether its event stream carries orders
  placed in the app) stay with Webull support; this record does not depend on the answers.
