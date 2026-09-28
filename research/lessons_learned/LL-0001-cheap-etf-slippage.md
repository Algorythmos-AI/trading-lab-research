# LL-0001 — Affordable ETFs change the cost math

Trading SPY signals through SPYM (≈1/7 price) multiplies relative slippage ~7×: strategy B's edge fell from
+0.11R to +0.05R and lost significance. QQQM (≈1/2.3 price) keeps B's edge. Rule: always backtest with
slippage expressed on the instrument that will actually be traded at the account's size.
