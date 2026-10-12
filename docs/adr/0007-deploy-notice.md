# ADR 0007: The host says when a deploy is ready; the owner still deploys

- **Status:** accepted, 2026-10-12 (the owner's merge of the pull request that carries it)
- **Context:** the owner asked whether the host could be deployed without typing the command each time, and chose
  to start with a notice only

## Context

A deploy today is the owner opening an IAP session and running `wt-deploy deploy` (ADR 0002, ADR 0004). The
command already refuses unless every condition holds: the gate is open, the target is on main and follows the
live checkout, its required checks are green, the dashboard is not behind it, and the full test suite passes on
the host before the switch.

Two things go wrong with a manual step. The host falls behind main without anyone noticing: several sessions
merge in a day, and on 12 October it was 34 commits behind. And the owner finds out the gate is closed, or a check
is still running, only after logging in.

Two ways to automate were considered.

- **Push from GitHub.** A workflow reaches the host after each merge. It needs a cloud credential stored in
  GitHub, and the host was built with no service account and SSH only through IAP. Whoever controls a workflow
  would hold a shell on the trading host. Rejected.
- **Pull on the host.** A timer on the host runs the same gated command. Nothing new is exposed. It removes the
  owner's look before code goes live, with several sessions merging unattended.

## Decision

1. The host runs `python -m wt.ops.deploy ready` twice an hour as the job `deploy-notify`. It is not a trading
   job: it never closes the deploy gate.
2. `ready` only reads. It asks the same questions a deploy asks, in the same code: is the gate open, is there a
   target, is the target green, is the dashboard not behind it. While the gate is closed it does not even fetch. It adds one of its own: the tip
   of main must be at least 30 minutes old, so a burst of merges settles first.
3. When every answer is yes it sends one notice, "A deploy is ready", at most once a day, with the number of
   commits and the two short hashes. When the host is up to date again the notice clears.
4. It never deploys, stages, tags, writes a deploy record, or moves the live checkout. It always exits 0: a
   notice that cannot be worked out is a line in the job's log.
5. A file `var/deploy/NOTIFY_OFF` silences it.
6. The owner still runs the deploy. AGENTS.md rule 3 is unchanged.

## What this is not

It is not automatic deployment. Moving to that is a further decision, with at least: a page on every automatic
deploy, a refusal when the systemd units changed (installing them needs `sudo`), and a record of who is
accountable for what several sessions merged.

## Consequences

- One more unit on the host. After the deploy that brings this, `wt-deploy` prints "units changed" and the owner
  runs `sudo wt-install-units` once.
- One GitHub API read per run when main is ahead and the gate is open; none otherwise.
- The notice names commit hashes and a count, never a commit subject.
