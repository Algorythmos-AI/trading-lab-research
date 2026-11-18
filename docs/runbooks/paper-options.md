# Paper options page: the trade history (DEC-0057)

The dashboard's **Paper** page (`/paper`) shows every closed paper option trade from three sources, each apart
and never added together: the options clone, the option trades the owner places by hand in the manual paper
account, and the research arms' simulated trades. This note covers the document that feeds its history.

| Part | Where | What it does |
|---|---|---|
| `wt-options-live.timer` | the VM | every 5 minutes in the US session, every 15 otherwise. No unit of its own |
| `wt.options.live` | the job | after it has sent the positions, it reads the manual account's activities and calls the history |
| `wt.options.paper_manual` | the job | keeps the activities read so far and matches fills into round trips, first in, first out |
| `wt.options.paper_site` | the job | builds the document from the host's own files, checks it and sends it |
| `stocksdelta/paper-options` v1 | the dashboard | stored latest-only (`paper-options/latest.json`); each document carries the whole history |

Today's clone session and the open positions on the same page come from two other documents
(`stocksdelta/options-clone`, see `options-clone.md`; `stocksdelta/options-live`, see `options-positions.md`).
They show whether or not the history has been sent.

## What it reads

| Block | From | Notes |
|---|---|---|
| `clone` | `data/live/options_journal.jsonl` (`trade_closed`, the last row of a trade id) and `var/options/plans/plan_*.json` | A trade counts as the nightly review counts it: closed, with both fills and a result. An unsettled trade is sent and listed on the page, in no total |
| `arms` | `var/options/shadow/<date>.jsonl`, closed virtual trades | Grouped by hypothesis id. Simulated fills, never orders |
| `manual` | the manual paper account: filled orders, option expiries, exercises and assignments | One GET path, `/v2/account/activities`, on the paper host. Kept in `var/options-live/activities.json` |

It is read only. Nothing here places, changes or cancels an order, and the clone's runner is not touched.

What is sent: trade ids, contract symbols, times, prices, results, hypothesis ids and codes. Never a setup's
name, the account number, a balance, an order id or a note. A virtual trade's id and a hand-placed trade's id are
hashes. The job's log line carries counts only.

## How the hand-placed trades are matched

- A buy closes what was sold first, oldest first, then opens a long lot with what is left. A sell does the
  reverse. One round trip filled in pieces is several rows.
- An expiry closes what is open in its contract at zero.
- An exercise or an assignment books no result. The page says how many positions left that way.
- A symbol that is not a standard option contract is left out.
- When the clone has no keys of its own (`APCA_CLONE_*` unset) it trades in this same account. Fills on a contract
  the clone traded that New York day are then left out, and the page says how many. A hand trade on that very
  contract on the same day is left out with them.

The first run reads two years back, at most 20 pages of 100 a run, and carries on at the next run. Later runs ask
only for what is newer than the cache, with a day's overlap.

## When it sends

Every run builds the document and writes it to `var/options/paper_site/document.json`. It is sent only when all of
these hold:

- it passes the dashboard's own schema (`dashboard/src/lib/paper-options.schema.json`);
- `/api/health` shows `editions.paper_options.accepts` at 1 or more (remembered for an hour);
- something in it changed since the last send, or 12 hours have passed;
- the host is the primary, or a shadow host with its own key id.

## Checking it (owner)

After a release that carries it, wait one timer tick, then in the checkout:

```
grep "paper options history" logs/options_live_$(date -u +%Y%m%d).log | tail -n 3
```

A good line ends `sent: True (HTTP 200)` or `unchanged, not sent`. `/api/health` should show
`editions.paper_options.status: "ok"` with a recent `as_of`.

To see what would be sent without sending: `.venv/bin/python -m wt.options.paper_site --dry-run`. That builds the
clone and arms blocks only; the hand-placed trades are added by the `options-live` job.

## When something is off

| What you see | Meaning | What to do |
|---|---|---|
| Page: "No paper trade history has been sent yet" | nothing stored yet | the log line above; the first send needs the dashboard release first |
| Page: "This history was last sent on ..." | the stored document is more than 26 hours old | the job's log and the alert `job:options-live`; an unchanged history is still re-sent every 12 hours |
| Log: `the dashboard does not take the document yet, not sent` | the dashboard is older than the host, or `/api/health` could not be read | deploy the dashboard; it is asked again on the next run |
| Log: `failed schema validation: ...` | the builder made something the contract refuses | a fault in the code: the path in the line says where. Nothing was sent, the last good document stays |
| Log: `sent: False (...)` | the dashboard refused or could not be reached | it retries on the next run. `HTTP 422` is a contract mismatch: check the Feeds page's refusal row "Paper options history" |
| Log: `the paper account's activities could not be read (...)` | Alpaca, the network or the keys | the history goes out without the hand-placed trades; it retries on the next run. `keys-rejected`: `sudo wt-set-secrets` |
| Page: "Your closed paper trades are not being sent yet" | no `APCA_OPTIONS_*` keys, or the activities have never been read | as `options-positions.md`, "Setting it up" |
| Page: "N rows could not be read and are left out" | a row lacks what a figure needs | compare the row in `var/options/paper_site/document.json` with the journal; the totals leave it out |
| Page: "... the clone's own document says ... out of step" | the page's clone total and the clone's own total differ over the same number of trades | compare `trade_closed` rows in the journal with the document; do not rely on either total until they agree |
| Page: "N older trades are left out" | more than 2,000 clone or hand-placed trades | expected past that count; the newest are kept |
| A hand-placed trade is missing | it is still open, it is a stock trade, or it is on a contract the clone traded that day in a shared account | expected; the last case goes away once the clone has its own keys |

A fault in the history never fails the `options-live` job and never delays the positions: they are sent first,
and the history runs in its own guard. Its own result is only in the log line.

## The first expiry, exercise or assignment

The shape of those records follows Alpaca's documentation and has not been seen from this account. After the
first one, look at it in `var/options-live/activities.json` and at the trade it produced on the page:

- an expiry should show as a trade closed at 0.00, "Left to expire", at 16:00 New York on its day;
- an exercise or assignment should show no trade, and the count in the section's note.

If the record is missing from the file, its type or fields differ from the documentation: the lot then stays
open and is in no total, which is safe, and the reader in `wt.options.paper_manual.clean` needs the fix.

## To reset or stop

- Re-read the manual account's whole history: delete `var/options-live/activities.json` (owner). The next runs
  read it again from two years back.
- Force a send: delete `var/options/paper_site/sent.json` (owner).
- There is no switch for the history alone. Stopping `wt-options-live.timer` stops it together with the
  positions (`options-positions.md`).
