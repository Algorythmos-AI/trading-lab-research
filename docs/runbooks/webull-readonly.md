# Webull, read only, on the host

What runs ([ADR 0011](../adr/0011-webull-readonly-host.md)):

| Unit | User | Holds | Does |
|---|---|---|---|
| `wt-webull-pull.timer` | | | every 2 minutes 09:00 to 16:58 New York on weekdays, and 17:40 every day |
| `wt-webull-pull.service` | `wt-webull` | the Webull key (credential) | runs the root-owned copy in `/opt/wt-webull` with `/usr/bin/python3 -I -S -B`; reads orders, balance, positions into `/var/lib/wt-webull/out` |
| `wt-webull-publish.service` | `wt` | the dashboard key | builds the journal and, while `var/webull/PUBLISH_ON` exists, sends it to the Trades page; pages on state changes |
| `wt-dashboard` (existing) | `wt` | | also runs the Webull watch: pages when no good read has come for too long |

The client can only read: an order request is refused before it is sent, and a redirect is never followed. Logs say
counts and outcomes, nothing else.

`var/webull/PUBLISH_ON` (in the checkout, beside the publisher's other state) is an operational switch for the
cutover, not a security control: any member of group `wt` can create it. Without it every publish is a dry run
that says what it would send and keeps no money seed.

## The cutover (once, owner, one evening after the close)

Never run the cloud sync and the host side by side: step 2 stops the cloud for good before the host reads anything.

1. **Merge and deploy.** Merge the pull request and its Release PR. This release changes owner paths (units, host
   helpers, `src/wt/webull`), so the hourly deploy leaves it to you: on the host, once the gate opens (2 hours after
   the close at the earliest, and never within 60 minutes of a job start),
   `sudo -u wt /usr/local/bin/wt-deploy deploy`.
2. **Reset the key.** In the Webull app or website, **API Keys Management**, press **Reset Key** on the existing key.
   This makes a new App Secret and kills the old one everywhere, the cloud copy included: the cloud sync stops, and
   the journal it last sent is now fixed. Keep the page open.
3. **Put the key on the host and install.** `sudo wt-set-webull-secret`: paste the App Key and the new App Secret
   (nothing shows while typing). It creates `wt-webull`, blocks it from the metadata server, and writes
   `/etc/wt/webull.env` (root 0600). Then, **on your Mac**, take the tree hash of the merged code straight from git
   (nothing from the repository runs):

   <!-- webull-tree-hash -->
   ```
   git -C ~/trading fetch -q origin
   r=~/trading c=origin/main; git -C "$r" ls-tree --name-only "$c" src/wt/webull/ | grep '/[^./][^/]*\.py$' | LC_ALL=C sort | while read -r f; do printf '%s  %s\n' "$(git -C "$r" show "$c:$f" | shasum -a 256 | cut -d' ' -f1)" "${f##*/}"; done | shasum -a 256 | cut -d' ' -f1
   ```

   On the host: `sudo wt-install-units --webull-tree <that hash>`. Root stages the checkout's `src/wt/webull`
   (refusing links), hashes the stage itself, checks `wt-webull` can import it, and installs it in `/opt/wt-webull`
   only on an exact match; otherwise it says why and leaves the installed copy as it was. Without
   `--webull-tree` it never touches `/opt/wt-webull`. The timer turns on only once the key file exists and the
   copy loads.
4. **First read.** `sudo systemctl start --no-block wt-webull-pull.service`, then approve the sign-in prompt in the
   Webull app within 5 minutes (**Menu > Messages > OpenAPI Notifications**). `journalctl -u wt-webull-pull -f`
   shows `backfill: N days read, complete=...` after about 15 minutes. The history is longer than one run's
   budget, so it may take two runs: if `/var/lib/wt-webull/out/history.json` says `"complete":false`, start the
   service once more (it goes on from where it stopped).
5. **Parity.** `sudo -u wt bash -c 'cd /home/wt/trading && set -a && . /run/wt-secrets/env && set +a && PYTHONPATH=src .venv/bin/python -m wt.webull.publish --parity'`.
   It compares the host's journal with the cloud's last one on the site: the trades (by their own fields, not
   ids), open lots, fills, the last fill and the net of transfers. It prints up to 20 differing trades a side and
   writes `var/webull/parity.json`. Exit 0 means exact. The trades are the real check: the money total is seeded
   from the site's own history, so it is not independent, and the account value is shown but not compared (it
   moves with the market).
