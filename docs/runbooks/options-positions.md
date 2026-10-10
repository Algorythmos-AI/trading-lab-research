# Options desk: paper positions

The Options desk's **Paper positions** pane shows the open option positions of a second Alpaca **paper** account,
kept for option trades the owner places by hand. Strategy B's account, its virtual ledger and its mandate check
never see that account.

| Part | Where | What it does |
|---|---|---|
| `wt-options-live.timer` | the VM | every 5 minutes in the US session, every 15 otherwise |
| `wt.options.live` | the job | reads positions and the market clock (GET only, paper host), signs and sends |
| `stocksdelta/options-live` | the dashboard | stored latest-only; the pane reads it |

The job is read only. `OptionsAccount` has two methods, `positions` and `clock`, and the host name is a constant.
It never places, changes or cancels an order. Only the primary host's document is stored.

What is sent: per open option contract, the OCC symbol, the quantity, the average price, the mark, the market
value and the unrealised result; and the market clock. Never the account number, balances, buying power, stock
positions or orders. The job's log line carries a count of positions and nothing else.

## Setting it up (owner)

1. In Alpaca, create a second paper account and generate its key pair.
2. On the VM: `sudo wt-set-secrets`. Press Enter at every prompt except `APCA_OPTIONS_KEY_ID` and
   `APCA_OPTIONS_SECRET_KEY`. Never paste the values anywhere else.
3. Deploy the release and install the units, as in `gcp-host.md` ("Deploying (owner)").
4. Check: wait one timer tick, then
   `tail -n 3 logs/options_live_$(date -u +%Y%m%d).log` (in the checkout) should end with `sent: True`, and `/api/health` should show
   `editions.options_live.status: "ok"`.

Until step 2 the job runs, prints "not configured" and exits 0. Nothing is sent and the pane stays absent.

## When something is off

| What you see | Meaning | What to do |
|---|---|---|
| Pane absent | nothing published yet, or the last document is older than 36 hours | the job's log, `logs/options_live_<date>.log`; `journalctl -u wt-options-live -n 20` shows only start and exit |
| "These are N minutes old" | the host has not sent for 30 minutes while the market is open | same; check the alert `job:options-live` |
| Log: `could not be read (keys-rejected)` | the key pair is wrong or was regenerated | `sudo wt-set-secrets` with the new pair |
| Log: `could not be read (http-5xx / network-…)` | Alpaca or the network | it retries on the next tick; two failures in a row alert |
| A position is missing | it is a stock position or an adjusted contract; the document's `problems` counts them | expected: the desk lists standard option contracts only |

A fault that lasts fails the unit on every run from the second on, so it pages each time until it is fixed or the
timer is stopped, as the stocks publisher does.

When the account cannot be read the job sends nothing, so the desk never shows "no positions" by mistake.

To stop it: `sudo systemctl disable --now wt-options-live.timer` (owner). The pane disappears after 36 hours.
