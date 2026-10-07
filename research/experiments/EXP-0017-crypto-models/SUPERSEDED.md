# EXP-0017 is superseded by EXP-0018

The files beside this note are the run as it was made and are not changed. Its numbers should not be used:

- **Sample weights.** A trade that finished inside its first 4-hour bar got full weight instead of a share.
  169 of 6,997 signals (2.4%) carried 34% of all weight, so every log-loss in the run, the baseline's included,
  was dominated by them.
- **Breadth.** Training counted signals across the 23 training pairs; the desk counts the eight traded pairs.
- **Universe.** Seven of the thirty training pairs were lost to a failed fetch and reported as short histories.
- **Kept against skipped.** The two means were reported with no interval.

EXP-0018 is the same experiment (DEC-0016, the same settings and the same end date) on the corrected code.
Its conclusion is the same, no candidate, and the difference M2 showed here between kept and skipped signals
is not there.
