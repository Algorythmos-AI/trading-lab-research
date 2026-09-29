# Runbooks

One page per incident. Each starts with how you'll notice it.

| Incident | You'll see |
|---|---|
| [Not flat at the close](not-flat-at-close.md) | ntfy priority 5 "Paper B NOT FLAT at the close"; a red banner |
| [Kill switch and flatten](kill-and-flatten.md) | You want trading to stop now |
| [Loss latch reset](latch-reset.md) | ntfy priority 5 "loss limit latched"; entries stay off |
| [Rollback a deploy](rollback.md) | The next night's jobs fail after a deploy |
| [Rotate secrets](secret-rotation.md) | A secret may have leaked, or it's the scheduled rotation |
| [Dashboard late or stopped](dashboard-late.md) | ntfy "Dashboard late"; a grey or amber freshness pill |
| [Disk nearly full](disk-full.md) | ntfy priority 3 "refused to run: free disk"; the Operations page shows disk under the floor |
| [Ruleset emergency](ruleset-emergency.md) | CI is down and a fix must land |
