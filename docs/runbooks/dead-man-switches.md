# Dead-man's switches: who notices when the host goes quiet

Four independent monitors, none of them on the trading host:

1. **The Vercel watchdog** (`/api/cron/watchdog`, every 10 minutes): pages when the dashboard snapshot goes stale
   inside an expected trading window. Proven by `make watchdog-drill` (see dashboard-deploy.md).
2. **healthchecks.io** (free plan): each job pings its own check by slug when it finishes, and `/fail` when it
   fails or refuses. A check that doesn't hear from its job in time pages (ntfy + email).
3. **Cloudflare tunnel notification**, where the tunnel is set up: tunnel down. (The OCI instance alarm of ADR 0004
   never existed: that host was never provisioned.)
4. **The feed watch**, in the same cron run, beside the desks' ticks (`dashboard/src/lib/feed-watch-run.ts`): whether
   each cloud routine's document arrived for the right session by its time (the options edition, the pre-open
   refresh, the journal, the radar, the ledger as display only), whether the desk's shadow evaluator is still writing
   its records while its switch is on, and whether `/api/ingest` refused an edition that nothing has replaced. It
   pages through ntfy (`feed-late`, `rejected`, `feed-recovered`) only once the owner sets `FEED_WATCH_ALERTS=on` in
   Vercel; until then it keeps its state and shows everything on the pages. Its rules, the switch-on behaviour and
   the division of labour with the pipeline check are in `dashboard/README.md` ("Feed watch").
   `make feed-watch-drill` runs it offline through late and recovered and prints both pages. When its own state
   cannot be read or written it sends no feed alert and, with alerts on, "Feed watch cannot read its store" from the
   first two ticks of each 2-hour UTC block: up to 2 a block (4 if the cron delivers a tick twice), so a 12-hour
   outage can send 12 to 24 on the topic. An alert ntfy could not take is retried (3 quick tries, then every 30 minutes
   for 2 hours) and, if it still did not go, shown on the Operations page's "Your feeds" card.

The pipeline check (`wt-pipeline-check`, below) checks the options edition's **content** against the market's own
data; the feed watch checks its **timeliness**. A pipeline-check page whose failed ids are only `options.present`,
`options.session` or `options.built_from` for a session the feed watch has already paged late or refused is the same
incident, not a second one.

## healthchecks.io setup (owner, once)

1. Create a free account and a project "trading-lab". Settings > API Access: create a **ping key** and put it in
   the host's secrets with `sudo wt-set-secrets` (`HC_PING_KEY`). Never commit it.
2. Integrations: add **ntfy** (the same topic as `NTFY_TOPIC`) and email. Attach both to every check.
3. Create these checks. Use **Cron** schedules, time zone **America/New_York**, slug exactly as shown. Each tick
   is before the earliest possible ping on either host in every daylight-saving combination, and the grace covers
   the latest normal ping (a day with no session, or an early close, still pings inside the window):

| Slug | Cron | Grace | Normal ping (ET) | What a page means |
|---|---|---|---|---|
| `wt-routine` | `0 5 * * 1-5` | 5 h | ~08:00 | The pre-market routine didn't finish (or refused) |
| `wt-paper-s` | `0 6 * * 1-5` | 11 h | ~16:05 (13:05 early close) | Gap Hunter's (the stock desk's) session job didn't end cleanly, or was refused (no key pair on the host) |
| `wt-forward` | `0 12 * * 1-5` | 7 h | ~16:30–17:50 | The forward test didn't run |
| `wt-weekly` | `0 18 * * 5` | 6 h | Fri ~19:00–21:00 | The weekly scorecard didn't run |
| `wt-paper-o-armed` | `0 9 * * 1-5` | 1 h | ~09:25 (arm) and after the close | The options clone never armed: not started, refused or crashed while arming |
| `wt-paper-o` | `0 9 * * 1-5` | 8 h | ~15:20–16:05 | The options clone's session job didn't end cleanly |
| `wt-pipeline-check` | `0 8,18 * * 1-5` | 1 h 30 min | ~08:55 and ~18:30 | The options pipeline check didn't run or crashed (a failed check, market data unreachable included, pages through ntfy and exits 0, not here) |
| `wt-options-review` | `0 16 * * 1-5` | 3 h | ~16:30 | The options clone's nightly review didn't run |
| `wt-lab-tape` | `0 9 * * 1-5` | 10 h | ~17:30–17:50 (14:30–14:50 early close); ~09:25 on a day with no session or no focus list | The options lab's tape recorder didn't run or crashed: no session tape that day (DEC-0060; see `lab-tape.md`) |
| `wt-options-select` | `0 6 * * 1-5` | 3 h | ~06:46 (no session), ~06:50–08:35 | The Radar → Options shadow selection didn't run or failed: that session has no shadow record and does not count towards DEC-0070's five clean sessions |

