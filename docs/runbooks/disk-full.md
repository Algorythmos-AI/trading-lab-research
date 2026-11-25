# Disk nearly full

**Signal:** ntfy priority 3 "refused to run: free disk". The Operations page shows disk under the floor.

The trading jobs refuse to start below **3 GB** free on the volume that holds the checkout. The dashboard turns
amber below **15 GB**. Both numbers come from `src/wt/ops/thresholds.py` (`DISK_FLOOR_GB`, `DISK_TARGET_GB`), and
`src/wt/ops/preflight.py` makes the check. On the GCP host that volume is the 60 GB boot disk
([host.md](../operations/host.md)).

**Look first (on the host):**

```bash
df -h /home/wt/trading
sudo du -xh --max-depth=2 /home/wt/trading /var/log /tmp 2>/dev/null | sort -h | tail -20
journalctl --disk-usage
```

**Free space safely:**
- `sudo journalctl --vacuum-size=200M` trims the systemd journal.
- `sudo -u wt sh -c 'uv cache prune 2>/dev/null || ~/.local/bin/uv cache prune'` prunes uv's cache (the deploy finds
  `uv` on the `PATH` or in `~/.local/bin`, `src/wt/ops/deploy.py`).
- Deploy-stage worktrees live in `var/stage/<commit>/`. The deploy removes its own after each run. One left by a
  killed deploy can go with `sudo -u wt git -C /home/wt/trading worktree remove --force var/stage/<commit>` while no
  deploy runs.
- Never delete anything under `var/` apart from that, nor `data/live/`, `logs/` from today, or `.venv`. Those are
  the desks' state and evidence ([architecture.md](../architecture.md), "Runtime state").

Then check with `df -h /home/wt/trading` and `sudo -u wt make -C /home/wt/trading preflight`.

If the disk itself is too small, resizing it is an owner step ([gcp-host.md](gcp-host.md)).

## The Mac console checkout

The Mac runs no job, but its own disk can still fill. On the Mac, free space is read on `/System/Volumes/Data`,
not `/` (APFS misreports `/`). `uv cache prune`, `pnpm store prune` and `npm cache clean --force` are safe there.
