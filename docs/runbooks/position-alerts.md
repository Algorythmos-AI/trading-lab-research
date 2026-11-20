# Position and session alerts from the paper runner

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

## "paper-b: entries off, exits only" (priority 4)
- **Meaning:** preflight refused (free disk, `.env` mode or unmigrated state), but B held a position, so the job
  started the runner anyway in exits-only mode: it manages and exits the position and takes no new trade.
- **Do:** fix the preflight cause (see [Disk nearly full](disk-full.md)); the next session is normal.

## Sleeve S (job `paper-s`, keys `paper-s:*`)

Sleeve S is Robot B's stock desk (DEC-0066): its own runner (`wt.live.runner_s`), paper account, key pair, journal
(`data/live/smallcap_journal.jsonl`, echoed to `logs/paper_s_<date>.log`), kill file (`var/smallcap/KILL`) and lease.
Its pages follow the same rule as paper B's: fixed words and counts, never a symbol, a price or an error's text. The
journal event each page names holds the detail. None of them touches paper B.

| Page | Priority | Key | Journal event | Meaning and what to do |
|---|---|---|---|---|
| Sleeve S refused to start: key pair | 4, once a day | `paper-s:refused-keys` | `refuse_to_start` | `APCA_S_KEY_ID` / `APCA_S_SECRET_KEY` are not both set, or the key id is sleeve Q's. Nothing ran. Store the pair (`sudo wt-set-secrets`) |
| paper-s refused to run | 3, once a day | `refuse:paper-s` | the job's log | The host has no key pair for sleeve S, so the job runner did not start the runner (exit 0, no restart). Store the pair, or leave the timer off |
| Sleeve S refused to start: account | 4, once a day | `paper-s:refused-account` | `refuse_to_start` | Its account is sleeve Q's, or one of the two account numbers could not be read. Nothing ran. Check both key pairs |
| paper-s: a second runner refused to start | 4, once a day | `paper-s:second-runner` | `refuse_to_start` | Another sleeve S runner holds `paper-s-runner`. The second one exited. Nothing to do unless it repeats |
| Sleeve S stopped: not a paper account | 5, once a day | `paper-s:not-paper` | `refuse_to_arm` | The broker did not report a paper account. The session ended at once. Check the key pair |
| Sleeve S: no primary lease, entries off | 4 | `paper-s:lease` | `refuse_to_arm` | On the host the lease `wt-leases/paper-s` was not held. Exits are managed. See [backups-and-lease.md](backups-and-lease.md). Clears when a session holds it |
| Sleeve S: session close unknown | 5, once a day | `paper-s:close-unknown` | `close_unknown` | Neither the calendar nor the broker clock could be read. The runner stopped; resting GTC stops stay. Check the account |
| paper-s stopped by its stop rule | 4, once a day | `paper-s:stop-rule` | `stop_rule` | The pre-registered stop fired and latched. Entries stay off until a decision record changes `S.stop_rule` |
| Sleeve S adopted a position it did not open | 4, once a day | `paper-s:orphan` | `adopted_orphan` | A long position had no plan: it was stopped and sold at once. Never booked to the sleeve's book. Find where it came from |
| Sleeve S: a position over its hard caps | 5, once a day | `paper-s:over-caps` | `position_over_caps` | A long position larger than `S.max_qty` or `S.max_notional`: the desk cannot stop or sell it. Close it yourself |
| Sleeve S is SHORT | 5, once a day | `paper-s:short` | `short_position` | The account is short. The desk's orders in the name were cancelled; nothing is bought back. Follow [not-flat-at-close.md](not-flat-at-close.md) |
| Sleeve S skipped an entry: clock check failed | 4 | `paper-s:clock-skew` | `clock_skew` | The local clock is more than 2 s off the broker's, or could not be checked. Exits are unaffected. Clears on the next good check |
| Sleeve S NOT FLAT at the close | 5 | `paper-s:not-flat` | `END_OF_DAY_NOT_FLAT` | A long position is open after the close. One the desk owns keeps a GTC stop and is sold at the next open. Clears when a later close is verified flat |
| Sleeve S is SHORT at the close | 5 | `paper-s:short-at-close` | `END_OF_DAY_NOT_FLAT` | Short after the close. Nothing is bought back. Follow [not-flat-at-close.md](not-flat-at-close.md) |
| Sleeve S could not verify flat after the close | 5 | `paper-s:not-flat` | `END_OF_DAY_NOT_FLAT` | The broker could not be read after the close. Check the account |

Not paged for sleeve S (the job runner does these for paper B only): a latch found after the session, repeated loop
errors, and an exits-only start after a failed preflight. A failed preflight refuses `paper-s` outright; a position
it holds keeps its GTC stop until the next session that starts.
