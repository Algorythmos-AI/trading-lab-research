# Gap Hunter live state (DEC-0078)

Gap Hunter's page shows what the robot is doing within a minute. The stocks snapshot already carries its
`gap_hunter` block every 5 minutes; this job sends the same block on its own, more often.

| What | Where | When |
|---|---|---|
| `wt-gap-hunter-publish.timer` → `python -m wt.ops.gap_live` | the VM | every minute 08:30 to 16:15 New York on weekdays, and every 15 minutes at any hour |
| `stocksdelta/gap-hunter-live` v1 | the site, `gap-hunter-live/latest.json` | latest only |
| outbox | `var/gap_hunter_live/document.json` | each run |

- **When it sends.** On a minute only from 08:30 New York to the day's close plus 15 minutes, by the market calendar
  (13:15 on a half day). Outside that it sends on the 15-minute rhythm only. The day's session is read once a day and
  kept in `var/gap_hunter_live/session.json`; a calendar that cannot be read falls back to weekdays and is asked again
  next run.
- **What it sends.** `wt.ops.publish.gap_hunter_view()`, cleaned by the snapshot's own allow-list and leak check.
  Symbols and prices are PRIVATE and stay behind the login. No setup name, no headline, no journal free text.
- **Before the site knows it.** The job reads `/api/health` (`editions.gap_hunter_live.accepts`) and sends nothing
  until the site takes version 1, so a host deployed before the site is quiet, not refused.
- **Failures.** One failed send is logged and the run ends 0. Three in a row fail the job, which pages once
  ("gap-hunter-publish failed") and recovers on the next send that works. The counter is
  `var/gap_hunter_live/failures.json`.
- **Install.** It is a new unit: after the release that carries it is deployed, the owner runs
  `sudo wt-install-units`. Until then nothing sends it and the page keeps reading the snapshot's block.
- **Check it.** `python -m wt.ops.gap_live --dry-run` builds and validates the document and writes the outbox,
  sending nothing.

## Expired entries: did the tape reach them?

Each Gap Hunter entry is a buy stop-limit that the desk cancels at its expiry. `scripts/gap_expiry_audit.py` reads the
journal's expired, unfilled entries and the consolidated tape's trades in each order's own window (placed to
cancelled), and counts each one as `not_reached` (no trade at the trigger: the rule's ordinary miss), `over_limit`
(the tape jumped over the limit) or `in_band` (a trade inside trigger..limit came while it rested, and it did not
fill). A line is a date and counts only: no symbol, no price, nothing after the order's window. It exits 1 when any
order is `in_band`; then look at that order's broker record and journal rows. It places nothing.

```
sudo -u wt bash -c 'cd /home/wt/trading && set -a && . /run/wt-secrets/env && set +a && PYTHONPATH=src .venv/bin/python scripts/gap_expiry_audit.py 2026-11-27'
```

A second date gives a range. On 2026-11-27 both entries were `not_reached`: the trigger was one cent over the opening
minute's high, and nothing traded there after the orders were placed.
