# Public-repository guards

The repository is public (since 2026-11-08; the owner decides its visibility). These guards keep restricted and
runtime material out of it, keep the phone alerts free of anything a stranger could read, and say where the owner
sees the visibility the publishing jobs act on.

## Restricted paths in CI

**You'll see:** the required `test` check fails at "No restricted or runtime paths", listing paths only.

- The pattern is the pre-commit hook's own: `.pre-commit-config.yaml`, hook id `check-restricted`, its `files:`
  regex. `scripts/check_restricted_paths.py` reads it from that file, so the two cannot disagree; a test fails if the
  hook disappears, stops being `language: fail`, or the CI step is removed. Change the pattern in that one place.
- It checks every path tracked at HEAD (`git ls-files`) and every path added, renamed, changed in type or modified by
  any commit of the pull request (`origin/<base>..HEAD`; a push checks `before..HEAD`). A file added and deleted
  again inside the same pull request still fails it, and so does a symlink retargeted and put back: the branch's
  history is public too. The `test` job checks out the full history for this.
- Case-insensitive, like the hook: `Knowledge/`, `DATA/`, `x.PDF`. `.env.example` stays allowed.
- Any tracked symlink whose target is absolute, or climbs above the repository's root (`..`), fails it, wherever it
  points: on another checkout (the host's `/home/wt/trading`) it can resolve into `var/` or `knowledge/`. A relative
  link that stays inside fails it when the path it resolves to is restricted (`docs/k -> ../knowledge`). The output
  names the link, never the target or any file's contents.
- Exit 2 (fails closed) when `.pre-commit-config.yaml` cannot be read or parsed, PyYAML is missing, or git fails.
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
| "Repository is not private" (priority 3) | The first run that sees `public` or `internal`, after `private` or on the first check ever. Then nothing more while it stays so. A parked run fetches nothing, uses no token and adds no worktree: it lists what would be copied against the local checkout, logs `repo visibility: ...` and, last, `outcome parked`, and exits 0, so nothing in it can make the weekly job page | Nothing, while the repository is meant to be public: the weeks wait in `var/` and are archived one at a time later (gcp-host.md, step 3). A move between `public` and `internal` is not paged |
| "Repository is private again" (priority 2) | The first `private` after that | The next weekly run publishes |
| "Weekly evidence not published" (priority 3) | A publishing run stopped. The message says the step and its outcome: `pr-list`, `pr-open`, `fetch`, `worktree`, `commit`, `push`, `pr-create`; `failed`, `timed out`, `gh missing`, `still open` | Read `logs/scorecard_<date>.log` (the weekly job's log) for the detail (the remote's own text, token redacted). `pr-open`: merge the open `evidence/*` pull request. `push` or `fetch`: check `GH_TOKEN` (expiry, *Contents: write*). `pr-create`: the branch is on GitHub; open the pull request by hand or let the next run do it |
| "Weekly evidence published again" (priority 2) | The next run that publishes or finds nothing new, after a stop | Nothing |
| "Weekly evidence PR failed" (priority 2) | The evidence run crashed (a bug, not a failed step), or could not be started | Read `logs/scorecard_<date>.log`; the traceback is there |

Each stop pages once per step until a run succeeds (the keys are `evidence-pr:<step>`): a push that fails three weeks
running pages once. The run gives itself 400 s, made first: the visibility probe, every step and the final worktree
removal draw from it (the removal gets at least 5 s). Its alerts may use the network until 15 s after the budget
ends; past that a page waits in the spool for the next job, and a flush stops. Typically a stop page takes well
under a second. The bound that holds: one HTTP send can take up to twice its timeout (connect, then read), so
400 + 5 + 2 × 15 = 435 s, against the 600 s the weekly job allows. A hanging gh or git stops it with its own
page instead of the job killing it with none; if the job does kill it, the job pages and logs what the run had
printed. Every line the weekly job logs from the run (its output, the stderr tail of a crash, the output of a hung
run) goes through one redaction (`wt.ops.alerts.redact`): the environment's token values, and anything shaped like
a GitHub token (`ghp_…`, `gho_…`, `github_pat_…`), an `x-access-token:…@` URL credential or a bearer header. A manual
dry run (`make evidence`) never pages; a failed step there prints the step and
exits 1, the only case that returns 1.

The pages carry only the step, an outcome word, the ISO week and a file count: never the remote's error text, a
path or a token.

## What a phone alert may carry

The ntfy topic (ntfy.sh) is public: anyone who knows its name reads every page. A title and a message are fixed
words from the code, plus values that went through a guard in `wt.ops.alerts`: `count` (whole numbers), `word`
(enum words from a closed set the code defines), `day`, `hhmm`, `sha` (8 hex digits), `tag` (a `runtime-*` tag),
`record` (a DEC/HYP/EXP/ADR id), `exc_name` (an exception's class, never its text) and `ratio` (R and %). Never a
symbol, a price, a dollar amount, an account value, a host path or an error's text. `alerts.render` is what is sent:
it also scrubs amounts, account ids and URLs, as the last line of defence. The characters allowed are
`alerts.PAGE_CHARS`; titles stop at 120 characters, messages at 1000.

- `tests/unit/test_alert_allowlist.py` finds every alert the code can send, from the code itself
  (`tests/unit/alert_sites.py` follows wrappers such as the clone's `page` to where the text is made). Each needs an
  entry there, with hostile values for every name its text uses (every name in `config/options_desk.yaml` and B's
  allowlist, `123.45`, `US$1,234.56`, an exception with a path and a URL, a 4000-character string). A new alert
  without an entry fails the test. A new kind of value needs a guard, not a wider allowlist.
- The dashboard's pages (`dashboard/src/lib/ntfy.ts`, `NOTICE_KINDS`) are held to the same rules by
  `dashboard/test/ntfy-notices.test.ts`, with a word vocabulary as well.
- The one place a decision record lets more through is DEC-0044 section 3 (the server entry alert: a symbol, a side
  and a state word). It is not switched on and is not in this code yet; when it is, its page needs its own entry and
  the record's exception, not a wider rule.
- The log, the journal, the dashboard (behind the owner's login) and the alert key (the dashboard's alert log) still
  name what a page leaves out.

- **Where the removed detail is.** Each page that names a record names the real one: paper B's session journal
  (`data/live/journal.jsonl`, also echoed to `logs/paper_b_<date>.log`) by event (`out_of_mandate`, `reconcile`,
  `stop_rule`, `refuse_to_arm`, `session_end`); the clone's journal (`filled`, `trade_closed`) and its plan files;
  the job's own log under `logs/` (refusals, the clone's broker error at arm, the options job's rule triggers, the
  forward test's thin counts); `journalctl -u wt-backup` for the anchor; the chain flag file for a broken chain; the
  deploy's output for the ML sync. `tests/unit/test_alert_allowlist.py` (RECORDS) checks each record is written
  before its page, and the session tests check it at run time for paper B and the clone.
- **The send path.** `alerts.render` cuts a title to 120 and a message to 1000 characters, and a delayed page from
  the spool is cut again after its `(delayed: ...)` prefix. A page whose text is outside `PAGE_CHARS` is still sent
  (a page is never dropped), but the job's log says `alerts: a page outside the allowlist was sent` and
  `alerts.OFF_ALLOWLIST` counts it: that line in a log is a leak to fix.
- **Before deploying this release:** pages spooled before it (`var/alerts/spool/*.json`, written when ntfy was
  unreachable) keep their old text and are sent as they are. Check the spool is empty on the host
  (`ls /home/wt/trading/var/alerts/spool`) before deploying. Nothing deletes them automatically.
- **The systemd failure page** (`deploy/oci/bin/wt-alert`, `OnFailure=`) says "Trading host: <unit> failed" and
  "systemd reports <unit> failed. Check: journalctl -u <unit> and make status." It no longer names the host. A unit
  name outside `[A-Za-z0-9._-]` (80 characters at most) reads "a unit", with "Check: make status and the journal for
  the failed unit." It reads only `/etc/wt/paging`; the test's override works only with `WT_ALERT_TEST=1` set too,
  and says so on stderr. `tests/unit/test_wt_alert.py` runs it with
  hostile unit names against a fake curl.
