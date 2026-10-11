# EXP-0023: the four options probation rules, replicated from this repository's code

- Decision: DEC-0028, section 6. Hypotheses: HYP-0025 to HYP-0028 (family O).
- **What this is:** a replication of a result that was seen before the rules were registered. It is not a test
  of any rule, and nothing in it is evidence for or against one (DEC-0028, section 3).
- Span: 2026-03-03 to 2026-10-09, 10 names. Unit: R on the stock, before any option cost.
- Code: `wt.options.levels` and `wt.options.rules` as registered, driven by `scripts/options_replication.py`.
- Data: consolidated tape, 30-minute bars cut into the broker's hours, split-adjusted; 4460 daily and 49299 half-hour bars (hash `841db71157a321aa`),
  read from the market-data feed and kept out of the repository. The original study used the broker's own
  hourly bars, so the two runs share the code and the span, not the bars.
- Left out: 0 sessions without levels, 0 sessions with fewer than six hourly bars. A name whose daily bars
  have problems is noted and still scored, on the rows the loader keeps: there were 0 such names.
- Ranges: percentile bootstrap of the mean, 5000 resamples, seed 7 (`wt.backtest.stats.bootstrap_ci` as it
  stands), by case and by session.
- Run once, on 2026-10-11. The driver refuses to write over a record: a re-run takes a new EXP id.

## Result

| Rule | Cases, seen | Cases, here | Mean R, seen | Mean R, here | 95% range, seen | 95% range, here | 95% range, here, by session |
|---|---|---|---|---|---|---|---|
| `brk_PDH_close` | 636 | 636 | -0.002 | -0.0015 | [-0.071, +0.067] | [-0.0710, +0.0689] | [-0.0958, +0.0940] |
| `reclaim_PDL_close` | 187 | 187 | +0.008 | +0.0081 | [-0.084, +0.099] | [-0.0816, +0.1023] | [-0.1030, +0.1196] |
| `brk_PDL_close` | 547 | 547 | -0.008 | -0.0067 | [-0.082, +0.066] | [-0.0832, +0.0702] | [-0.1310, +0.1182] |
| `reject_PDH_close` | 229 | 228 | +0.033 | +0.0265 | [-0.055, +0.122] | [-0.0598, +0.1165] | [-0.0750, +0.1282] |

Pooled: 1598 cases, mean R +0.0018, 95% range [-0.0394, +0.0421] by case and
[-0.0490, +0.0573] by session. Exits: 382 stops, 91 targets,
1125 at the session's close.

## What it shows

1. **The registered code gives the figures seen in the study.** Three of the four case counts match exactly
   and the fourth differs by one; every mean R is within 0.007 of the figure seen before. The study ran on the
   broker's hourly bars and this run on consolidated-tape bars, so the match is in the totals: it was not
   checked case by case or bar by bar, and one run on one feed cannot say how far the two feeds agree.
2. **The ranges are the ones DEC-0028 already recorded.** Each 95% range includes zero, by case and, wider, by
   session (cases on one day share that day's market). This restates what was seen on the span the rules were
   chosen on. It adds nothing for or against a rule.

## What it does not show

- Anything about options. A case here is the stock's move in units of the rule's own risk. The cost of the
  option that would express it is not counted, and the promotion test needs it (DEC-0028, section 4).
- How many variants the original study tried. DEC-0028, section 6, asked this experiment to count them, and it
  did not: the study's variants are not in this repository, and this run executed the four registered rules
  only. That part of section 6 is still open. The trial count of 12 for family O stands as the floor DEC-0028
  set, taken from the study's own notes.
- That the host's in-session rule states match the after-close run. Those states read the same feed as this
  run, but nothing here compares the two feeds bar by bar; the states stay marked provisional.
- Anything out of sample. This is the span the rules were chosen on.
