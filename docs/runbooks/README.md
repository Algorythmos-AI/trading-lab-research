# Runbooks

One page per incident or task. Each starts with how you'll notice it. Every job runs on the GCP host
([gcp-host.md](gcp-host.md)); the Mac runs nothing. For a map of the whole system, start at
[docs/README.md](../README.md). A test checks that this index lists every runbook (`tests/unit/test_docs_truth.py`).

## Stop trading, positions and latches

| Incident | You'll see |
|---|---|
| [Kill switch and flatten](kill-and-flatten.md) | You want trading to stop now. Each desk has its own kill file ([safety.md](../operations/safety.md)) |
| [Not flat at the close](not-flat-at-close.md) | ntfy priority 5 "Paper B NOT FLAT at the close" or "Paper B is SHORT"; a red banner. The QQQ rule's pages: its job is retired (DEC-0069) |
| [Position and session alerts](position-alerts.md) | ntfy "adopted a position", "outside strategy B's mandate", "clock check failed", "close unknown", "exits only" |
| [Loss latch reset](latch-reset.md) | ntfy priority 5 "loss limit latched"; entries stay off |
| [Paper accounts](paper-accounts.md) | Which of the three paper accounts a key pair reaches, what each is for, and their history |

## Desks

| Incident | You'll see |
|---|---|
| [Gap Hunter live state](gap-hunter-live.md) | The Gap Hunter page is late or empty; the `gap-hunter-publish` job (DEC-0078, proposed) |
| [Options clone](options-clone.md) | ntfy "Options clone ...": entered, exited, latched, feed unfit, exit not filled, NOT FLAT, FLATTEN REQUIRED |
| [Options desk: paper positions](options-positions.md) | The Paper positions pane is absent or says it is old; setting up the second paper account |
| [Paper options page: the trade history](paper-options.md) | The Paper page has no history, says it is old, or a total looks wrong; how hand-placed trades are matched |
| [Options lab tape](lab-tape.md) | The lab's recorder: what it records, the probe, the owner's setup steps, a session's manifest, a stop, an upload that failed, the off switch |
| [Radar → Options shadow](options-select.md) | The 06:45 shadow selection (DEC-0070): what it writes, the owner's setup steps, a clean session, a replay, the off switch |
| [Radar skill edits](radar-skill-edits.md) | The owner's edits to the cloud Radar skill for the Options pipeline: options lists only, earnings rows in the hold, what admits a name |
| [The board's stock feed](board-feed.md) | The owner's board on SIP (DEC-0050, DEC-0064: IEX is paused), checking it |
| [Feed agreement, IEX against SIP](feed-agreement.md) | Paused by DEC-0064 (SIP only); kept for the record and for the way back |
| [Keys and feeds](keys-and-feeds.md) | The Alpaca plan changed or lapsed, a tool answers 401, or a new market-data request is being added |
| [News archive](news-archive.md) | You need past news items, an archive run printed FAILED, or Alpaca changed its news provider again (the private `trading-news-archive` repository) |
| [Engine identity check over logged sessions](engine-identity-sessions.md) | A release changes the engine label: run the last 10 logged sessions through the old and the new engine first |
| [EXP-0034's one read](exp0034-read.md) | EXP-0034 has 100 scored breaks in group a, or its close date has come |

## The host

| Incident | You'll see |
|---|---|
| [The GCP host](gcp-host.md) | Provisioning, secrets, resize or rebuild of `trading-lab-host` |
| [Rollback a deploy](rollback.md) | The next night's jobs fail after a deploy |
| [Rotate secrets](secret-rotation.md) | A secret may have leaked, or it's the scheduled rotation |
| [Dead-man's switches](dead-man-switches.md) | A healthchecks.io page, or setting the checks up |
| [Backups, anchors, lease](backups-and-lease.md) | "Evidence chain broken", a backup or anchor failed, or "no primary lease" |
| [Disk nearly full](disk-full.md) | ntfy priority 3 "refused to run: free disk"; the Operations page shows disk under the floor |
| [Webull, read only](webull-readonly.md) | Moving the Webull key to the host, or the Webull pull job paged |
| [Cloud routines](cloud-routines.md) | A feed is late, a routine replied in its thread, or you want to know what runs outside the host |

## The dashboard

| Incident | You'll see |
|---|---|
| [Dashboard late or stopped](dashboard-late.md) | ntfy "Dashboard late"; a grey or amber freshness pill |
| [Dashboard deploys and the watchdog drill](dashboard-deploy.md) | A dashboard deploy failed, or you want to prove paging works |
| [Dashboard screenshots](dashboard-screenshots.md) | The `dashboard-gate` check fails on a picture of the Options desk, or a change means to move something |

## The repository

| Incident | You'll see |
|---|---|
| [Public-repository guards](public-repo-guards.md) | CI fails at "No restricted or runtime paths"; ntfy "Weekly evidence not published" or "Repository is not private"; `make status` says `repo visibility: ...` |
| [Ruleset emergency](ruleset-emergency.md) | CI is down and a fix must land |

## Historical

| Page | Why it is kept |
|---|---|
| [The OCI trading host](oci-host.md) | ADR 0004: never provisioned, superseded by ADR 0010. The GCP host runs its helpers and units; its Terraform is a rebuild path |
