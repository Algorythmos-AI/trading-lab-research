# DEC-0069: the QQQ rule is retired

- **Status: ACCEPTED on 2026-11-20** by the owner, in chat. Asked how far to go, the owner chose: "Retire it fully:
  a decision record retires the QQQ rule; its daily job is removed from the host schedule; history archived, not
  deleted". The owner's direction the same day: "we do not care about QQQ ... take that out of the picture
  completely". It takes effect in stages (section 3): the job stops with the release that carries this record.
- **What is retired:** Robot B's QQQ rule, also written "strategy B" and, since DEC-0066, "sleeve Q": the rule that
  reads QQQ and trades QQQM on paper (runner `wt.live.runner_b`, job `paper-b`, strategy tag `B`).
- **Kind:** an operating decision. It reads no result and judges none. It was not made from a P&L figure, and no
  P&L was viewed to write it.
- **Amends:**
  - DEC-0037, part 2 (the stop rule for strategy B). Item 7 of that record names what ends the rule's run: a record
    that "changes `B.stop_rule` or retires B". This is the record that retires B. The three triggers are no longer
    evaluated, because no session arms. `B.stop_rule` stays in `config/risk.yaml` as it was written; the stop date
    2027-01-30 passes with nothing to stop.
  - DEC-0062 ("Paper trading continues unchanged"). Paper trading of the QQQ rule ends. The verdict of DEC-0062 is
    not changed: it stays SUSPEND, as recorded, and is not upgraded to anything else by this record.
  - DEC-0066, section 1 (two sleeves). The table has no running sleeve Q any more. Its sentence "refuses if its
    account number equals sleeve Q's" is withdrawn (section 4). Everything else in DEC-0066 stands.
- **Does not amend:** DEC-0007, DEC-0011, DEC-0023, DEC-0024, DEC-0061, DEC-0063, DEC-0064. No rule, exit, size,
  limit, gate or frozen config of B is changed; they are simply no longer run. DEC-0063's fix stays in the code.
- **Trials:** none added, none removed. The global count stays at 87.

## 1. What stops

1. The host job `paper-b` leaves the schedule (`wt.ops.schedule.JOBS`). With it go its systemd unit and timer, its
   start after a reboot, its two dead-man checks, its exits-only start after a failed preflight, and the
   after-session checks the job runner made on its journal.
2. No paper session of the QQQ rule is run after the release that carries this record is deployed and the units
   are installed. A unit still installed between those two steps starts nothing: the job runner exits 0 for the
   name.
3. Nothing replaces it. The stock desk (Gap Hunter: `wt.live.runner_s`, job `paper-s`, DEC-0066) and the options
   clone are separate desks with their own records, and take over nothing of the QQQ rule's.

## 2. What stays, as an archive

1. **The results.** No trade, session, verdict or gate of the QQQ rule is re-scored, removed or read differently
   because of this record. The paper sample ends where it ended. Anything that counted it (G2 and its agreement
   measure, DEC-0037 part 1; the stop line) is read as of the last session that ran, and says so.
2. **The files.** The journal (`data/live/journal.jsonl`, hash-chained), the plan files (`data/live/plan_*.json`),
   the virtual account (`data/live/virtual_account.json`), the session logs (`logs/paper_b_*.log`) and the replay
   files stay where they are. Nothing deletes or moves them. They stay in the nightly backup, and the journal's
   chain is still verified and anchored: the history must remain checkable.
3. **The code.** `wt.live.runner_b` stays importable and its tests and replay checks (`scripts/replay_check_b.py`)
   still run. The stock desk imports four pure helpers from it. It has no job, and nothing in the schedule starts
   it. Starting it by hand would be trading the retired rule and is not done.
4. **The lease and lock names.** `wt-leases/paper-b` and the lock `paper-b-runner` keep their names; the deploy
   gate still reads the lock, so a runner started by hand would still hold up a deploy.
5. **The forward test's unit `B_qqq_qqqm`: it keeps running.** This is a choice, taken as the conservative one.
   - The forward test (`scripts/forward_test.py`) re-runs the frozen candidates on each day's delayed data. It
     places no order and reads no account. It is a different thing from the paper job.
   - `B_qqq_qqqm` is one of the units a session must complete (`required()` names it for every date), and the
     ledger is hash-chained with a marker per session and unit. Dropping the unit would change what a complete
     session is, part-way through the ledger, and would need its own rule for every reader of the ledger (the weekly
     scorecard, G2's agreement measure, the dashboard's split by strategy).
   - Stopping it is therefore a separate change with its own record, if the owner wants it. Until then the forward
     ledger goes on recording the unit, and that record is not evidence for restarting the rule.

