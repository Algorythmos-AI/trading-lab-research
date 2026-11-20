# Options lab tape (DEC-0060)

The lab records the option and stock quotes of each session's focus names, so that what an option really cost to buy
and sell can be measured later (EXP-0041). Alpaca keeps no history of option bid and ask: a session that is not
recorded is lost. The recorder sends no order, reads no account and imports no trading code.

The tape is PRIVATE: it never goes into the repository, the dashboard or a log. Only counts and coverage leave the host.

## When it runs (New York)

| When | What |
|---|---|
| 09:15 | The job `lab-tape` starts and waits |
| 09:25 | It reads the focus list once. No list for today: it records nothing, writes why in the session's manifest, and ends |
| 09:30 to the close (13:00 on a half day) | Every 5 s: the contracts the owner could buy (tier 1) and the stocks. Every 60 s: the chains and the rest of the near-term chain (tier 2) |
| The close to +90 min | The day's option prints for tier 1 and the open interest |
| By +110 min | The manifest, then the upload to the lab's bucket and pruning of old local copies |
| Saturday 11:00 | `lab-archive-check` reads back every archived session's manifest and twelve parts drawn with the date as seed, and fails if anything differs or if finished sessions exist with none archived |

## Where things are on the host

| What | Where |
|---|---|
| The tape, one folder per session | `/home/wt/lab-tape/<date>/` (`WT_LAB_TAPE` moves it; never inside the checkout) |
| What a session holds and how complete it is | `manifest.json` in its folder: names, focus answer's sha256, opening tier-1 set, coverage, rows, gaps, why it stopped |
| A session still running, or stopped and waiting to resume | `state.json` and `focus.json` in its folder, and no `manifest.json` |
| Upload receipt | `upload.json` in the folder: present only when every object is in the bucket |
| The off switch | `var/lab/OFF` in the checkout: the recorder stops at its next check (within 5 s) and writes why |
| Log | `logs/lab_tape_<YYYYMMDD>.log` |
| The probe's result | `var/lab/probe.json` (counts only) |

## Setting it up (owner, once)

1. **Run the probe** once on the host, after the US close, with the focus list for the next session published:

   ```bash
   sudo -u wt bash -c 'cd /home/wt/trading && set -a && . /run/wt-secrets/env && set +a && PYTHONPATH=src .venv/bin/python -m wt.lab.probe'
   ```

   It prints its pass marks: the request limit (at least 1,000 a minute), a tier-1 sweep within 5 s, free disk of at
   least 19 GB, and that every focus name was measured. Write the result as a dated line in EXP-0041's `README.md`. A
   miss narrows tier 1 in the order EXP-0041's `config.yaml` gives, by a dated line, before any session.
2. **Create the bucket** `wt-lab-tape` in Cloudflare R2 (no retention lock until Alpaca answers about storage) and a
   token that can read and write that bucket only.
