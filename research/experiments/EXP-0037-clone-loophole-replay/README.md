# EXP-0037: three of the options clone's rule gaps, replayed against the frozen clone

- Decision: DEC-0054 (**PROPOSED**). Hypotheses: HYP-0062 CLONE-ROOM-OPEN-SKY, HYP-0063 CLONE-RETEST-FREE-CONFIRM,
  HYP-0064 CLONE-REJECTION-SPY-TREND (family O).
- **Nothing has been replayed.** The replay code is written (section "Replay code" below), before DEC-0054 is
  accepted and so before any session on the list exists.
- **Blind.** Only sessions after DEC-0054 is accepted are replayed, and none of them has been seen when the
  variants are frozen. What the author had seen before writing is listed in DEC-0054.
- **Changes nothing that trades.** The clone and EXP-0029 are untouched. A supported variant may only be proposed
  in a further record, for a new paper experiment.
- **Run once,** after the last session on the list, on all four configs at the same commit.

## Replay code (written 2026-11-17, before acceptance and before any session on the list)

- `wt.options.variants`: the three variants, pure. The live clone never imports it, and `wt.options.setups` is
  unchanged: each variant takes the control's verdict and changes only the rule its hypothesis names.
- `wt.options.dryrun.replay_day(..., variant=None)`: None is the control. Each trade now also records
  `signal_bar` and `level`, the match key's last part.
- `wt.options.exp0037`: the session list, the match, the session bootstrap and the verdict.
- **Nothing is run by hand.** The host job `exp0037` (`wt.ops.schedule`; 17:15 New York, Monday to Friday) runs
  `scripts/exp0037_replay.py nightly` each weekday evening (amended 2026-11-17, before acceptance):
  - While DEC-0054 is not accepted, it does nothing.
  - The list is fixed by rule (`wt.options.exp0037.due`).
  - Each listed session that has closed is fetched into `data/exp0037/<session>/`, and its sha256 is written to
    `var/research/exp0037/input_sha256.json`. Nothing is replayed and nothing is read back. A missed evening is
    caught up by the next one. A session that fails to fetch on 3 evenings is recorded as skipped and never
    replayed, so it cannot hold up the others.
  - The run stops if the engine files differ from `af9b3590e638`, the commit that merged this code.
  - The evening the list closes, it checks every hash again, runs check_first, replays the four configs, writes
    `result.json` and `report.md` to `var/research/exp0037/` and pages the owner. A pull request then commits them
    here.
  - `scripts/exp0037_replay.py status` shows the progress, reading only.
- **check_first** compares against the engine at `f912d6296aa6`, the commit before the switches. It runs on every
  session at 1x and 2x, with the two added keys set aside, and the run stops on any difference. A unit test does
  the same on the scripted sessions.

How the code reads the hypotheses' wording, fixed here before any session is seen:

- **HYP-0062.**
  - The measured level applies only when `setups.next_level` is None and the risk is above 0.
  - Room then passes, and reach compares `min_room_multiple` × risk with the remaining move.
  - The trade's next-level exit uses the measured level.
- **HYP-0063.**
  - A carry starts from a retest the control would have signalled but did not read, because at that 2-minute
    close the clone had a position open, was in the loss pause, or was cooling down on that name.
  - A position entered at the same close, on another name or from another signal, counts as a position open.
  - Lasting blocks end the carry: the day's or the name's entry count, the latch, done after three losses, the
    entry window, or an event block.
  - The carry completes on the first later 2-minute bar that does all of the following (the tolerance test is
    the control's rule for any signal, which the hypothesis does not name):
    - closes beyond the touch bar's close;
    - closes at a moment when the clone can enter;
    - keeps the level within the control's `tolerance_atr` of the close.
  - Such a bar met only by a passing block keeps the carry, and one met by a lasting block ends it. So does a
    carried signal left unread because another signal on the same close was entered first.
  - The carry also ends when any of these happens:
    - a close since the break is at or back through the level;
    - more than `max_bars_to_retest` bars have passed since the first confirmation;
    - the control's own retest at the same level and side fires.
  - The invalidation is the control's formula at the ATR of the completing bar.
- **HYP-0064.** For rejections only, the trend gate is replaced by SPY's test (`spy_ok`). Retests are untouched.
- **The 2× figure** compares the variant's and the control's 2× runs, matched the same way. It does not
  re-price the 1× added set, and its mean is tested unrounded.
- **The total guard** is the sum of return on premium over all of a config's trades at 1×.
- **The bootstrap**:
  - resamples only the sessions that hold added trades;
  - takes each resample's mean over the trades of its sessions (the method of `wt.backtest.stats`, block "day");
  - uses its own seeded PCG64 generator and numpy's linear percentiles.
- **The contracts fetched** for a session are every call and put on the one-dollar grid from the day's low − $2
  to its high + $2. A contract outside that grid has no bars, and its signal counts as `no-option-bar`.

## Sessions

Fixed by rule, not written by hand: every session of the exchange calendar after the day DEC-0054 is accepted, the
first 40, none after 2027-04-30. The host job records each session's input hash the evening it closes.