6. **Publish.** If it is exact: `sudo -u wt touch /home/wt/trading/var/webull/PUBLISH_ON`. The next publish (after
   the next pull, or `sudo systemctl start wt-webull-publish.service`) keeps the money seed and sends:
   `journalctl -u wt-webull-publish` shows `money seed kept` and `sent`. Check the Trades page: lifetime result,
   open lots and money history read as before. If parity was not exact, stop here and look at the rows.
7. **Retire the cloud.** Remove `WEBULL_APP_KEY` and `WEBULL_APP_SECRET` from the Radar cloud environment and from
   the Mac's `~/trading/.env`; then the two cloud Webull routines (intraday sync and the 21:38 UTC backstop) are
   retired. After step 2 they can only fail.

**Rollback:** `sudo -u wt rm /home/wt/trading/var/webull/PUBLISH_ON`. The host stops sending and the page keeps the
last journal. To take the key off the host as well, see the end of this page.

**The metadata block on an existing host.** cloud-init blocks `wt` and `wt-webull` from the metadata server only on a
host's first boot. `wt-set-webull-secret` adds the `wt-webull` rule itself, idempotently; to check or add it by hand:

```
sudo iptables -C OUTPUT -d 169.254.169.254/32 -p tcp --dport 80 -m owner --uid-owner wt-webull -j REJECT \
  || { sudo iptables -I OUTPUT 1 -d 169.254.169.254/32 -p tcp --dport 80 -m owner --uid-owner wt-webull -j REJECT \
       && sudo netfilter-persistent save; }
```

## When it pages

The pull exits 0 when a read fails; the publisher pages once when a state starts, once more if it still holds after
30 minutes, and once when it clears. `/var/lib/wt-webull/out/status.json` says `state` (`ok`, `failing`,
`approval`), `since`, `last_ok` and `reason`.

- **`Webull reads failing`**: the network, a timeout, Webull's side (`kind: transient`) or Webull refusing
  (`kind: error`, for example `HTTP 403`: the key was reset or disabled; run `sudo wt-set-webull-secret` with the
  current values). `journalctl -u wt-webull-pull` says which. Nothing to do for a transient: it clears itself.
- **`wt-webull-pull` failed, journal says `needs the owner`**: a new token is waiting (paged once per token).
  Approve it in the Webull app within 5 minutes, then `sudo systemctl start wt-webull-pull.service`. If the 5
  minutes passed, the job asks again after 6 hours; to ask now, `sudo rm /var/lib/wt-webull/token.json` and start
  it. Until then status.json says `approval` and the journal is not refreshed.
- **`Webull code not as installed`** (drift): the checkout's `src/wt/webull` and `/opt/wt-webull` differ, or the
  copy is missing. Take the hash of the merged commit on your Mac (cutover step 3), then
  `sudo wt-install-units --webull-tree <hash>`. Never install without comparing: that is the whole control.
- **`Webull journal not sent`**: a send failed, the ingest secrets are missing, or the site's money history could
  not be carried over (`journalctl -u wt-webull-publish`). It tries again every run.
- **`Webull reads stopped`**: the dashboard job saw no good read for 30 minutes in the session (26 hours
  otherwise): the timer is off, the unit's condition failed, or the pull never finishes.
- **`Webull journal superseded`**: the site holds a journal newer than the host's, so something else writes it.
  Check that the cloud routines are retired (cutover step 7).
- **`Webull holdings disagree`**: the journal's open lots and Webull's positions have disagreed for 10 minutes.
  Usually a fill the history has not caught up with (days that hold a working order are read again every run). If
  it stays, compare the Trades page's open lots with the app.
- **`wt-webull-publish` failed, `could not read the journal the site shows now`**: only on the first real send.
  Check the dashboard key (`make status`), then start `wt-webull-publish.service`. To start the money history
  afresh on purpose instead: `sudo -u wt env PYTHONPATH=src .venv/bin/python -m wt.webull.publish --fresh-money`
  (from the checkout, with the secrets loaded: `set -a; . /run/wt-secrets/env`).

## Checks

```
systemctl list-timers wt-webull-pull.timer
sudo ls -l /etc/wt/webull.env /var/lib/wt-webull /opt/wt-webull/wt/webull   # root 0600; wt-webull 0750; root 0644
cat /var/lib/wt-webull/out/status.json /var/lib/wt-webull/out/history.json
cat /home/wt/trading/var/webull/status.json /home/wt/trading/var/webull/reconcile.json
```

Turning it off: `sudo systemctl disable --now wt-webull-pull.timer`. Removing the key: delete `/etc/wt/webull.env`
and reset the key in Webull; `wt-install-units` then leaves the timer off.
