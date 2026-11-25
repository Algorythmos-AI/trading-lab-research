# Notice: restricted third-party material

**Keep this repository private. Never make it public, fork it, or copy its contents into a public
repository.** Its catalog entry is `data_class: restricted`.

> **Status, 2026-11-25:** the repository is public, under the owner's risk acceptance recorded in
> [SECURITY.md](SECURITY.md) ("Current exception"). The rule above stands; the exception is the owner's to end.

Some of this repository's contents are derived from third-party day-trading courses, books and notes.
Most of that material is Warrior Trading course content, which is "All rights reserved". The derived
content is:

- `research/specs/`: the methodology specification and the owner's source notes behind it
- `research/hypotheses/`, `research/decisions/` and experiment reports that paraphrase course rules
- `knowledge/`: the extraction outputs. These are git-ignored and never pushed.
- `research/external/`: public social-media posts by other traders, kept **verbatim** in `posts/*.jsonl` at the
  owner's decision (2026-11-05), so the study of them can be checked and extended. Rights stay with their authors.

Algorythmos Pty Ltd holds **no licence to redistribute** this material. It is kept here only as the
private record of the research that tests those rules. Course rules are paraphrased and cited, not copied; the
posts under `research/external/` are the one verbatim exception, and the dashboard's leak check covers them.

Rights remain with their respective owners. To have material removed, contact
info@algorythmos.com.au.

## The status dashboard

The dashboard at lab.algorythmos.com never publishes restricted material. The publisher (`wt.ops.publish`) sends
only allowlisted fields: ids, statuses, dates, counts, statistics, and short owner-written notes. It withholds any
text that shares an 8-word phrase with the course corpus. Spec text, decision and hypothesis prose, setup names and
news headlines are never sent. See `docs/adr/0001-vercel-dashboard.md`.

One exception, decided by the owner on 2026-11-25: the **Reference Registry**, the owner-only index of the research
records behind the dashboard's Vercel Authentication. It is built in CI from the repository (not by `wt.ops.publish`)
and may carry each decision's, hypothesis's, experiment's and lesson's title and a capped summary of that record's
own prose (the RECORD class in `AGENTS.md`). CI has no copy of the course corpus (`knowledge/` is never pushed), so
that text is **not** put through the 8-word phrase check; what keeps it to the owner is the login, the closed list of
record files it reads, and the cap on each summary. It never reads `research/specs/`, `research/external/`,
`knowledge/` or any `report.md`, and it sends nothing anywhere but the owner's dashboard.
