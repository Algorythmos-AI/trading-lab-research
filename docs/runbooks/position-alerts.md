# Position and session alerts from the paper runner

> **2026-11-20 (DEC-0069): the QQQ rule is retired and its job, `paper-b`, no longer runs.** The `paper-b:*` pages
> below can no longer fire from a scheduled session. They are kept as the record of what each page meant, and for
> reading the archive (`data/live/journal.jsonl`, `logs/paper_b_<date>.log`). The live pages are the stock desk's,
> in the last section.

These fire during the session, not only after it (the runner pages through a background queue, so an alert can
never delay an exit). The ntfy topic is public, so a page carries counts and fixed words only: it never names the
symbol, a price or an error's text. The session's journal (`data/live/journal.jsonl`, echoed to `logs/paper_b_<date>.log`)
names them, by the event the page gives (`public-repo-guards.md`).

## "Paper B adopted a position it did not open" (priority 4, key `paper-b:orphan`)
- **Meaning:** QQQM was held and no plan explains it (a manual buy, or a plan file lost). The runner took it over
  as an `orphan` plan: it placed a stop, and exits it at the open (at once if the session is under way).
- **Not booked:** an orphan's close is journaled (`trade_closed`, `origin: orphan`) but never counted in B's
  virtual account or G2.
- **Do:** find out where it came from (Alpaca order history). If it was yours, nothing else to do.

