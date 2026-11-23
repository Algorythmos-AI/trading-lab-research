# Radar → Options shadow (`options-select`)

DEC-0070 (PROPOSED). Each weekday at 06:45 New York, the host reads S's stored Radar edition and turns it into
candidates. It gates them into the universe and scores that universe with the frozen Stage 1 rules
(`wt.options.select`, DEC-0046, unchanged).

It is a **shadow**: it writes records and publishes nothing. The four names on the Options page are still the cloud
routine's. It places no order and reads no account. Until every gate threshold in `config/options_universe.yaml` is
set by a dated amendment, every Radar name is rejected `gate_unset` and the universe is the desk's 12.

## When

| Time (New York) | What |
|---|---|
| 06:45 | The timer starts `wt-options-select`. A day with no session exits 0 and writes nothing. |
| 06:45 to 07:45 | The job reads the Radar edition every 5 minutes while it is missing, stale (not S's, or stamped before D's close) or invalid. It runs on the first fresh one, or at 07:45 on the last one read. |
| by about 07:55 | Stage 1 runs once, and the job writes `var/options-select/<S>/`. |
| 08:35 | Deadline kill. A run that finishes after 08:40 is marked `late`. |

## What it writes

One folder per session, built whole and renamed into place, so it exists only when complete. It holds
`candidates.json`, `fetch.json`, `universe.json`, `stage1-bundle.json`, `stage1.json` and `run.json`. The module
docstring of `src/wt/options/radar_select.py` says what each holds.

It never writes the Radar's prose. The job log is `logs/options_select_<YYYYMMDD>.log`; its last line gives the
Radar status, counts and picks. Logs stay on the host: no alert carries a symbol.

## The owner's setup (once, after the release that carries this job)

1. Deploy the release (`wt-deploy deploy`). It changes units, so the hourly automatic deploy holds it (ADR 0008).
2. Run `sudo wt-install-units`. Then `systemctl list-timers 'wt-options-select*'` shows the timer at weekdays 06:45.
3. On healthchecks.io, create the check `wt-options-select` (cron `0 6 * * 1-5`, America/New_York, grace 3 h;
   `dead-man-switches.md`). A check made before its first ping stays "new" and does not page.

## Checks after a session (read only)

- `systemctl status wt-options-select.service` shows exit 0.
- `jq '{radar_status, late, gate_unset, counts: .counts.universe}' var/options-select/<S>/run.json`
- `.venv/bin/python -m wt.options.radar_select replay --session <S>` prints `reproduces`.

A **clean session** for DEC-0046 section 7's five has all four of these:

- the job exited 0;
- `run.json` exists and is not `late`;
- the replay reproduces;
- `radar_status` is recorded.

It is an operational gate, not evidence of skill. A session on the 12 alone (the Radar missing or stale) is still
clean, and says so.

## Setting the gate's thresholds (DEC-0070 section 3)

Each run records every candidate's gate facts in `universe.json` (version 2), whether the thresholds are set or not:
- the edition's avoid and risk flags;
- Stage 1's validity;
- D's close and the median dollar volume;
- the chain facts;
- whether the next report is known, and whether a report falls in the hold.

After the shadow sessions, the counts for the dated amendment come from:

```
.venv/bin/python scripts/options_universe_frequencies.py
```
```
.venv/bin/python scripts/options_universe_frequencies.py --price-min 10 --dollar-volume-min 5e7 --ntm-strikes-min 6 --volume-min 1000 --spread-max-pct 0.15
```

The first prints how many candidate-sessions each threshold value keeps on its own. The second prints, for one full
set of values, how many names each session would admit before the cap. Choose the values from those counts only,
never from how any name did afterwards. The output holds counts only, no symbols.

## When something goes wrong

| Seen | Meaning | Do |
|---|---|---|
| `radar stale after 13 reads` | S's edition never arrived by 07:45 | Check the Radar's build and catch-up routines; the run used the 12 |
| `radar missing ... (TimeoutError)` | the site's edition endpoint did not answer | Check the site and the host's signing key; the run used the 12 |
| `fetch: ...`, exit 1 | the desk's bars could not be fetched; nothing was written | Run it by hand before 08:40: `.venv/bin/python -m wt.options.radar_select run --session <S>` |
| `already run; nothing written` | a second start for S | Nothing: the first run's folder stands |
| `removed .<S>.tmp-<pid>` | a run killed before its rename left a temporary folder | Nothing: it was swept |

## The off switch

While `var/options-select/OFF` exists, the job runs nothing and writes nothing (exit 0). Remove the file to resume.
A session it skipped has no shadow record and does not count.
