# Trading decision: postopen-scan

- **timestamp:** 2026-07-01T22:53:20+10:00
- **tag:** postopen-scan

## Details
- **goal**: post-open gap-and-go execution
- **outcome**: safety-abort
- **abort_reason**: market_is_open=false at the account check; the task fired 51 minutes before the open.
- **order_id**: null
