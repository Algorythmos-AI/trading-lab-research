# DEC-0078: the Gap Hunter page shows what the robot is doing, symbols included, and is fed every minute in session

- **Status:** PROPOSED on 2026-11-25. It takes effect once the owner merges it into `integration` and a release
  carries it to `main`; the 1-minute publish also needs the owner's `sudo wt-install-units` after that deploy.
- **Owner's decisions (2026-11-24, in the session that wrote this record):** the Gap Hunter page shows the symbols it
  picked and the open position; and the host publishes Gap Hunter's state every minute in session, not every 5.
- **Kind:** what the dashboard publishes, and how often. It changes no trading rule, no order, no gate and no frozen
  config. HYP-0071, HYP-0072 and every DEC before this one are unchanged.
- **Desks:** Gap Hunter (`wt.live.runner_s`) and the dashboard's stocks snapshot. No other desk's block changes.

## What changes

### What the `gap_hunter` block may carry

Until now the block carried counts, dates and R only, "never a symbol" (the publisher's own rule, stricter than the
repository's data classes). From this record it also carries:

- **The day's pick:** the primary's symbol and rank, the tier-2 symbols in rank order, and the selection's `why` code
  when there is no pick.
- **The live position:** symbol, rule code (`e1` to `e4`), shares, shares already sold at the first target, entry
  price, the stop now and at entry, the first target, the plan's state, and when it filled.
- **Each rule's state this minute:** the `why` code of each of `e1` to `e4` from the newest `gap_rules` row.
- **The day's timeline:** the session's journal rows of a closed set of events, each as its time, event name, and
  the rule code or reason code it carries. Never a row's free-text fields (`detail`, `error`).
- **Closed trades:** day, symbol, rule code, exit reason code, paper R, and the cost-haircut R of DEC-0074 (H1 and
  H2). The last 30.
- **Safety:** the execution-stop codes that latched (DEC-0073), the stop rule's progress (DEC-0066: trades counted,
  their sum of R, its limits), and the heartbeat (the newest journal row's time and today's arming time).
- **The rotation shadow (DEC-0076):** counts only, as before switch-on: names watched and changes. Never a shadow
  attempt's outcome.

Symbols and prices are PRIVATE in AGENTS.md's terms ("account balances ... owner notes"), not RESTRICTED: the
dashboard already shows them behind the owner's login on the Paper and Trades pages. Setup names, headlines and
decision prose stay out: rules are named by code only, and the server's denylist is unchanged.

### How often

A new host job, `gap-hunter-publish`, sends only the `gap_hunter` block every minute from 08:30 New York to the close
plus 15 minutes, on session days. The full snapshot keeps its own 5-minute schedule. The page's freshness reads the
block's own `as_of`. This is a unit change, so the owner installs it.

## The risk it takes

- **More PRIVATE data behind the login.** A symbol and a price now leave the host for the dashboard. The same is
  already true for the Paper and Trades pages, under the same login and key.
- **A wrong page.** The page shows the robot's own journal and plan files, not the broker. A plan file the robot
  failed to save shows the last saved state. The heartbeat makes that visible.
- **Twelve times the publishes of this block in session.** The block is small; the ingest's size cap and signature
  rules apply to it unchanged.

## Tests

`tests/unit/test_publish_gap_hunter.py` builds the block from fixture journals and plan files, checks it against the
published contract, and checks that no free-text field, setup name or shadow outcome can reach it.
