# ADR 0008: The host deploys itself, inside the same gate

- **Status:** accepted on merge by the owner. Supersedes the "owner still deploys" part of ADR 0007.
- **Context:** the owner asked for the deploy to stop being a manual step, the day after ADR 0007 chose a notice
  only

## Context

ADR 0007 left the deploy with the owner and added a notice. The first two days showed what the manual step costs.
On 12 and 13 October the owner tried five times and was refused each time: inside the trading window, or because
the test suite took ten minutes and the gate closed for the pre-market routine before the switch. The window in
which a deploy is accepted runs from 18:00 New York to about an hour before the routine. A fix for a fault seen in
production (hourly bars for seven names of ten) waited more than a day on a merged pull request.

ADR 0007 named what a move to automatic deployment needs: a page on every automatic deploy, a refusal when the
systemd units changed, and a record of who is accountable for what was merged.

## Decision

1. The host runs `python -m wt.ops.deploy auto` once an hour as the job `deploy-auto`. It is not a trading job
   and never closes the gate.
2. **It is off until the owner switches it on**: the file `var/deploy/AUTO_ON`. Without it every run is a dry
   run: it asks every question and writes one line, "would deploy A -> B", and changes nothing. Removing the file
   switches it off again, and is honoured up to the moment before the switch.
3. `auto` asks what `ready` asks (gate open, main ahead, tip settled for 30 minutes, tip green, dashboard not
   behind it) and then runs the transaction `wt-deploy deploy` runs: the full test suite on the host in a
   throwaway worktree before the switch, the fast-forward, the dependency sync, the smoke test, and the way back
   if anything after the fast-forward fails.
4. It is stricter than the owner's own deploy.
   - The gate must still be open an hour from now, and no switch is started later than 25 minutes into a run, so
     neither the gate nor the job's own deadline can fall in the middle of one.
   - The owner's overrides are never read, and the required checks are the ones the code names, whatever the
     host's environment says.
   - A release that touches what `sudo wt-install-units` installs, or the deploy's own code (the deploy, the job
     runner, the checks reader, the gate, the locks, the dashboard guard), is not deployed. Neither is anything
     while the installed units differ from the code. The owner is told once a day, with the reason.
   - It does not run the tests beside the two long crypto jobs.
   - A target that failed its tests or its smoke test on the host is tried once more after six hours and then
     left; a newer commit is taken. What the owner rolled back is never put back.
5. What the owner hears.
   - "Deployed automatically": every deploy, with the two commits, how to go back and how to switch this off.
   - "Deploy refused: tests failed" and "Deploy rolled back": as before. These page when the state changes, so a
     second failure in a row does not page again; the next line covers that.
   - "A release has waited for hours": once a day, when the oldest commit not yet on the host is more than
     twelve hours old, with the reason (not green, dashboard behind, failed here, refused).
   - "A deploy needs you": a release that is the owner's, once a day.
   - "Host left between two releases" and "Automatic deploy stopped half way", at the highest priority: the
     switch failed and so did the way back, or the run died with the checkout moved.
6. The deploy record gains `by`: `auto` or `owner`. The automatic deploy's own memory lives outside
   `var/deploy/`, where every file is read as a deploy's record.
7. The "a deploy is ready" notice of ADR 0007 is not sent while the automatic deploy is switched on **and** has
   been seen running in the last three hours. Switched off, or its timer not installed, the notice is as it was.

## Who is accountable

The owner, for every merge. The pull request becomes the last look before code runs on the host. That is a rule
the repository does not yet enforce: its ruleset asks for a pull request and two green checks, and for no
approval, so anything with write access can merge. **Before creating `AUTO_ON`, the owner should restrict who can
merge to `main`** (a ruleset that limits merging to the owner, or one required approval). This record does not
change repository settings; they are the owner's.

Between a merge and the deploy there are at least 30 minutes and usually hours, in which a revert on `main` stops
the release. AGENTS.md rule 3 says a merge is a deploy where this is on, so every session knows.

## What this is not

- Not a push from GitHub. Nothing new can reach the host; the host pulls, as ADR 0007 preferred.
- Not unattended unit changes. `sudo` stays with the owner.
- Not a deploy of the dashboard. That is its own workflow with its own gate.

## Consequences

- One more unit. The release that brings this job changes the schedule, so by its own rule it is the owner's:
  `wt-deploy deploy`, then `sudo wt-install-units`, once.
- The suite runs on the host up to once an hour while the gate is open and main is ahead: about ten minutes,
  beside whichever interval jobs are due.
- Once switched on, a release can go live while the owner sleeps. The page says so.
- Releases are judged the owner's by path, so a comment in the schedule keeps one for the owner. The cautious
  side; the notice names it. The host's installed-files fingerprint (`/etc/wt/installed.sha256`) would judge more
  exactly and is not used yet.
- A run killed by the machine (not by its own limits) can leave a test worktree behind in `var/stage`; the next
  run of the same commit clears it.
