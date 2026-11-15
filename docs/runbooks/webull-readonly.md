# Webull, read only, on the host

What runs ([ADR 0011](../adr/0011-webull-readonly-host.md)):

| Unit | User | Holds | Does |
|---|---|---|---|
| `wt-webull-pull.timer` | | | every 2 minutes 09:00 to 16:58 New York on weekdays, and 17:40 every day |
| `wt-webull-pull.service` | `wt-webull` | the Webull key (credential) | reads orders, balance, positions into `/var/lib/wt-webull/out` |
| `wt-webull-publish.service` | `wt` | the dashboard key | builds the journal and sends it to the Trades page |

The client can only read: an order request is refused before it is sent. Logs say counts and outcomes, nothing else.

## Moving the key to the host (once, owner)

Do it after the US close on a weekday, so the evening run has time for the backfill.

1. Merge the Release PR that carries this change. Then, on the host after the close:
   `sudo -u wt /usr/local/bin/wt-deploy deploy` (or wait for the automatic deploy; this release changes units,
   so it waits for you) and `sudo wt-install-units`. The Webull timer stays off: there is no key yet.
2. In the Webull app or website, open **API Keys Management** and press **Reset Key** on the existing key. This
   makes a new App Secret and kills the old one everywhere, including the cloud copy. Keep the page open.
3. On the host: `sudo wt-set-webull-secret`. Paste the App Key and the new App Secret (nothing shows while typing).
   It creates the `wt-webull` user, writes `/etc/wt/webull.env` (root 0600) and checks that the job can load.
4. `sudo wt-install-units` again. It now sees the key and enables `wt-webull-pull.timer`.
5. Start the first read by hand: `sudo systemctl start --no-block wt-webull-pull.service`, then within 5 minutes
   approve the request in the Webull app (**Menu > Messages > OpenAPI Notifications**).
   `journalctl -u wt-webull-pull -f` shows `backfill: N days read, complete=True` (about 10 to 15 minutes), then
   `journalctl -u wt-webull-publish` shows `money seed kept` and `sent`.
6. Open the Trades page. The lifetime result, the open lots and the money history should read as before.
7. Remove `WEBULL_APP_KEY` and `WEBULL_APP_SECRET` from the shared cloud environment ("Radar") in the Claude
   environment settings. Ask the project to retire the two cloud Webull routines (intraday sync and the 21:38 UTC
   backstop). After step 2 they can only fail.

## When it pages

- **`wt-webull-pull` failed, journal says `needs the owner`**: a new token is waiting. Approve it in the Webull app
  within 5 minutes, then `sudo systemctl start wt-webull-pull.service`. If the 5 minutes passed, the job asks again
  after 6 hours; to ask now, `sudo rm /var/lib/wt-webull/token.json` and start it.
- **`wt-webull-pull` failed with `error: Webull HTTP 401` or `403`**: the key was reset or disabled. Run
  `sudo wt-set-webull-secret` with the current values.
- **`wt-webull-publish` failed, `could not read the journal the site shows now`**: only on the first run. Check the
  dashboard key (`make status`), then start `wt-webull-publish.service`. To start the money history afresh on purpose
  instead: `sudo -u wt env PYTHONPATH=src .venv/bin/python -m wt.webull.publish --fresh-money` (from the checkout,
  with the secrets loaded: `set -a; . /run/wt-secrets/env`).
- **`warn: open lots and Webull's positions disagree`**: the journal and Webull disagree on what is held. Usually an
  order the history has not caught up with; it clears on the next read. If it stays, compare the Trades page's open
  lots with the app.

## Checks

```
systemctl list-timers wt-webull-pull.timer
sudo ls -l /etc/wt/webull.env /var/lib/wt-webull           # root 0600; wt-webull 0750; token.json 0600
cat /var/lib/wt-webull/out/status.json /var/lib/wt-webull/out/history.json
cat /home/wt/trading/var/webull/reconcile.json
```

Turning it off: `sudo systemctl disable --now wt-webull-pull.timer`. Removing the key: delete `/etc/wt/webull.env`
and reset the key in Webull; `wt-install-units` then leaves the timer off.
