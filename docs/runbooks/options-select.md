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
`candidates.json`, `fetch.json`, `universe.json`, `stage1-bundle.json`, `stage1.json` and `run.json`, and then the
job's `check.json` (written after the folder, not one of the run's hashed files). The module
docstring of `src/wt/options/radar_select.py` says what each holds.

It never writes the Radar's prose. The job log is `logs/options_select_<YYYYMMDD>.log`; its last line gives the
Radar status, counts and picks. Logs stay on the host: no alert carries a symbol.

## The owner's setup (once, after the release that carries this job)

1. Deploy the release (`wt-deploy deploy`). It changes units, so the hourly automatic deploy holds it (ADR 0008).
2. Run `sudo wt-install-units`. Then `systemctl list-timers 'wt-options-select*'` shows the timer at weekdays 06:45.
3. On healthchecks.io, create the check `wt-options-select` (cron `0 6 * * 1-5`, America/New_York, grace 3 h;
   `dead-man-switches.md`). A check made before its first ping stays "new" and does not page.

## Checks after a session (read only)

The job checks its own run and writes `var/options-select/<S>/check.json` (DEC-0070 section 11). Three ways to read it:

- **The Radar page:** the "Shadow selection" box shows "Shadow progress: N of 5 clean", one square per recent session
  (green clean, red not clean, dashed not checked; hover for the reasons), and the session's check: clean or the
  reasons, the replay, the gate facts' coverage, and how many of the shadow's picks are in the published four.
- **The phone:** a session that is not clean pages once, "Options shadow: session not clean", with the date and codes.
- **A terminal on the host:**
  - `.venv/bin/python -m wt.options.select_status progress` prints the count and one line a session;
  - `.venv/bin/python -m wt.options.radar_select check --session <S>` prints a session's kept check, or checks it
    when it has none (exit 0 clean, 6 not clean, 1 no run). `--again` rewrites it; after a config or code change
    the replay of an old run differs, so it would then read not clean;
  - `.venv/bin/python -m wt.options.radar_select replay --session <S>` prints `reproduces` or what differs;
  - `systemctl status wt-options-select.service` shows exit 0.

A **clean session** (DEC-0070 section 11) has all of these:

- the run folder exists (the job exited 0) and `run.json` is not `late`;
- `radar_status` is `ok` and the edition gave at least one name new to the desk;
- those names' bars were fetched;
- every gate verdict carries its facts (`universe.json` version 2);
- the replay reproduces.

| Code | Meaning | Do |
|---|---|---|
| `radar_not_ok` | the edition was missing, stale or invalid by 07:45; the run used the 12 | Check the Radar's build and catch-up routines |
| `no_radar_candidates` | the edition held no in-scope name new to the desk | Check the edition's lists (a renamed list is out of scope) |
| `late` | the run finished after 08:40 New York | Check the job's log for slow reads or fetches |
| `radar_bars_failed` | the candidates' bars could not be fetched | Check the broker's data status; the desk's 12 still ran |
| `facts_missing` | a verdict has no gate facts | A code regression in `universe.py`: open an issue before the next run |
| `replay_differs` | the saved run does not reproduce | Run `replay --session <S>` for the list; the code or config changed, or a file was edited |
| `replay_error` | the replay could not run | Run `replay --session <S>`; a file is missing or unreadable |

It is an operational gate, not evidence of skill. The overlap count with the published four is a record only: no
outcome of either list is read.

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