Ten checks for the stocks and options jobs; the VM adds backup and restore-test checks (at most 16 of the free 20).
The stock desk has no `-armed` check: its runner pages on its own, and `wt-paper-s` catches a session that never ran.
The QQQ rule's two (`wt-paper-b-armed`, `wt-paper-b`) ended with its job (DEC-0069, 2026-11-20): pause or delete
them on healthchecks.io once the release that removes the job is deployed, or they page for a job that no longer
exists. The
crypto desk's three (`wt-crypto`, `wt-crypto-challengers`, `wt-crypto-learn`) ended with the desk (DEC-0036, 2026-10-24):
pause or delete them on healthchecks.io, or they page for a job that no longer exists. The Mac and the VM share these
slugs: the ping body says which host and role sent it.

## What the jobs send

- Success (exit 0): `https://hc-ping.com/<key>/<slug>`, body `host=… role=… exit 0`.
- Failure or refusal: `…/<slug>/fail`. A refusal exits 0 so the scheduler doesn't retry it, but it is not a
  success. A run that finds its job already running (lock held) sends nothing: the running one will ping.
- Pings never block or fail a job: 5-second timeout, errors ignored, nothing sent without `HC_PING_KEY`.

## When a check pages

Open the job's log (`make status`, then `logs/<job>_<date>.log`) and the journal. The ping body shows the host
and the exit code. A page on a US holiday means a job didn't run at all (they still start and exit early).

## The snapshot probe (temporary evidence for the board's bad-data guards)

