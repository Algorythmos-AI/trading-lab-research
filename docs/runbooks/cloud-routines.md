# Cloud routines

Ten scheduled Claude routines feed the dashboard, the release flow and the weekly report. They run in Claude's cloud, not on the host
and not from this repository's code (except where noted), so `systemctl` and the deploy gate know nothing about them.
Each posts into its own thread on claude.ai. Each replies only when something needs the owner; a normal run updates
its status line and stays quiet.

| Routine | Id | When | What it does | Writes |
|---|---|---|---|---|
| Options levels, after close | `trig_01EUa31y41kKS4WuJqBXJwWN` | 21:52 UTC, Mon–Fri | Pulls IBKR daily and hourly bars and the volatility snapshot for the ten names, builds the levels, picks the next session's four focus names, posts the focus card, then runs the shadow step | The options edition (`/api/ingest`, `trading-lab/options`) |
| Options focus, pre-open | `trig_01WyzH7k8xAUgj8RZsakUDW7` | 08:50 New York, Mon–Fri | Prices the focus names before the open and republishes the focus block; posts the pre-open card | The edition's focus block |
| Radar build | `trig_01PW2UvCBejb4UxCEB58PEVp` | 05:30 New York, Mon–Fri | Builds the pre-market radar edition and leaves it in the outbox; the run beacon (below) is its to send when a stage starts and ends | The radar outbox file; run beacons |
| Radar catch-up | `trig_015qsK3nrRQgscNZh6strL4F` | After the build, Mon–Fri (its times are not recorded here) | Stops at once when the day's edition is already stored; otherwise does the build's work | The radar outbox file, when the build left none |
| Radar edition | `trig_01B1TN3d4x7dZ3Wxad2LmYgb` | 11:12 UTC, Mon–Fri | Sends the newest radar outbox file; if the radar run is late it retries every 20 minutes until 13:45 UTC | The radar edition |
| Webull trades, live | `trig_01Et86JsFLYn7j7kbBt1dGUm` | :24 every hour 09:24–15:24 New York, Mon–Fri | Each run reads the owner's Webull AU history every 2 minutes for an hour (stops at 16:20) and publishes on change and at least every 30 minutes | The trade journal |
| Webull trades, after close | `trig_012wh4n2yJT7B4Agy12u7yoF` | 21:38 UTC, Mon–Fri | One full read after the close | The trade journal |
| Release PR | `trig_01Dbj8zTA2HTq2Uzf9ziRzdj` | 16:20 New York, Mon–Fri | Opens or refreshes the `integration` → `main` release PR and drives its CI; never merges | A pull request |
| Weekly supervisor report | `trig_01EpHRrfQphBMhwEDGykabZi` | Sat 13:30 UTC (Fri evening or Sat morning in New York) | Reads the week's scorecard and the decision records' status lines and replies in at most fifteen lines; runs with the repository only, no connectors | A reply in its thread |
| Trading Lab daily review | `trig_01PCvtUN2qxcty7rS9Kt5J3G` | 16:45 New York, Mon–Fri | Reviews the project's health after the close and replies with what is fine, what needs the owner and what to do next; reads GitHub, the repository and the site's logs; changes nothing (below) | Nothing |

All of them are read-only toward the brokers: none places, changes or cancels an order.

Two more routines, outside this list, publish the focus card ledger (`stocksdelta/ledger`) from the
`focus-card-ledger` repository: one saves the card before the open (about 09:11 New York) and one scores it after
the close (about 16:21 New York). Their ids and the zone of their schedules are not recorded here and have not been
checked; the feed watch shows them as assumed and never pages for them (below).

The selection funnel's health document (`stocksdelta/funnel`) comes from the private `trading-options-funnel`
repository, through a seal step the owner adds to the after-close Options routine (that repository's
`docs/routine-steps.md`). Until the first night arrives its feed row is shown, unverified, and never pages; it is due
by 22:30 UTC (`dashboard/src/lib/funnel-slots.ts`).

The Radar desk file (`stocksdelta/radar-desk`) comes from the same repository, built and sealed each morning after the
Radar's seal step (that repository's `options_funnel.desk`). Its sender is not yet added to a routine: until the first
morning arrives its feed row is shown, unverified, and never pages; it is due by 09:15 New York on each regular
session (`dashboard/src/lib/radar-desk-slots.ts`).

