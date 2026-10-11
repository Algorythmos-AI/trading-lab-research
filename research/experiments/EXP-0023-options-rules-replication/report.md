# EXP-0023: the four options probation rules, replicated from this repository's code

- Decision: DEC-0028, section 6. Hypotheses: HYP-0025 to HYP-0028 (family O).
- **What this is:** a replication of a result that was seen before the rules were registered. It is not a test
  of any rule, and nothing in it is evidence for or against one (DEC-0028, section 3).
- Span: 2026-03-03 to 2026-10-09, 10 names. Unit: R on the stock, before any option cost.
- Code: `wt.options.levels` and `wt.options.rules` as registered, driven by `scripts/options_replication.py`.
- Data: consolidated tape, 30-minute bars cut into the broker's hours, split-adjusted; 4460 daily and 49299 half-hour bars (hash `841db71157a321aa`),
  read from the market-data feed and kept out of the repository. The original study used the broker's own
  hourly bars, so the two runs share the code and the span, not the bars.
- Left out: 0 names with bar problems, 0 sessions without levels,
  0 sessions with fewer than six hourly bars.

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

1. **The repository's code reproduces the study.** Three of the four case counts match exactly and the fourth
   differs by one; every mean R is within 0.007 of the figure seen before. The engine that moved into the
   repository is the engine that produced the page's numbers, on another feed's bars as well as on its own.
2. **None of the four rules shows an edge on this span**, as DEC-0028 already recorded. Every 95% range
   straddles zero. Resampled by session, which is the fairer reading because cases on one day share that day's
   market, the ranges are wider still.
3. **The two feeds agree closely enough for an in-session read.** That is what the host's provisional rule
   states rely on. It is one span and ten liquid names; it is not a guarantee for a thin name or a bad print.

## What it does not show

- Anything about options. A case here is the stock's move in units of the rule's own risk. The cost of the
  option that would express it is not counted, and the promotion test needs it (DEC-0028, section 4).
- How many variants the original study tried. This run executed the four registered rules only. The trial
  count of 12 for family O stands as the floor DEC-0028 set, taken from the study's own notes.
- Anything out of sample. This is the span the rules were chosen on.
