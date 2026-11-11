# Public-repository guards

The repository is public (since 2026-11-08; the owner decides its visibility). These guards keep restricted and
runtime material out of it, keep the phone alerts free of anything a stranger could read, and say where the owner
sees the visibility the publishing jobs act on.

## Restricted paths in CI

**You'll see:** the required `test` check fails at "No restricted or runtime paths", listing paths only.

- The pattern is the pre-commit hook's own: `.pre-commit-config.yaml`, hook id `check-restricted`, its `files:`
  regex. `scripts/check_restricted_paths.py` reads it from that file, so the two cannot disagree; a test fails if the
  hook disappears, stops being `language: fail`, or the CI step is removed. Change the pattern in that one place.
- It checks every path tracked at HEAD (`git ls-files`) and every path added or renamed by any commit of the pull
  request (`origin/<base>..HEAD`; a push checks `before..HEAD`). A file added and deleted again inside the same pull
  request still fails it: the branch's history is public too. The `test` job checks out the full history for this.
- Case-insensitive, like the hook: `Knowledge/`, `DATA/`, `x.PDF`. `.env.example` stays allowed.
- A tracked symlink whose target resolves to a restricted path fails it (`docs/k -> ../knowledge`, or an absolute
  target such as `/home/wt/trading/var/...`). The output names the link, never the target or any file's contents.
- Only the top-level `knowledge/`, `data/`, `var/`, `logs/` and `build/` directories match, as in the hook:
  `src/wt/data/` is code.
- **Out of scope:** content. A PDF renamed to another extension, or restricted prose pasted into a tracked file, is
  not a path and passes this check. gitleaks covers secrets; review covers prose.

**What to do:** remove the path from the branch (`git rm --cached <path>`, then add it to `.gitignore` if it is a
runtime path). If it was added in an earlier commit of the same pull request, rewrite the branch so no commit holds
it (an interactive rebase, or a fresh branch with one squashed commit), then force-push the branch. If it reached
`integration` or `main`, treat it as a leak: tell the owner; the history must be rewritten and the material may
already be copied.

Locally: `make restricted` (HEAD only), or `.venv/bin/python scripts/check_restricted_paths.py --base origin/integration`.
`make ci` runs it.

## Repository visibility (`make status`)

**You'll see:** the last line of `make status` (and `wt-deploy status` on the host):

```
repo visibility: public (last confirmed public on 2026-11-13)
repo visibility: unknown (last confirmed public on 2026-11-13; 2 unknown answer(s) in a row, last cause timeout)
repo visibility: unknown (never checked: the weekly evidence job checks it, or run make visibility)
```

- One place answers "is the repository private?": `wt.ops.visibility` (`gh api repos/<repo> --jq .visibility`).
  Every job that publishes to GitHub asks it afresh (today only the weekly evidence job does); a remembered answer is
  never used to publish. The answer is `private`, `public`, `internal` or `unknown`.
- `make status` reads the record `var/repo-visibility.json` and asks nothing. The weekly evidence job refreshes it
  every Friday evening (New York). `make visibility` asks now (needs gh and `GH_TOKEN` on the host), records the
  answer and pages if it changed.
- `unknown` (no network, a timeout, a refused token) is never taken for private, and on its own is not an alarm.
  The third `unknown` in a row pages once, **"Repository visibility unknown"**, naming the last cause (`timeout` or
  `error`); the next known answer resolves it. With a weekly check, that is three weeks without an answer: run
  `make visibility` by hand to look sooner.
- gh missing pages once, **"gh is not installed on the host"**, and does not count towards the unknown streak.
  `sudo wt-tune-host` installs it on the GCP host.

## Weekly evidence and visibility alerts

The weekly job (`wt-weekly`) runs `wt.ops.evidence` after the scorecard. What you can get:

| Page | When | What to do |
|---|---|---|
| "Repository is not private" (priority 3) | The first run that sees `public` or `internal`, after `private` or on the first check ever. Then nothing more while it stays so; the weekly log still says `evidence PR parked` and `repo visibility: ...` each run | Nothing, while the repository is meant to be public: the weeks wait in `var/` and are archived one at a time later (gcp-host.md, step 3). A move between `public` and `internal` is not paged |
| "Repository is private again" (priority 2) | The first `private` after that | The next weekly run publishes |
| "Weekly evidence not published" (priority 3) | A publishing run stopped. The message says the step and its outcome: `pr-list`, `pr-open`, `fetch`, `worktree`, `commit`, `push`, `pr-create`; `failed`, `timed out`, `gh missing`, `still open` | Read `logs/scorecard_<date>.log` (the weekly job's log) for the detail (the remote's own text, token redacted). `pr-open`: merge the open `evidence/*` pull request. `push` or `fetch`: check `GH_TOKEN` (expiry, *Contents: write*). `pr-create`: the branch is on GitHub; open the pull request by hand or let the next run do it |
| "Weekly evidence published again" (priority 2) | The next run that publishes or finds nothing new, after a stop | Nothing |
| "Weekly evidence PR failed" (priority 2) | The evidence run crashed (a bug, not a failed step), or could not be started | Read `logs/scorecard_<date>.log`; the traceback is there |

Each stop pages once per step until a run succeeds (the keys are `evidence-pr:<step>`): a push that fails three weeks
running pages once. The run gives itself 480 s, under the 600 s the weekly job allows, so a hanging gh or git stops
it with its own page instead of the job killing it with none. A dry run (`make evidence`) never pages; a failed step
there prints the step and exits 1.

The pages carry only the step, an outcome word, the ISO week and a file count: never the remote's error text, a
path or a token.
