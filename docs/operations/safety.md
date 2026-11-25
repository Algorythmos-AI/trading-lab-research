# Safety controls: paper-only lock, kill switches, latches

Checked against the code at `9441a547` on 2026-11-25. Each fact names the file it comes from. If the code
changes, the code is right and this page is out of date: fix this page in the same pull request.

## 1. Paper only

Three layers keep orders away from a live account.

| Layer | What it does | Where |
|---|---|---|
| Hard-coded paper client | Every Alpaca trading client is built with `paper=True` | `src/wt/brokers/alpaca_paper.py`, `alpaca_options_paper.py`, `alpaca_read.py` |
| The paper-only lock | Refuses unless `MODE` is `paper`, `LIVE_TRADING_ENABLED` is not true, the trading URL (and `APCA_API_BASE_URL` if set) is exactly `https://paper-api.alpaca.markets`, and the account number starts with `PA`. All four are checked when an adapter is built; before every order, `place()` checks the environment part again (`MODE`, `LIVE_TRADING_ENABLED`, `APCA_API_BASE_URL`) | `src/wt/core/safety.py` |
| `MODE` is set per job | `wt.ops.jobs` starts each job's process with that job's `MODE`. The runners also refuse to start unless `MODE=paper` | `src/wt/ops/jobs.py` (`run_child`), `src/wt/live/runner_s.py`, `src/wt/live/runner_o.py` |

On a host with `WT_ROLE=shadow`, Gap Hunter (and the retired QQQ runner) wrap their broker in `ShadowBroker`, which
raises on every order, cancel and replace call (`src/wt/brokers/shadow.py`, `runner_s.py`). **The options clone does
not read `WT_ROLE`.** On a shadow host its kill file blocks only new entries; a plan it already holds still manages
its exits and can send paper exit orders. A shadow run is order-free for the clone only if the clone holds nothing,
or if `wt-paper-o` is not running.

`MODE`, `LIVE_TRADING_ENABLED` and any live key belong to the owner alone ([AGENTS.md](../../AGENTS.md), rule 1).

## 2. Kill switches: one file per desk

Paths below assume `WT_STATE` is unset, as it is on the host (`STATE_DIR` defaults to `var/`, `src/wt/core/config.py`).
A kill file stops **new entries**. While it exists, the desk keeps managing exits and protective stops. Each desk reads its
own file, and **no single file stops every desk**.

| Desk | Job | File it reads (on the host, under `/home/wt/trading`) | Read by | Turn on | Turn off |
|---|---|---|---|---|---|
| Gap Hunter (stock desk, "sleeve S") | `paper-s` | `var/smallcap/KILL` **only** | `src/wt/live/runner_s.py` (`KILL = DIR / "KILL"`) | no `make` target, see below | `sudo -u wt rm /home/wt/trading/var/smallcap/KILL` |
| Options clone | `paper-o` | the root `KILL` **or** `var/options/KILL` | `src/wt/live/runner_o.py` (`KILLS`) | `make kill REASON="…"` (root) or `make kill DESK=options REASON="…"` | `make unkill` (root) or `make unkill DESK=options` |
| Retired QQQ rule (DEC-0069) | none | the root `KILL` | `src/wt/live/runner_b.py` | — | — |

**The root `KILL` does not stop Gap Hunter.** `make kill` without `DESK=options` writes the root file
(`Makefile`, target `kill`), and `DESK=stocks` or any other value also writes the root file. To stop Gap Hunter's
entries on the host:

```bash
sudo -u wt sh -c 'mkdir -p /home/wt/trading/var/smallcap && echo "why ($(date))" > /home/wt/trading/var/smallcap/KILL'
```

To stop every desk, write both files. Gap Hunter re-reads its file on every loop of its session (`runner_s.py`).
The clone checks its files each time it builds the pre-trade context for an entry (`runner_o.py`, `killed()`).
Either way, a change takes effect without a restart.

### What records it, and what shows it

- **Audit log.** `make kill` (root file) writes a `kill_on` entry to the hash-chained audit log (`wt.ops.audit`). It
  runs with `|| true`, so a failed write is not reported (`Makefile`, target `kill`). `make unkill` removes the root
  file through `wt.ops.control unkill`, which takes the runner lock and writes `kill_off`.
- **Not audited.** `make kill DESK=options`, `make unkill DESK=options` (a plain `rm -f`, with no lock check) and a
  hand-written `var/smallcap/KILL` write no audit entry. Gap Hunter logs `kill_state` in its own journal.
- **`make status` reads only the root file.** It prints `KILL switch: ON (no new entries)` when only the root file
  exists (`src/wt/ops/jobs.py`, `status`), even while Gap Hunter can still enter.
- **The forward-test summary's "new entries are paused" line** also reads only the root file.
- **The dashboard.** Its top-level kill flag reads the root file (`src/wt/ops/publish.py`); Gap Hunter's own panel
  shows its own file.

**Check each desk's file before you trust a stop.**

## 3. Loss latches

A latch stops entries until it is cleared on purpose. Only the owner clears one.

| Desk | Clear with | Notes |
|---|---|---|
| Gap Hunter | `make reset-latch-s REASON="DEC-NNNN: why"` | Refuses while `paper-s` or its runner holds a lock. A stop-rule (DEC-0066) or execution-stop (DEC-0073) latch is cleared only by a reason that names a new decision record (`src/wt/ops/control.py`) |
| Options clone | `make reset-options-latch KIND=day\|week\|drawdown REASON="…"` | `wt.live.runner_o reset-latch` |
| Retired QQQ rule | `make reset-latch REASON="…"` | Clears that rule's virtual account. Nothing trades it now (DEC-0069) |

See [latch-reset.md](../runbooks/latch-reset.md) and [options-clone.md](../runbooks/options-clone.md).

Gap Hunter trades on the host only while the host holds its `APCA_S_*` keys. Without them, `paper-s` is refused at
its preflight (`src/wt/ops/jobs.py`). The last recorded check of the host's keys, on 2026-11-20
([paper-accounts.md](../runbooks/paper-accounts.md)), found them not set. Release #589 of 2026-11-22 is titled
"Gap Hunter goes live", so treat Gap Hunter as **able to trade** until you have checked. **(host state, unverified
2026-11-25)**

## 4. Flatten

A kill file stops only new entries. The running desk keeps protecting what it holds: Gap Hunter re-places a
missing stop on every loop (`protect()` in `runner_s.py`), and the clone keeps managing its exits. So **stop the
desk's runner before you touch its orders**, or a stop you cancel can come back and open a short after your sell.

1. Turn the desk's kill file on (section 2), so a restart cannot enter.
2. **(owner)** Stop the desk's runner: `sudo systemctl stop wt-paper-s` (Gap Hunter) or
   `sudo systemctl stop wt-paper-o` (the clone). The job runner forwards the stop to the desk and exits 143
   (`src/wt/ops/jobs.py`), so the unit may page as failed. Resting orders stay at the broker; the runner does not
   cancel them on the way out. Its timer starts it again at the next session;
   the kill file keeps that session from entering.
3. In the Alpaca paper UI of the desk's account (see [paper-accounts.md](../runbooks/paper-accounts.md)), cancel
   the desk's open orders **first**. Each desk's client order ids start with `wt-<tag>-` (`src/wt/core/ids.py`):
   - `wt-S-` for Gap Hunter;
   - `wt-O-` for the options clone.
4. Close the position.
5. Leave the kill file on until you have read the session's logs.
