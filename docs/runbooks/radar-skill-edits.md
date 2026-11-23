# The Radar skill's edits for the Options pipeline (plan step 7, the owner's)

The Radar's build routine runs a skill in the owner's claude.ai project. It is not in this repository, so these edits
are the owner's to make there. Each one is checked against what the repository already reads. Nothing here needs a
code change to take effect.

## 1. Options lists only

The Radar is for options only (owner, 2026-11-22; DEC-0070). The pipeline reads three lists by exact name
(`config/options_universe.yaml` `radar.lists_in_scope`):

- `DAILY RADAR`
- `MEGA CAP OPTIONS`
- `BREAKOUT WATCH`

**Edit:** stop building `SMALL CAP MOMENTUM`, `INSTITUTIONAL CONVICTION` and `SUPPORT PLAYS`. They are stock lists,
on Gap Hunter's ground. The pipeline already ignores them and counts them as out of scope. Dropping them saves the
build's time and keeps the edition honest.

**Keep the three names exactly as written.** A renamed list is counted as an unknown list and supplies nothing.
The record says so (`unknown_lists`), but the candidates are lost for that session.

## 2. Earnings in the hold, as calendar rows

The gate rejects a Radar name whose report falls on D, S or the session after S. The edition's calendar is what tells
it.

**Edit:** for every name on the three lists, write one calendar row per report from D to the session after S:

```json
{"date": "YYYY-MM-DD", "kind": "earnings", "time_et": "16:05", "label": "XYZ earnings after the close"}
```

- Put the ticker first in `label`, upper case, as its own word. The extractor reads the label's upper-case words
  (`radar_candidates.calendar_earnings`).
- Set `kind` to `earnings` (the schema allows `macro`, `earnings`, `holiday`, `other`).
- The calendar holds at most 60 rows.

A calendar row only ever **rejects**. A name missing from a 7-day calendar proves nothing.

## 3. What admits a name: a known next report (not the skill, today)

The gate admits a single name only when its next report is known: a future row, or a recent one, in
`config/events/earnings.csv` or `config/events/earnings_radar.csv` (same columns: `symbol,date,when,source,quality`).

The Radar edition has no structured "next report" field: the ticker schema has none, and calendar rows only reject.
So, until a record says otherwise:

- **The owner adds rows** to `config/events/earnings_radar.csv` for names the Radar lists. Take them from the company's
  own announcement or a named source, with `quality` confirmed or expected, as `earnings.csv` is kept.
- **Or a later record lets the skill publish them.** That needs a ticker field (for example a next report date, its
  timing and its source) in `dashboard/src/lib/radar.schema.json`, the extractor reading it, and DEC-0070's gate
  taking it as a known report. It is a change to the gate's admission rule, so it needs its own dated record before
  the switch.

Without one of the two, almost every discovered name is rejected `earnings_unknown`. That is the intended failure.

## 4. Counts the page would use (optional)

The Radar pipeline card shows the edition's own counts where the edition has them. Scan counts, such as how many names
the build screened and how many it rejected, have no field in the schema today. Adding them is a schema change
(`radar.schema.json`, display only), and can wait for DEC-0048's funnel card.

## Not the skill's

- The funnel repository's visibility (`trading-options-funnel`): the owner's call (DEC-0055 precondition 1).
- The cloud after-close focus pick: it stays until DEC-0048 turns it off.
