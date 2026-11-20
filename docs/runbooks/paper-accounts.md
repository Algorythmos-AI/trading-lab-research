# Paper accounts

The owner has **three** Alpaca paper accounts, under one login (Alpaca allows three paper accounts per login). There
is no fourth, and there is no "QQQ account": QQQ and QQQM are tickers, not accounts. Accounts are named here as the
owner named them in Alpaca, with the last three characters of the account number only (this repo is public).

| Alpaca name | Account | Key pair | Used by now | Places orders |
|---|---|---|---|---|
| Robot B stocks (host) | …Y7I | `APCA_API_KEY_ID` / `APCA_API_SECRET_KEY` | the market-data jobs (routine, forward test, pipeline check, deploy gate), `options-live`'s market data (never its positions), research scripts, hand-run tools on the Mac | no job, since the QQQ rule was retired (DEC-0069) |
| Clone options (host) | …3VG | `APCA_CLONE_KEY_ID` / `APCA_CLONE_SECRET_KEY` | the options clone (`paper-o`) | yes: the clone's option orders |
| Gap Hunter | …JU0 | `APCA_S_KEY_ID` / `APCA_S_SECRET_KEY` | the stock desk, Gap Hunter (`paper-s`, `wt.live.runner_s`) | only once a rule is in `S.switched_on` (none is) |

Where each pair lives (checked 2026-11-20, read-only):

- Host (`/run/wt-secrets/env`): `APCA_API_*` (…Y7I) and `APCA_CLONE_*` (…3VG). `APCA_S_*` is not set yet: the owner
  adds it with `sudo wt-set-secrets` when a Gap Hunter rule is switched on. `APCA_OPTIONS_*` is not set.
- Mac (`~/trading/.env`): `APCA_API_*` (…Y7I) and `APCA_S_*` (…JU0).
- No two pairs share a key.

## History (so the records read right)

- **Until about 2026-11-17 the host used a fourth account**, "Manual options (mine)" (…ISF). Its key pair was on the
  host as both `APCA_API_*` and `APCA_OPTIONS_*`, so the QQQ rule (`paper-b`), the options clone and the owner's
  hand-placed option trades all shared it. Every order of the QQQ rule's paper book (the nine QQQM trades of
  2026-10-19 to 2026-11-11 in `data/live/journal.jsonl`) was placed there, not in …Y7I.
- About 2026-11-17 the pairs were split: `APCA_API_*` → …Y7I (then named "Paper Trading", renamed "Robot B stocks
  (host)"), `APCA_CLONE_*` → …3VG (then "Shadow GCP", never traded before; renamed "Clone options (host)").
- **2026-11-20:** the owner deleted …ISF to make room for Gap Hunter's account (…JU0, first named "Bounce Hunter
  (sleeve S)"). Its keys were removed from the host. The QQQ rule's orders and the hand-placed option trades went
  with it; the repo's journals and the forward ledger are the only record of them left.
- …Y7I has held one AAPL share since 2026-04-16, bought by hand. The owner sold it on 2026-11-20 (one share at
  350.50, filled 10:02 UTC). Checked afterwards: all three accounts have no position and no open order.

## Rules for agents

- **Never create, delete, rename or reset an account, and never generate or regenerate a key pair.** Those are the
  owner's, in Alpaca's own pages. A reset revokes the pair everywhere it is used (`keys-and-feeds.md`).
- Name an account by its Alpaca name and the last three characters, as in the table. Do not call any account the
  "QQQ account" or "Robot B's account" in new text: Robot B's QQQ rule is retired and never traded in …Y7I.
- Before a plan step depends on which account a pair reaches, check it read-only (below). Do not trust an older
  note, this one included.

## Checking which account a pair reaches (read-only)

On the host, as `wt`, with the env file loaded: for each pair, `GET https://paper-api.alpaca.markets/v2/account`
and print `account_number` and `status`, then `GET /v2/positions` and `GET /v2/orders?status=open` and print
counts. Print no key, no secret and no balance. `make keys-check` shows which pair a Python tool will use, without
any value.