3. **Set the secrets**: `sudo wt-set-secrets`. New fields: `R2_LAB_ACCESS_KEY_ID`, `R2_LAB_SECRET_ACCESS_KEY` (the
   bucket token; the backup's own R2 token is never used), `WT_LAB_KEY_PREFIX` (the key pair the probe names as
   `pair_used`; default `APCA_CLONE`) and `WT_LAB_RATE_LIMIT` (the probe's measured limit; the recorder uses 40% of it).
4. **Install the units** after the release that carries the job: `sudo wt-install-units`. Then
   `systemctl list-timers 'wt-lab-*'` shows `wt-lab-tape.timer` (weekdays 09:15) and `wt-lab-archive-check.timer`.
5. **Accept DEC-0060** by its status-line pull request. Until that change reaches the host, the job starts each
   weekday, sees the record still PROPOSED, logs "DEC-0060 is not accepted yet; nothing recorded" and ends: the
   units can be installed safely before the probe and the bucket exist.

## Checking a session

```bash
sudo -u wt cat /home/wt/lab-tape/$(TZ=America/New_York date +%F)/manifest.json | python3 -m json.tool | head -60
```

Look at:
- `recorded`;
- `coverage` and `coverage_fresh`: a sample counts as fresh only while its name's newest tier-1 quote is at most 30 s
  old, so the two differ when Alpaca served old option quotes (on 2026-11-19, the previous day's for three names
  until about 10:30);
- `stale_ticks`, `stale_ticks_by_name`, `first_fresh_tick_by_name` (tick 0 is 09:30, one tick is 5 s) and
  `longest_stale_s`;
- `ticks_down`: ticks nobody ran, from a late start, a crash or a stop;
- `opening_complete`;
- `stopped`: empty on a normal day;
- `restarts`, `rows` and `after_close` (with `open_interest.missing` and `.dates`);
- `tier1_refused_by_cap`;
- `code`: the commit that recorded it.

DEC-0067, once accepted, says which of these make a session count. `receipts/<date>.json` in the tape root means the
bucket holds the whole session; it is kept after the local copy is pruned.

The `sample` stream says what every request asked for and got back, and the `member` stream says when each contract
joined a tier. Research reads a session only through `wt.lab.read`, which refuses a changed or unfinished session and
never hands back a quote the recorder did not sample at that time.

## What to do when

| You see | Do |
|---|---|
| `stopped: "off switch"` | Someone created `var/lab/OFF`. Remove it to record the next session |
| `stopped: "free disk under 17 GB"` | Free disk: see `disk-full.md`. The paper runners refuse only under 3 GB, so they were never at risk |
| `stopped: "memory limit"` or `"N errors in a row"` | Read the day's log; the session is kept and the next one starts fresh |
| A folder with `state.json` and no manifest after the close | The job was stopped and did not restart. `sudo systemctl start wt-lab-tape` the same day writes the manifest with what it has. If you leave it, the next weekday's run closes it as `never finished` and archives it |
| `stopped` empty but `stale_ticks` high, or a `feed` gap row "<name> stale: ..." | Alpaca's option snapshots for that name were old or stopped moving while the recorder ran. Nothing to fix on the host; the session may not count |
| `after_close.error` set | The pull failed (the manifest is still written). A restart the same day redoes it whole; otherwise the day keeps its stock and option tape without prints |
| `upload.json` missing a day later | The next session's run uploads it. If it keeps failing, check the bucket token: `python -m wt.lab.archive upload` prints why |
| The weekly check reports a bad object | An archived part differs from its receipt: keep the local copy if it is still there and investigate before anything is deleted |
| A recording must stop now | Prefer `sudo -u wt touch /home/wt/trading/var/lab/OFF`: it stops within 5 s, writes the manifest and exits cleanly. `sudo systemctl stop wt-lab-tape` also works but pages "stopped by the system" and leaves the session to resume on the next start. Neither touches the paper runners |
| A deploy refused with "still running: lab-tape" | The recorder holds its job lock until its upload ends (by close + 110 min, inside the gate's blackout). A refusal after 18:00 means it overran: read its log; the hourly deploy tries again |

## Safety, in one place

- Its own unit with `CPUQuota=70%`, `Nice=10`, `CPUWeight=20`, `IOWeight=20`, `MemoryMax=1G`, `OOMScoreAdjust=500`: under
  pressure it yields and is the first thing killed; the paper runners keep `-500`.
- Requests stay under 40% of the measured limit and back off for a minute when Alpaca reports less than 30% left.
- It stops itself under 17 GB free disk, over 700 MB memory, on the off switch, or after 20 bad ticks in a row.
- A failure pages as the job `lab-tape`; it never sets `KILL` and never stops a trading job. After a crash systemd
  restarts it (60 s later, at most two restarts in 6 hours, as the timer's own start counts too); it resumes from its
  state. "No keys" (exit 2) is never restarted.
- The job belongs to the options desk: if that desk is ever marked as moved, the job records nothing.
