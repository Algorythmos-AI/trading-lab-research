# DEC-0059: The research arms stop booking, and the Paper page shows them only inside their windows

- **Status: ACCEPTED on 2026-11-18 (New York).** approved_by: owner. The owner chose this in chat on 2026-11-18,
  from three options put to them (close the arms and stop booking; keep booking under a new label; leave them as
  they are until a replacement exists), as the first step of a plan that replaces the arms with a research lab. The
  merge of the pull request that carries this line accepts it.
- **Nothing this record changes can move a verdict.** No trial it touches can reach its 20 sessions (see "Why"),
  so each closes with no verdict on 2027-11-05 whatever is shown or booked. What the author had seen is listed in
  "Disclosure".
- **Amends** DEC-0057 point 1 in one thing only: which virtual trades of the DEC-0041 arms the Paper options page
  shows. It also ends the booking that the owner's switch (`research_arms.enabled: true`, 2026-11-05) started under
  DEC-0041 points 1 and 2. No rule, gate, exit, limit, latch, trial
  count, verdict test or close date is changed.
- **Depends on:** DEC-0030 (the clone), DEC-0041 (the research arms), DEC-0056 (point 6, the arms end), DEC-0057
  (the Paper options page), DEC-0058 (a further config change from 2026-11-19).
- **Experiment:** none. No trial is added or removed; family O stays at 47.

## Why

DEC-0041 point 5 stops each arm "if EXP-0029's config changes", and DEC-0056 point 6 changed it from the 2026-11-18
session (the release reached the host before that session). All fourteen arm trials (HYP-0034 to HYP-0047,
EXP-0030) so ended with at most 9 sessions, 2026-11-05 to 2026-11-17.

The verdict script implements that stop per trial: `wt.options.arms_verdict.window` keeps a trial's units under the
config hash of **that trial's own first unit**. A trial with no unit before 2026-11-18 would therefore open a new
window under the new hash, from whatever the runner books while it keeps booking. Such a window can hold only the
sessions booked before booking stops, far fewer than 20, so it can give no verdict either; but it is not what
DEC-0041 point 5 says, and the page must not show it.

Two things were left running:

- `research_arms.enabled` is still `true` in `config/options_clone.yaml`, so the runner keeps writing tags on its
  decision lines and booking virtual trades in its `shadow/` folder. No trial counts them.
- The Paper options page (`wt.options.paper_site.arms_block`) shows every closed virtual trade in that folder, with
  no window. From the 2026-11-18 session on, its "Research arms" panel would mix trades that belong to a trial with
  trades that belong to none, under the trials' hypothesis ids.

Booking that no trial counts costs the runner work in every poll and adds nothing; showing it under a trial's id
misleads.

## Decision

1. **Booking ends.** `research_arms.enabled` becomes `false` in `config/options_clone.yaml`. The block's other keys
   stay as they are: the dashboard's entry-check vectors read `research_arms.tags`
   (`scripts/gen_entry_check_vectors.py`). The runner then writes no arm tag and books no virtual trade, from the
   first session run by a release that carries the change. `control_config_hash` leaves `research_arms` out, so the
   control's config hash, and EXP-0039 and EXP-0040, are untouched. The arms' code (`wt.options.shadow`,
   `wt.options.arms_verdict`) stays in the repository, unused while the switch is off.
2. **The page shows each arm only inside DEC-0041's window** (amends DEC-0057 point 1). The "Research arms" panel
   shows a virtual trade only if it is stamped by a known release and its session is on or before **2026-11-17**,
   the last session under EXP-0029's config (`wt.options.review.SPREAD5_END`). The cut is the same fixed date for
   every arm, not a per-trial hash rule. A test proves that no row after that date is shown and that every stamped
   row up to it is, unchanged.
3. **The panel says the counting ended.** It labels the arms as ended with no verdict, with the last counted session
   (2026-11-17: DEC-0056's change reached the host before the 2026-11-18 session) and the close date (2027-11-05). It shows no new figure: the same trades it showed for those sessions,
   and nothing after them.
4. **The trials close as DEC-0041 and DEC-0056 wrote them.** Each closes with no verdict on 2027-11-05, by the
   verdict script, which is unchanged. A replacement for the arms comes in its own records, with its own family and
   trials; nothing of these trials carries over to it.

## Order of the changes

- This record first. Then the dashboard's label (the page's document shape does not change). Then the host change:
  the config switch, the date cut in `arms_block`, and their tests, including
  `tests/unit/test_options_clone_records.py`, which today asserts `research_arms.enabled` is `true`.
- Trades the runner books between the 2026-11-18 session and that release are after the cut and never shown. The
  verdict script is not changed; for the reason in "Why" it cannot give any of these trials a verdict.

## Disclosure

- **Seen before writing:** on 2026-11-18 the owner showed the author a screenshot of the production Paper options
  page. It showed the clone's running total and trade count, and the four shadow arms' (HYP-0044 to HYP-0047) running
  dollar totals and trade counts. So AGENTS rule 2's "before any affected P&L is viewed" is not met for those four
  arms. The owner chose this record after the same screenshot; the choice was to stop booking ended trials, not a
  rule picked from their figures (DEC-0057 point 3). EXP-0039 has run one session and EXP-0040 none.
- **Read in planning:** the arms' and the clone's code on `origin/integration`, the records of DEC-0030, DEC-0041,
  DEC-0047, DEC-0051, DEC-0054 to DEC-0058, and their experiments by title and rule, including DEC-0058's count of
  sessions with entries. No journal, plan file, decision line, shadow file or review output of the host was read.
- Memory notes of earlier sessions of the same author say that EXP-0029's running figures were seen on 2026-11-16
  (DEC-0056 discloses this).

## Not changed

- The clone (`wt.live.runner_o`), every other key of `config/options_clone.yaml`, `config/risk.yaml` key `O`, the
  order path, and the control's config hash.
- The clone's own panels on the Paper and Trades pages, and the owner's hand-placed paper trades.
- `wt.options.arms_verdict`, the trials' count rules and their close date.