The Radar run beacon (`stocksdelta/radar-run`) is a small document the pre-market Radar routine itself sends, with
the radar key, when a stage of its run (`build`, `send`, `evidence`, `desk`) starts and again when it ends: the
session, the stage, its state, what started it, the times, an exit code and closed reason codes, and nothing of the
edition. The site keeps the newest beacon of each stage of each session (`radar-run/<session>/<stage>.json`). It is
display only: the Radar page's pipeline card draws it (below), it has no feed row, it never pages, and a beacon that
fails to send must never fail the routine. The routine reads `editions.radar_run.accepts` from `/api/health` before it sends.

The Radar page (`/radar`) leads with the pipeline of the session in view, read from one summary the dashboard's
10-minute cron writes (`ops/radar-pipeline.json`, `dashboard/src/lib/radar-pipeline-run.ts`): the levels and focus
pick the session day before (16:52 New York), the build (05:30), the edition stored (about 05:45; the store's own
receipt time of its first copy), the evidence kept and the desk file, the pre-open prices (08:50), the card saved
(09:11) and the open (09:30). A session with no run beacon says "no build record"; the page never fills one in. Its
badge is "On time" only for an edition stored by the feed watch's radar deadline (11:12 UTC plus 60 minutes), says
"Built by hand" whenever a person started the run, and "No session today" on a weekend or a market holiday.

Every radar edition that becomes latest is also kept, once and never replaced, under `radar/copies/<edition_date>/`
with the store's receipt time (`dashboard/src/lib/edition-copy.ts`; the 10-minute watchdog repairs a missing one).
`GET /api/research/radar-copies?date=YYYY-MM-DD`, signed with the radar key over
`GET /api/research/radar-copies?date=<date>`, lists them (path, receipt time, run, sha256 of the copy and of the
edition) and nothing of their content: trading-options-funnel seals that listing daily for DEC-0055. An edition
replaced before its copy was made leaves a create-only `.lost.json` marker there instead, listed as `lost`.

## What depends on what

- **The feed watch** (`dashboard/src/lib/feed-watch.ts`, its table `FEEDS`) holds every routine above that publishes
  a document, with the schedule and zone in this table: the options edition (21:52 UTC), the pre-open refresh
  (08:50 New York, due by 09:05), the journal (the hourly live runs and 21:38 UTC), the radar (11:12 UTC), the two
  ledger routines (assumed, display only), the funnel's health document (22:30 UTC, unverified, display only), the
  Radar desk file (09:15 New York, unverified, display only) and the
  desk's own shadow evaluator. It is the one source for the
  Operations page's "Your feeds", the Options page's health strip and the feed alerts (`/api/cron/watchdog`, pages
  only with `FEED_WATCH_ALERTS=on`). **A change of a routine's schedule or zone here must change its row there**, in
  the same pull request; a new routine that publishes is one more row (and, to show it, a chip or a card).
