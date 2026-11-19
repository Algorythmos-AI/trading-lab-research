# Runbooks

One page per incident. Each starts with how you'll notice it.

| Incident | You'll see |
|---|---|
| [Not flat at the close](not-flat-at-close.md) | ntfy priority 5 "Paper B NOT FLAT at the close" or "Paper B is SHORT"; a red banner |
| [Position and session alerts](position-alerts.md) | ntfy "adopted a position", "outside strategy B's mandate", "clock check failed", "close unknown", "exits only" |
| [Kill switch and flatten](kill-and-flatten.md) | You want trading to stop now |
| [Loss latch reset](latch-reset.md) | ntfy priority 5 "loss limit latched"; entries stay off |
| [Rollback a deploy](rollback.md) | The next night's jobs fail after a deploy |
| [Rotate secrets](secret-rotation.md) | A secret may have leaked, or it's the scheduled rotation |
| [Dashboard deploys and the watchdog drill](dashboard-deploy.md) | A dashboard deploy failed, or you want to prove paging works |
| [Options desk: paper positions](options-positions.md) | The Paper positions pane is absent or says it is old; setting up the second paper account |
| [Options lab tape](lab-tape.md) | The lab's recorder: what it records, the probe, the owner's setup steps, a session's manifest, a stop, an upload that failed, the off switch |
| [Paper options page: the trade history](paper-options.md) | The Paper page has no history, says it is old, or a total looks wrong; how hand-placed trades are matched |
| [The OCI trading host](oci-host.md) | Provisioning, access, rebuild, or the OCI account is lost |
| [The GCP free-tier host](gcp-host.md) | Provisioning, secrets, or rebuild of the e2-micro host |
| [Webull, read only](webull-readonly.md) | Moving the Webull key to the host, or the Webull pull job paged |
| [Dead-man's switches](dead-man-switches.md) | A healthchecks.io page, or setting the checks up |
| [Backups, anchors, lease](backups-and-lease.md) | "Evidence chain broken", a backup or anchor failed, or "no primary lease" |
| [Dashboard late or stopped](dashboard-late.md) | ntfy "Dashboard late"; a grey or amber freshness pill |
| [Disk nearly full](disk-full.md) | ntfy priority 3 "refused to run: free disk"; the Operations page shows disk under the floor |
| [Ruleset emergency](ruleset-emergency.md) | CI is down and a fix must land |
| [Options clone](options-clone.md) | ntfy "Options clone ...": entered, exited, latched, feed unfit, exit not filled, NOT FLAT, FLATTEN REQUIRED |
| [Cloud routines](cloud-routines.md) | A feed is late, a routine replied in its thread, or you want to know what runs outside the host |
| [Feed agreement, IEX against SIP](feed-agreement.md) | You want to compare the board on the two stock feeds after a session, or read five sessions together |
| [Public-repository guards](public-repo-guards.md) | CI fails at "No restricted or runtime paths"; ntfy "Weekly evidence not published" or "Repository is not private"; `make status` says `repo visibility: ...` |
| [EXP-0034's one read](exp0034-read.md) | EXP-0034 has 100 scored breaks in group a, or its close date has come |
| [Engine identity check over logged sessions](engine-identity-sessions.md) | A release changes the engine label: run the last 10 logged sessions through the old and the new engine first |
| [Keys and feeds](keys-and-feeds.md) | The Alpaca plan changed or lapsed, a tool answers 401, or a new market-data request is being added |
