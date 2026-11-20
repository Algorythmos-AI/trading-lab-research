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

- Probe: 2026-11-19 (run 05:30 UTC on the host, for the session 2026-11-19): passed every mark. Request limit
  10,000 a minute on the `APCA_CLONE` pair (the `APCA_OPTIONS` and `APCA_API` pairs the same); a tier-1 sweep in
  0.115 s (2 requests, none failed); 53.6 GB free; all 4 focus names measured. 189 tier-1 contracts (10 more over
  the ask cap, left out) and 3,583 tier-2; projected tier-1 raw size at most 621.5 MB a session. Nothing narrowed.
  `WT_LAB_RATE_LIMIT` stays at its default 1,000, so the recorder's budget is 400 requests a minute.
- OPRA condition codes left out: 2026-11-19, from Alpaca's list (`/v1beta1/options/meta/conditions/trade`, read the
  same day), applying `definitions.prints_used`. Left out: cancelled `A` `C` `E` `G`; late or out of sequence `B` `D`
  `F` `H`; multi-leg `f` `g` `h` `i` `j` `l` `m` `t` `u`; tied to stock `k` `n` `o` `p` `q` `r` `s`; extended hours
  `v`; single-leg crosses `c` `d` (pre-arranged, they never meet a resting order, so they say nothing about a limit
  filling). Kept: `I` `J` `S` `a` `b` `e` and prints with no code. A print carrying any left-out code is left out.
- First recorded session: 2026-11-19 (v1 recorder; a shadow session; counts for nothing).
- Closed: 2026-11-20, unread, by DEC-0067 (accepted 2026-11-20): replaced by EXP-0052 before any session was
  counted. No table, statistic or entry of EXP-0041 was ever worked out.
- Counting starts: (none yet)
