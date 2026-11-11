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