## "Position outside strategy B's mandate" (priority 3, once a day, key `paper-b:out-of-mandate:<SYMBOL>`)
- **Meaning:** the paper account holds a symbol B never trades (B's allowlist is in `config/risk.yaml`). The page
  gives the share count; the symbol is in the alert key (on the dashboard's alert log) and in the session's journal
  (`out_of_mandate`). The runner never touches it, and it no longer blocks `make rollback`.
- **Do:** close it in the Alpaca UI, or accept it as legacy by recording it in `config/legacy_positions.yaml`:
  ```yaml
  positions:
    - {symbol: AAPL, qty: 1, note: "manual test buy"}
  ```
  A legacy entry covers that exact quantity only; any change is flagged again.

## "Paper B skipped an entry: clock check failed" (priority 4, key `paper-b:clock-skew`)
- **Meaning:** before an entry the runner compares the Mac's clock with Alpaca's (best of three bracketed reads).
  More than 2 s apart, or no reading, and the entry is skipped. Exits are unaffected.
- **Do:** check time sync: `sntp time.apple.com` (macOS) and System Settings › General › Date & Time › "Set time
  automatically". It resolves on the next good check.

## "Paper B: session close unknown" (priority 5, key `paper-b:close-unknown`)
- **Meaning:** neither the market calendar nor the broker clock could be read, so the runner can't time the
  end-of-day exit. It stopped; any resting GTC stop still protects the position.
- **Do:** check the account in the Alpaca UI. Close any position yourself if you want it flat today.

## "paper-b: entries off, exits only" (priority 4): removed
- This page left with the job (DEC-0069). No job starts after a failed preflight any more: a refusal is a refusal.

## Gap Hunter, the stock desk (job `paper-s`, keys `paper-s:*`)

Gap Hunter is the stock desk (DEC-0066, where it is "sleeve S"; most page titles still say "Sleeve S"): its own
runner (`wt.live.runner_s`), paper account, key pair, journal (`data/live/smallcap_journal.jsonl`, echoed to
`logs/paper_s_<date>.log`), kill file (`var/smallcap/KILL`) and lease. Its pages follow the same rule: fixed words
and counts, never a symbol, a price or an error's text. The journal event each page names holds the detail.

| Page | Priority | Key | Journal event | Meaning and what to do |
|---|---|---|---|---|
| Gap Hunter refused to start: key pair | 4, once a day | `paper-s:refused-keys` | `refuse_to_start` | `APCA_S_KEY_ID` / `APCA_S_SECRET_KEY` are not both set. Nothing ran. Store the pair (`sudo wt-set-secrets`). It does not matter what `APCA_API_*` holds: the desk never reads it |
| paper-s refused to run | 3, once a day | `refuse:paper-s` | the job's log | The host has no key pair for the stock desk, so the job runner did not start the runner (exit 0, no restart). Store the pair, or leave the timer off |
| paper-s: a second runner refused to start | 4, once a day | `paper-s:second-runner` | `refuse_to_start` | Another sleeve S runner holds `paper-s-runner`. The second one exited. Nothing to do unless it repeats |
| Sleeve S stopped: not a paper account | 5, once a day | `paper-s:not-paper` | `refuse_to_arm` | The broker did not report a paper account. The session ended at once. Check the key pair |
| Sleeve S: no primary lease, entries off | 4 | `paper-s:lease` | `refuse_to_arm` | On the host the lease `wt-leases/paper-s` was not held. Exits are managed. See [backups-and-lease.md](backups-and-lease.md). Clears when a session holds it |
| Sleeve S: session close unknown | 5, once a day | `paper-s:close-unknown` | `close_unknown` | Neither the calendar nor the broker clock could be read. The runner stopped; resting GTC stops stay. Check the account |
| paper-s stopped by its stop rule | 4, once a day | `paper-s:stop-rule` | `stop_rule` | The pre-registered stop fired and latched. Entries stay off until a decision record changes `S.stop_rule` |
| Sleeve S adopted a position it did not open | 4, once a day | `paper-s:orphan` | `adopted_orphan` | A long position had no plan: it was stopped and sold at once. Never booked to the sleeve's book. Find where it came from |
| Sleeve S: a position over its hard caps | 5, once a day | `paper-s:over-caps` | `position_over_caps` | A long position larger than `S.max_qty` or `S.max_notional`: the desk cannot stop or sell it. Close it yourself |
| Sleeve S is SHORT | 5, once a day | `paper-s:short` | `short_position` | The account is short. The desk's orders in the name were cancelled; nothing is bought back. Follow [not-flat-at-close.md](not-flat-at-close.md) |
| Sleeve S skipped an entry: clock check failed | 4 | `paper-s:clock-skew` | `clock_skew` | The local clock is more than 2 s off the broker's, or could not be checked. Exits are unaffected. Clears on the next good check |
| Gap Hunter could not protect a position | 5, once a day | `paper-s:protect-failed` | `protect_failed` | The broker refused (or did not answer) the stop for an open position (DEC-0077). The desk keeps managing the exit; if the bid was already at or under the stop it sold at market (`exit_signal` with `why: stop_under_market`). Check the account holds a stop or is flat |
| Gap Hunter is in a trade / closed its trade | 3 on the fill; the recovery notice on the close | `paper-s:position` | `entry_filled`, `trade_closed` | Information: the day's entry filled, then the trade closed at the R shown (`?R` when it is unknown). No symbol or price: the topic is public. The page shows the trade |
| Gap Hunter armed with new entries off | 4, once a day | `paper-s:entries-off` | `refuse_to_arm` | Armed with entries off for the count of reasons shown. Exits are still managed. Each reason is a `refuse_to_arm` row; some also page on their own (lease, stop rule, not paper) |
| Gap Hunter's poll keeps failing | 5, once a day | `paper-s:loop-error` | `loop_error` | 3 polls in a row failed. It keeps trying every poll. Read the `loop_error` rows; if they repeat with a position open, check the account holds a stop |
| Gap Hunter has no quotes for an open position | 4, once a day | `paper-s:data-timeout` | `data_timeout` | Quotes for an open position failed for 2 minutes. Exits that need a quote wait; the resting stop still protects it. Check the data feed (`keys-and-feeds.md`) |
| Sleeve S NOT FLAT at the close | 5 | `paper-s:not-flat` | `END_OF_DAY_NOT_FLAT` | A long position is open after the close. One the desk owns keeps a GTC stop and is sold at the next open. Clears when a later close is verified flat |
| Sleeve S is SHORT at the close | 5 | `paper-s:short-at-close` | `END_OF_DAY_NOT_FLAT` | Short after the close. Nothing is bought back. Follow [not-flat-at-close.md](not-flat-at-close.md) |
| Sleeve S could not verify flat after the close | 5 | `paper-s:not-flat` | `END_OF_DAY_NOT_FLAT` | The broker could not be read after the close. Check the account |

Not paged for sleeve S (the job runner does these for paper B only): a latch found after the session, repeated loop
errors, and an exits-only start after a failed preflight. A failed preflight refuses `paper-s` outright; a position
it holds keeps its GTC stop until the next session that starts.
