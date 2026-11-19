# EXP-0050: the options clone on SIP stock bars, forward on paper

- **Decision:** DEC-0064.
- **Trials:** HYP-0029 (`retest`), HYP-0030 (`rejection`) and HYP-0031 (`nearest`), each run again on the new feed
  as a new trial. Family O goes from 48 to 51 (the 48 counts DEC-0065's proposed trial).
- **Design only.** Nothing here is a result, and no session on the new feed existed when this was written.
- **The report is written once,** when a trial reaches 30 trades and 20 sessions, by:

  ```
  scripts/options_clone_verdict.py --rules sip --trials retest,rejection,nearest \
      --out research/experiments/EXP-0050-options-clone-sip
  ```

  The script refuses to write over an existing report. Until then the nightly review shows trade and session counts
  only.
- **Start: the cutover session** (DEC-0064 point 6): the first session whose `armed` journal line names the stock
  feed as `sip`. A dated note in DEC-0064 gives the date before that session's trades are viewed. Trades of earlier
  sessions stay in EXP-0040 and earlier.
- **Run:** job `paper-o` on the host, with `config/options_clone.yaml` and `config/risk.yaml` key `O`, as frozen by
  DEC-0039, DEC-0040, DEC-0056, DEC-0058 and DEC-0064:
  - 1-minute stock bars from SIP (`feeds.stock: sip`), option quotes from OPRA (`feeds.option: opra`);
  - the pre-market high and low from 04:00 to 09:30 New York on SIP, read again at 09:30;
  - `feeds.bar_settle_s` as DEC-0064 point 7 leaves it.

  Every other rule is unchanged.
- **Trades, ledger, unit, verdict and exclusions:** as EXP-0028.
- A session that ran on IEX, or on both feeds, is never counted here.
- A number changed after a result is seen means a new experiment and new trials.