- **The journal's freshness**: the feed watch expects a read at or after each live run within 45 minutes (the
  routine publishes at least every 30 minutes) and the 21:38 UTC sync within an hour, and pages after two missed runs
  in a row. The evening rule (only a stamp at most 10 minutes before 21:38 UTC counts) assumes the after-close routine
  stamps its own read time and never fires over 10 minutes early; neither is recorded here, so that run is marked
  assumed and a missed evening sync is shown, not paged, until the owner confirms both (then drop `verified: false`
  from that schedule in `FEEDS`). The day check (`trade-rules.ts`, `journalCurrent`, inside the shadow evaluator's engine) is stricter and
  says "Journal not current" when a read is missing; it still reads `feeds.ts`'s `journalCheck`, unchanged.
- **The options desk and the clone** read the edition and its focus block. The pre-open routine replaces only the
  focus block.
- **The IBKR paper login** is shared by the options routines and the HFT desk's runner. Two sessions on one login end
  each other ("competing live session"); this is why the HFT desk is parked (HFT-DEC-0005).
- **GitHub access.** The release-PR routine and the options routine's shadow step read this repository. Since the
  repository is private (2026-10-24), they need the routines' GitHub connection to cover it. The first night after
  the flip is the check: the shadow step's reply names the step that was blocked.
- **The shadow step** is temporary: it compares the repository's edition builder with the routine's own. Five
  consecutive clean nights in format 2 are the condition for switching the build to the repository
  (`scripts/options_edition.py --pulls --send --focus`, plan step B4, its own decision record).

## Checking a routine

- On claude.ai: the routine's page shows its schedule, its last run and the thread.
- From a Claude session: `RemoteTrigger` `get` (schedule, `enabled`, `next_run_at`, last run) and `get_run_log` on
  the run's session id. A fire that was skipped before a session existed leaves no run; `get` still shows it.
- On the dashboard: Operations, "Your feeds", says whether each feed arrived on schedule; the Options page's strip
  says the same for the feeds the morning trades from. Both use the exchange calendar, so a holiday is not late.

## The weekly supervisor report (plan step D2, created 2026-10-25)

Fifteen plain lines every Saturday at 13:30 UTC, after `wt-weekly` (Friday 20:00 New York) and its evidence pull
request, from the same records the Research page's "The programme" panel reads. It runs with the repository and no
connectors: a scheduled task acts without pausing for approval, so it carries nothing it does not need (no broker,
no mail). Its prompt:

> Weekly supervisor report for the trading lab (Algorythmos-AI/trading-lab-research). Read-only: never place,
> change or cancel an order, never merge, never push. Read the newest weekly scorecard in
> `research/forward/archive/` on `integration`, or in the open `evidence/*` pull request if it has not merged yet,
> and the decision records' status lines in `research/decisions/`. Reply in this thread with at most fifteen short
> lines, counts, ids, dates and R only: what strategy B and the options clone traded this week; G2a (clean
> sessions, incident-free streak, agreement at the bar) and G2b (trades) against their lines; where B's stop rule
> (DEC-0037) stands and whether it fired; any decision record still PROPOSED and how long it has waited; any open
> pull request into `main`; and what is blocked on the owner. Never quote a decision's prose, a setup name, a
> headline, an account balance or a P&L in dollars. If the scorecard for this week is missing, say so in one line
> and stop.

## The daily review (created 2026-11-13)

A short, read-only pass over the whole project every weekday at 16:45 New York, 45 minutes after the close (its
schedule is written in New York time, so it follows the clock changes). It answers one question for the owner each
day: is the project healthy, and what needs me?

**Why it exists.** On 2026-11-12 the lab released five times and moved the board to SIP. Three things were found
only because someone looked: the host had skipped two releases because they changed units; the status collector had
been failing since 2026-10-24; and no board-feed stamp was being written on the first SIP session. The weekly
report reads the scorecard, not the plumbing, and nothing looked across branches, releases, production and the
records each day. This routine does.

**What it checks, and why each one.**

| Check | How | Why |
|---|---|---|
| `main` and `integration`: CI, dashboard and security runs, failures in the last 24 hours | git and the GitHub API | A red branch blocks every release, and `integration` deploys staging |
| Open pull requests: age, checks, anything over a day old, any open release PR | GitHub API | The owner merges; a PR left open is work that is not live |
| Production: the deployed commit against `main`; counts of `board-feed.stamp` and `desk-eval` outcomes and of error lines by route | GitHub deployments; the site's logs through the Vercel connector | A release that did not deploy, or a job that refuses every run, is silent otherwise. It reports whether the stamp defect of 2026-11-12 (every run `late`) still happens |
| Release log: does the newest file under `docs/releases/` record what is on `main` | The repository | The log is the starting state for the next piece of work |
| Research records: every PROPOSED decision and how long it has waited; registry rows still proposed; a close or read date within 14 days | `research/decisions/`, `config/trial_registry.yaml`, `research/experiments/` | Records wait on the owner's merge, and a read date must not pass unnoticed |
| Host: the version it was last recorded on, and whether `main` has moved since | `docs/releases/` only | The host skips a release that changes units, helpers or the deploy (ADR 0008). This is from the record, never a live reading |
| Housekeeping: old merged branches (a count), scheduled workflows that keep failing | GitHub API | Small things that pile up |

**What it replies.** One line first: "All clear", "Needs a look" or "Needs you today", with the New York date. Then
three short lists: Fine, Needs you (most urgent first, each with its PR or record id), Recommended next (at most
three). Then "Not checked" for anything it could not verify. On a market holiday it says so and stops.

**What it must never do.** It commits, pushes, merges, comments, deploys and changes nothing; a fault goes in the
report. It reports counts, ids, dates, versions and statuses only (the data classes in `AGENTS.md`): no research
prose, log lines, account figures, holdings or symbols. It gives no opinion on a trade.

**What it cannot see.** It runs in the cloud, so it cannot sign in to the dashboard, read the Blob store or reach
the host. A live host reading still needs the owner's Mac
(`gcloud --configuration=algo-trading compute ssh trading-lab-host --zone us-east1-b --tunnel-through-iap`), and
[healthchecks.io](dead-man-switches.md) remains the alarm for a job that stops.

**How it is set up.**

- Model: the cheaper tier (`claude-sonnet-5-5`), for cost; it runs every weekday and spends the account's usage. Pause it from its page if the
  weekly limit is close.
- Tools: read and shell only (`Bash`, `Read`, `Glob`, `Grep`); no editing tools.
- Connectors: **Vercel only.** When a routine is created with no connector list, the server attaches every
  connector on the account; this one was created with 24, among them mail, a broker and the cloud console, and was
  cut back to Vercel the same minute. A routine acts without pausing for approval, so it carries nothing it does not
  need. Check the connector list after creating or copying any routine.
- Environment: the same cloud environment the focus card ledger's routines use.
- It is managed at `https://claude.ai/code/routines/trig_01PCvtUN2qxcty7rS9Kt5J3G`. A routine cannot be deleted
  through the API, only there.

**Changing it.** Edit the routine's prompt, then mirror the change here in the same pull request, so this page stays
what the routine does. Add a check when a failure was found only by hand: say in the table what it reads and why.
If the report grows past what the owner reads in a minute, cut it; a review nobody reads checks nothing.

Its prompt, as created:

> Trading Lab daily review (the owner set this up on 2026-11-13). You act as the lab's reviewing CTO for one short
> pass after the US close. The repository is Algorythmos-AI/trading-lab-research (public). The owner trades options
> by hand from the dashboard; this review tells him each weekday whether the project is healthy and what needs him.
>
> HARD RULES
> - Read-only. Do not commit, push, open or merge a pull request, comment on anything, change a setting, start a
>   deploy or run a workflow. If something needs fixing, say so in the report; never fix it.
> - Keep it lean: no subagents, no workflows, no long file reads. Aim to finish in a few minutes.
> - Read AGENTS.md first for the rules and the data classes. Report only counts, ids, dates, versions and statuses.
>   Never quote research prose, log lines, account figures, holdings or symbols.
> - Read the state of the code from origin/main and origin/integration, never from a stale checkout. If a tool you
>   need is missing, say which check you could not do; never guess a result.
> - If today is a US market holiday or a weekend in New York (dashboard/src/lib/market-calendar.json), say so in
>   one line and stop.
>
> WHAT TO CHECK (use git, and gh or the GitHub API for the rest)
> 1. Branches: the head of main and of integration, how many commits integration is ahead of main, and the result
>    of the latest CI, dashboard and security workflow runs on each. Any failed run in the last 24 hours, with its
>    name and when.
> 2. Pull requests: every open one with its number, base branch, age in hours and check state. Flag any open more
>    than 24 hours, any with failing required checks, and any open release PR into main.
> 3. Production: the commit of the latest successful production deployment (GitHub deployments for the repository)
>    against the head of main. Say whether they match. If a Vercel logs tool is available, count in the last 24
>    hours of production logs the outcomes of the events board-feed.stamp and desk-eval, and any error-level lines
>    by route; report counts only. A board-feed.stamp count that is all "late" is a known defect from 2026-11-12:
>    say whether it is still happening.
> 4. Release log: the newest file under docs/releases/ on integration. Say whether it records the commit now on
>    main; if main has moved past it, say a record is owed.
> 5. Research records: under research/decisions/, every record whose Status line says PROPOSED, with its id and how
>    many days it has waited. From config/trial_registry.yaml, any row still marked proposed. Any experiment under
>    research/experiments/ whose README or config names a close or read date within the next 14 days.
> 6. Host: you cannot reach the host. From docs/releases/ and the repository only, say which version the host was
>    last recorded on and whether main has moved since, so the owner knows a deploy may be waiting. Say plainly that
>    this is from the record, not a live reading.
> 7. Housekeeping: branches on the remote that are merged and more than 7 days old (count only), and any workflow
>    that has been failing on its schedule.
>
> THE REPORT (your final message, plain English, short)
> - First line: one of "All clear", "Needs a look" or "Needs you today", with the date in New York.
> - Then three short lists: "Fine" (one line per area that is healthy), "Needs you" (decisions or merges only the
>   owner can make, most urgent first, each with the PR or record id), "Recommended next" (at most three items,
>   each one line).
> - Then "Not checked" for anything you could not verify and why.
> - No praise, no filler, no advice on trades or on what to buy or sell. If nothing needs the owner, say so in one
>   line.