Before the Options board learns to pause on a snapshot that looks wrong (high below low, an open outside the day's
range, a last trade outside the day's high and low or more than 25% from the prior close, a crossed quote), the
desk's shadow evaluator records how often real IEX snapshots show those shapes in normal conditions, so the guards
are not tuned to pause the board falsely. It is log only: no page, value, alert or evaluation changes because of it,
and it sends nothing (ntfy is a public topic).

- **What it records.** On each slot's server record (`desk/log/YYYY-MM-DD/HHMM.json`, the record the evaluator
  already writes, as its last key `probe`): per focus name, from the snapshot answer that run already fetched:
  - `source`: `fetched`; `cached` when the 1.5 s quote cache served it; `missing` when Alpaca left it out; `invalid`
    when the answer for the name is not a snapshot object, or the server time is unusable.
  - The last trade: `trade`, `trade_day` (today or another New York day than the server's), its age, its exchange
    code and condition codes (each 1-2 characters of `A-Z`, `0-9`, space or `@`; anything else dropped and
    counted), `trade_sets_minute_price` and `trade_sets_daily_price` (`yes`, `first-only`, `no`, `unknown`: the
    strictest rule across its codes on its tape, read from the condition table in Alpaca's market-data FAQ, "How are
    bars aggregated?", kept as data in `dashboard/src/lib/quote-conditions.ts`), and the flags `trade_odd_lot` (I)
    and `trade_extended_hours` (T or U).
  - The minute bar (`absent`, `invalid`, `forming`, `finished`, its age from the minute's start) and
    `trade_vs_minute_s`, the finished bar's end minus the trade's time, truncated toward zero.
  - The daily bar: `daily`, `daily_day` (today or another day: exactly the page's `quote.day` test), `daily_session`
    and `prev_session` against the exchange calendar (`today`, `previous-session`, `older`, `off-session`, `future`,
    `absent`, `invalid`, `unknown`), `high_below_low`, `open_outside`.
  - The trade against the day's range: `inside`, `above-high`, `below-low` (and by how many basis points) only when
    the daily bar and the trade are both today's; otherwise `stale-day`, or `no-daily-bar`, `no-trade`.
  - The move from the prior close: `within`, `at-limit` for exactly 25%, `beyond`, `unknown`, in basis points.
  - The quote: `absent`, `invalid`, `empty`, `one-sided`, `crossed`, `locked`, `normal`; `quote_time`; its spread in
    basis points; its age. A side with a zero price or a zero size is no active side; a missing size leaves the
    side to its price.
  - Ages are stored as seconds from server time, floored to one decimal (times are SAFE). A time before 1970 (Go's
    zero time `0001-01-01`) or unparseable is `invalid`. A time more than 7 days from server time is still a real
    (stale) day, as `quote.ts` reads it; only its age is left out and named in `age_out_of_range`.

  Per run: `phase` (`pre-open`, `regular`, `after-close`, `closed`, `unknown`, by New York time and the calendar,
  half days included) and Alpaca's `X-RateLimit-Limit` and `X-RateLimit-Remaining` on the snapshot response
  (`rate_limit`, `rate_remaining`). The record is written only in the regular session (the cron's run idles before
  the first 2-minute bar has settled at 09:32 and from the close), so it never shows `pre-open` and cannot say
  whether `dailyBar` is still yesterday's before 09:30; the session facts still catch a wrong-day bar in session.
  Enums, ages, basis points, codes and symbols only: never a price, a size or text. `probe` is null when the
  snapshot read did not answer, every name came from the cache, or the probe failed; records written before it
  existed have none.
- **What it costs.** No extra store operation and no extra Alpaca call: it reads the snapshot answer the run already
  fetched and rides on the slot's one create-only put (about 195 a session, as before). The record grows by roughly
  650 bytes per focus name.
- **How to read it.** Signed in to the dashboard, open `/api/desk/probe?day=YYYY-MM-DD` (New York date; today when
  left out). It answers JSON: `listed` server records, `unreadable`, `cached`, and `summary`, grouped by the
  record's `feed` (`by_feed.iex`, `by_feed.sip`, `by_feed.unknown`; IEX and SIP days are never pooled). Each group
  has its runs per `phase`, the rate-limit values seen, and per name (`by_symbol`) and in `total`:
  - counts per fact and value, and the condition and exchange codes seen;
  - `day_range_by_daily_price`, the guard's own count: `trade_vs_day` crossed with `trade_sets_daily_price`. "How
    often is a trade that does set the daily high/low outside the daily range" is `above-high` and `below-low`
    under `yes` and `first-only`; a trade outside the range under `no` (an odd lot, an extended-hours print) is not
    a sign of a bad bar;
  - per number its count, smallest, largest and fixed buckets, each with a `negative` bucket first (a negative age
    is clock skew; a negative spread is a crossed quote): ages `negative`, `0-5`, `5-20`, `20-120`, `120+` s; day
    range and spread `negative`, `0-10`, `10-50`, `50-250`, `250+` bps; prior close `negative`, `0-100`,
    `100-500`, `500-1000`, `1000-2500`, `at-limit`, `beyond-2500` (the last two from the name's `prior_move`, so a
    move within 25% that rounds to 2500.0 bps stays in `1000-2500`);
  - `ages_out_of_range`, per age.

  A view of today costs one listing of that day's folder and one read per server record (about 195 for a full
  session). A past day with records is then kept in the instance's memory (at most 5 days) and costs nothing more
  there; an empty listing is never kept. A HEAD reads nothing. Outside production and in fixture mode it reads
  nothing and answers `"dry": true`.
- **When to remove it.** Once the guards (the next pull request after the probe) are set from a few weeks of
  counts, the probe, its route and this section go.
