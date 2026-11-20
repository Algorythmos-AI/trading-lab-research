# Loss latch reset

> **2026-11-20 (DEC-0069):** this is the QQQ rule's virtual account (`data/live/virtual_account.json`). The rule is
> retired and no job trades that account, so there is nothing to resume. The page is kept for the archive. The stock
> desk's book (`var/smallcap/virtual_account.json`) has no reset command.

The virtual account latches at a −2% day, a −4% week, or a −10% drawdown from its high-water mark. While
latched, it refuses new entries.

- The latch survives restarts.
- Deleting or editing `data/live/virtual_account.json` makes the runner **refuse to arm**. It does not clear the
  latch.

**To resume:**
1. Review the trades that tripped it (the Strategies page, or `trade_closed` rows in the journal).
2. Run:
   ```
   make -C ~/trading reset-latch REASON="what you reviewed and why it is safe to resume"
   ```
3. The reset is recorded in the account's `latch_history`.
