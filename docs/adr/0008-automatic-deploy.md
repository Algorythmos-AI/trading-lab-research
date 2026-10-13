# ADR 0008: The host deploys itself, inside the same gate

- **Status:** accepted on merge by the owner. Supersedes the "owner still deploys" part of ADR 0007.
- **Context:** the owner asked for the deploy to stop being a manual step, the day after ADR 0007 chose a notice
  only

## Context

ADR 0007 left the deploy with the owner and added a notice. The first two days showed what the manual step costs.
On 12 October the owner tried three times and was refused each time: twice inside the trading window, once
because the test suite took ten minutes and the gate closed for the pre-market routine before the switch. The
window in which a deploy is accepted runs from 18:00 New York to about an hour before the routine, which is the
owner's working day in Sydney only by accident. A fix for a fault seen in production (hourly bars for seven names
of ten) waited a full day on a merged pull request.

ADR 0007 named what a move to automatic deployment needs: a page on every automatic deploy, a refusal when the
systemd units changed, and a record of who is accountable for what was merged. This record supplies them.

## Decision

1. The host runs `python -m wt.ops.deploy auto` once an hour as the job `deploy-auto`. It is not a trading job
   and never closes the gate.
2. `auto` asks what `ready` asks (gate open, main ahead, tip settled for 30 minutes, tip green, dashboard not
   behind it) and then runs the transaction `wt-deploy deploy` runs: the full test suite on the host in a
   throwaway worktree before the switch, the fast-forward, the dependency sync, the smoke test, and the
   rollback if the smoke test fails. One code path; nothing is relaxed.
3. It is stricter than the owner's own deploy in four ways.
   - The gate must still be open an hour from now, so the tests cannot outlast the window.
   - The owner's overrides (`WT_DEPLOY_CI_OVERRIDE`, the dashboard override) are never read.
   - A release that touches what `sudo wt-install-units` installs (the schedule, the unit renderer, the static
     units, the host helpers) is not deployed. Neither is anything while the installed units differ from the
     code. The owner is told once a day, with the reason and the commands.
   - A target whose tests failed on the host is not tried again; a newer commit is.
4. Every automatic deploy pages the owner: from which commit to which, how many commits, how to go back and how
   to switch this off. A deploy that fails its tests or its smoke test pages as it always has.
5. `var/deploy/AUTO_OFF` stops it. The file is the owner's: no job and no automated contributor creates or
   removes it.
6. The deploy record gains `by`: `auto` or `owner`.
7. With automatic deploys on, the "a deploy is ready" notice of ADR 0007 is not sent: the host takes the release
   itself, or says why it is the owner's.

## Who is accountable

The owner, for every merge. The pull request is now the last look before code runs on the host: the required
checks, the independent review each pull request records, and the owner's merge. Between a merge and the deploy
there are at least 30 minutes and usually hours (the gate), in which a revert on `main` stops the release.
AGENTS.md rule 3 says so, so that every session knows a merge is a deploy.

## What this is not

- Not a push from GitHub. Nothing new can reach the host; the host pulls, as ADR 0007 preferred.
- Not unattended unit changes. `sudo` stays with the owner.
- Not a deploy of the dashboard. That is its own workflow with its own gate.

## Consequences

- One more unit. The release that brings this job changes the schedule, so by its own rule it is the owner's:
  `wt-deploy deploy`, then `sudo wt-install-units`, once.
- The test suite runs on the host up to once an hour while the gate is open and main is ahead: about ten minutes
  of one core, in the hours no trading job runs.
- A release can go live while the owner sleeps. The page says so, and `AUTO_OFF` is one command.
- Releases that touch the schedule are judged by path, so a comment there keeps a release for the owner. That is
  the cautious side; the notice names it.
