# EXP-0052: execution measured on the lab's option tape, recorder v2

- Decision: DEC-0067 (PROPOSED). Replaces EXP-0041, which closes unread before its first counted session.
  Descriptive: no hypothesis, no trial, no family.
- Frozen: `config.yaml`, before any v2 session was recorded. A changed value is a new experiment.
- Changes against EXP-0041:
  - a session counts on fresh coverage, from 09:35 at the latest;
  - the two counting conditions EXP-0041's YAML lost are restored and checked;
  - a stale-run limit is added;
  - the tier-1 cap is 300 per name;
  - open interest is also read before the open;
  - tables read only through `wt.lab.read`;
  - entries are placed on fresh ticks only.

  Tables, buckets, read points, intervals and cell minimums are EXP-0041's.
- Data: the lab's tape (DEC-0060 section 2), PRIVATE, outside the repository; focus names only.
- Start: the sixth session recorded by the v2 recorder after DEC-0067 is accepted (the first five are a shadow period).
  Never backfilled; the v1 session of 2026-11-19 counts for nothing.

## Tables

As EXP-0041: `stop_survival`, `round_trip_cost`, `limit_fill_band`, `model_gap`, each split by delta, expiry, time of
day, and calm or fast tape; a cell with fewer than 8 sessions or 30 entries is blank.

## Dates

- OPRA condition codes left out: EXP-0041's list of 2026-11-19, unchanged.
- First v2 session: (none yet)
- Counting starts: (none yet)
