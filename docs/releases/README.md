# Release log

One file per release day: what went to `main`, what was deployed where, how it was checked, and what is still open.
Read the newest file first; it is the starting state for the next piece of work.

A release record holds SAFE facts only (ids, dates, versions, statuses, counts). No log lines, account figures,
research prose or secrets belong here (see "Data classes" in `AGENTS.md`).

| Date | Release | `main` after | Record |
|---|---|---|---|
| 2026-11-18 | #501 to #508 and #510 (release #509, after #492 and #500 the same day), hotfix #526 | `ded833b4` | [2026-11-18.md](2026-11-18.md) |
| 2026-11-17 | hotfix #457 (#452 cherry-picked, and its review fixes), and #446 of 2026-11-15 | `343a0328` | [2026-11-17.md](2026-11-17.md) |
| 2026-11-13 | #423, #426 | `df42889` | [2026-11-13.md](2026-11-13.md) |
| 2026-11-12 | #383, #394, #408, #415, #419 | `99c6758` | [2026-11-12.md](2026-11-12.md) |

## Merges to `main` with no record

These went to `main` with no record written. The list comes from `git log origin/main --first-parent`, and each title
from its pull request. It holds ids, dates and commits only. The release and hotfix pull requests themselves list
what each one carried. Read 2026-11-25.

| Merged (UTC) | Pull request | Kind | `main` after |
|---|---|---|---|
| 2026-11-25 | #651 | release | `22c01cf7` |
| 2026-11-25 | #648 | release | `12d1e4b4` |
| 2026-11-25 | #639 | release | `1767db02` |
| 2026-11-24 | #632 | release | `a1f0db62` |
| 2026-11-24 | #627 | release | `43de5347` |
| 2026-11-24 | #621 | release | `69416149` |
| 2026-11-23 | #618 | release | `d9e958cb` |
| 2026-11-23 | #614 | release | `700eac84` |
| 2026-11-23 | #607 | release | `6209f747` |
| 2026-11-23 | #605 | release | `01cd34b8` |
| 2026-11-22 | #589 | release | `965e3702` |
| 2026-11-22 | #584 | hotfix | `612a775d` |
| 2026-11-21 | #579 | release | `34d86c5a` |
| 2026-11-20 | #578 | hotfix | `7aed8dc2` |
| 2026-11-20 | #575 | release | `9ba2ce16` |
| 2026-11-20 | #568 | hotfix | `2139452b` |
| 2026-11-20 | #561 | hotfix | `04399b8d` |
| 2026-11-20 | #554 | release | `5ec60b8c` |
| 2026-11-19 | #539 | release | `1b81134b` |
| 2026-11-19 | #536 | release | `9f95523c` |
| 2026-11-19 | #518 | hotfix | `f4b4ef48` |
| 2026-11-17 | #486 | release | `4ba993ac` |
| 2026-11-17 | #484 | release | `3b4c8069` |
| 2026-11-17 | #482 | release | `a3ae20f4` |
| 2026-11-17 | #474 | release | `cfb2f45f` |
| 2026-11-17 | #456 | release | `2ea3dc22` |

Add a row and a file with each release, using the same headings so records can be compared. A merge with no record
goes in the second table, or gets its record.
