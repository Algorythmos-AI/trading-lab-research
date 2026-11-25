# Loss latch reset

**You'll see:** ntfy priority 5 "loss limit latched", and the desk takes no new entries.

A latch survives restarts. Only the owner clears one, each desk with its own command, run on the GCP host as the
`wt` user (`sudo -u wt make -C /home/wt/trading …`). See [safety.md](../operations/safety.md).

| Desk | Latch file | Clear with |
|---|---|---|
| Gap Hunter | `var/smallcap/virtual_account.json` | `make reset-latch-s REASON="DEC-NNNN: why it is safe to resume"` |
| Options clone | the clone's latches (`day`, `week`, `drawdown`) | `make reset-options-latch KIND=day\|week\|drawdown REASON="…"` |
| Retired QQQ rule (DEC-0069) | `data/live/virtual_account.json` | `make reset-latch REASON="…"` |

**Gap Hunter.**
- `reset-latch-s` refuses while `paper-s` or its runner holds a lock.
- A latch from its stop rule (DEC-0066) or an execution stop (DEC-0073) is cleared only by a reason that names a new
  decision record (`src/wt/ops/control.py`). Write that record first.

**The retired QQQ rule.** Its virtual account latched at a −2% day, a −4% week or a −10% drawdown. Deleting or
editing `data/live/virtual_account.json` made its runner refuse to arm; it did not clear the latch. No job trades
that account now, so this reset has no everyday use.

**To resume:**
1. Review the trades that tripped the latch (the desk's page, or the `trade_closed` rows in its journal).
2. Run the desk's command above, with a reason.
3. The reset is recorded in the account's latch history.