## 3. Stages

| Stage | What | Who | State on 2026-11-20 |
|---|---|---|---|
| a | The release that carries this record removes the job. On the host: deploy, then install the units, which stops, disables and removes `wt-paper-b.service` and `wt-paper-b.timer` | owner | in this pull request; not yet released |
| b | The owner confirms the QQQ rule's paper account is flat (no position, no open order) | owner | open |
| c | The market-data jobs stop depending on that account's key pair (`APCA_API_KEY_ID`, `APCA_API_SECRET_KEY`), by a later change | a later pull request | not started |
| d | The owner deletes the paper account | owner | only after c |

- **Order of a and b.** Removing the job also removes the only thing that managed an open position of the rule
  (exits, the end-of-day flatten, the exits-only start). So b is checked **before** the release of stage a is
  deployed, and again after the units are installed. A position found then is closed by the owner in the broker's
  own interface. A resting stop order there is cancelled the same way.
- **Why d waits for c.** `wt.data.alpaca.AlpacaREST` reads `APCA_API_*` for every market-data job (the routine, the
  forward test, the pipeline check, the deploy gate and others). Deleting the account before those jobs read
  another pair would stop them all.
- The two dead-man checks `wt-paper-b` and `wt-paper-b-armed` are paused or deleted by the owner with stage a, or
  they page for a job that no longer exists.
- An alert of the retired job that is firing when it stops (`paper-b:*`, `job:paper-b`) is resolved by nothing
  afterwards: the job runner's after-session check was what cleared them. The owner looks at `make status` after
  stage a and clears any that remain. No command for that exists yet.

## 4. The stock desk's start-up guards

DEC-0066 section 1 had the stock desk refuse to start when its key was the QQQ rule's key or its account was the
QQQ rule's account. Those guards kept two running sleeves apart. With one of them retired they protect nothing,
and they would block stage c if the data pair is moved onto the stock desk's account.

From the release that carries this record:

- The desk still requires its own pair (`APCA_S_KEY_ID`, `APCA_S_SECRET_KEY`) and still never falls back to
  `APCA_API_*`. Without both it refuses to start, and the job runner refuses the job before that.
- It no longer refuses because `APCA_API_*` holds the same pair or belongs to the same account. It does not read
  that pair at all.
- The check that the account is a paper account is unchanged (the broker adapter's paper-only lock, and the
  session's own check).

## 5. Not decided here

- Whether the forward unit `B_qqq_qqqm` is ever stopped (section 2, item 5).
- Which key pair the market-data jobs read after stage c.
- What the dashboard shows for the retired rule. Its pages still read the archive's figures; the change to them is
  a separate pull request.
- Removing `wt.live.runner_b` or the `B` block of `config/risk.yaml`. Neither is removed.

## Notes

### 2026-11-20: which account, and stages b to d corrected

The owner pointed out that the account list holds three paper accounts and no "QQQ account". Checked read-only
the same day, against the broker and the journals (`docs/runbooks/paper-accounts.md`):

- `APCA_API_*` reaches "Robot B stocks (host)" (…Y7I) on the host and on the Mac. It holds no order of the QQQ
  rule: none of the nine entry orders in `data/live/journal.jsonl` (2026-10-19 to 2026-11-11) is found there, or
  in either other account. Until about 2026-11-17 the host's `APCA_API_*` pair belonged to "Manual options (mine)"
  (…ISF), and the rule traded there. The owner deleted that account on 2026-11-20, so its orders exist only in the
  repo's records. "The QQQ rule's paper account" in this record means the account behind `APCA_API_*`; only its
  last weeks were spent in …Y7I, without a trade.
- **Stage b: done.** …Y7I's one AAPL share (bought by hand on 2026-04-16) was sold by the owner on 2026-11-20. All
  three accounts have no position and no open order.
- **Stages c and d: withdrawn.** The owner keeps all three accounts: none is deleted, renamed or reset. The
  market-data jobs go on reading `APCA_API_*`, which stays on …Y7I. No job places an order with it.
- Section 4's reason ("they would block stage c") no longer applies; the guards stay removed, since they still
  protect nothing.
