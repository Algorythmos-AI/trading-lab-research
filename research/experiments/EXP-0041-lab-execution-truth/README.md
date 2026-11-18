# EXP-0041: execution measured on the lab's option tape

- Decision: DEC-0060 (PROPOSED). Descriptive: no hypothesis, no trial, no family.
- Frozen: `config.yaml`, before any session was recorded. A changed value is a new experiment.
- Data: the lab's tape (DEC-0060 section 2), PRIVATE, outside the repository. Only each session's focus names are
  recorded and worked out (section 1).
- Start: the sixth recorded session after DEC-0060 is accepted (the first five are a shadow period). Never backfilled.
- Read points: 20 and 40 counted sessions, then every 40. Nothing is worked out between them.

## Tables

| Table | Question for the desk |
|---|---|
| `stop_survival` | How often does a -25% premium stop get touched within 5, 15 and 30 minutes, also when the stock only moved inside its normal noise; what is the real loss when it is touched; how many contracts keep that loss within the $50 risk limit |
| `round_trip_cost` | What a buy and a sell cost in spread and fees, as a share of the premium |
| `limit_fill_band` | The lowest and highest honest odds that a limit at the mid or at the ask fills within 30, 60 and 120 seconds, and where the mid is a minute after |
| `model_gap` | How far the option's real move is from the Options page's flat-volatility what-if |

Each is split by delta, expiry, time of day, and calm or fast tape. A cell with fewer than 8 sessions or 30 entries is
blank.

## Dates

- Probe: (not yet run)
- OPRA condition codes left out: (fixed before the first recorded session)
- First recorded session: (none yet)
- Counting starts: (none yet)
