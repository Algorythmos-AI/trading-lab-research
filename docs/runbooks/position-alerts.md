# Position and session alerts from the paper runner

These fire during the session, not only after it (the runner pages through a background queue, so an alert can
never delay an exit).

## "Paper B adopted a position it did not open" (priority 4, key `paper-b:orphan`)
- **Meaning:** QQQM was held and no plan explains it (a manual buy, or a plan file lost). The runner took it over
  as an `orphan` plan: it placed a stop, and exits it at the open (at once if the session is under way).
- **Not booked:** an orphan's close is journaled (`trade_closed`, `origin: orphan`) but never counted in B's
  virtual account or G2.
- **Do:** find out where it came from (Alpaca order history). If it was yours, nothing else to do.

## "Position outside strategy B's mandate" (priority 3, once a day, key `paper-b:out-of-mandate:<SYMBOL>`)
- **Meaning:** the paper account holds a symbol B never trades (B's allowlist is in `config/risk.yaml`). The runner
  never touches it, and it no longer blocks `make rollback`.
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
