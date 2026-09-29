# Kill switch and flatten

**Stop new entries.** Exits and stops keep being managed:

```
make -C ~/trading kill REASON="why"
```

The runner checks `~/trading/KILL` on every loop, so this takes effect at once. Undo it with
`make -C ~/trading unkill`.

**Flatten now:**
1. **Cancel orders first.** Cancel the `wt-B-…` orders in the Alpaca UI, so a stop can't fill *after* your sell
   and open a short.
2. Sell the position in the Alpaca UI.
3. Leave the kill switch on until you've read the logs.
