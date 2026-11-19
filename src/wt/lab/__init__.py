"""The options lab (DEC-0060): a tape of the focus names' option and stock quotes, and execution measured on it.

Walled off from trading: nothing here imports `wt.live`, `wt.oms`, `wt.brokers`, `wt.owner` or `wt.webull`, or the
options selection and EXP-0037 replay modules, and nothing outside `wt.lab` imports it
(tests/unit/test_lab_boundary.py). It sends no order and reads no account.
"""
