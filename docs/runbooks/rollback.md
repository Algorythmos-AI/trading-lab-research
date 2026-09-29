# Rollback a deploy

Every `make deploy` tags the commit it replaced as `runtime-YYYYMMDD-N`. The tag list is in
`var/deploy/*.json` and on the Operations page.

```
make -C ~/trading gate                              # must say OPEN (no job running, outside the trading night)
make -C ~/trading rollback TAG=runtime-YYYYMMDD-N
```

Rollback behaves like this:
- It refuses while a position is open.
- When the account is flat, it cancels this repo's resting orders first. Older code doesn't know about GTC stops.
- It re-syncs the venv and runs the smoke tests.
- If the launchd agents changed between the two versions, it prints `make install-trading-agents`.
