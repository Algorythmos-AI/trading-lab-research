"""Client order ids: wt-<strategy>-<yyyymmdd>-<sha1(date|strategy|symbol|leg|seq)[:12]>.

Every submission gets its own id (audit H2). The per-plan sequence number is persisted with the plan, so a retry,
a re-stop or a second exit attempt never reuses an id the broker already holds. The strategy is part of the prefix
(audit M5), so reconciliation only ever touches its own strategy's orders.
"""
from __future__ import annotations

import hashlib
import re

PREFIX = "wt"
_STRAT = re.compile(r"[^A-Za-z0-9]")


def _tag(strategy: str) -> str:
    return _STRAT.sub("", strategy)[:8] or "X"


def coid(date: str, strategy: str, symbol: str, leg: str, seq: int = 0) -> str:
    h = hashlib.sha1(f"{date}|{strategy}|{symbol}|{leg}|{seq}".encode()).hexdigest()[:12]
    return f"{PREFIX}-{_tag(strategy)}-{date.replace('-', '')[:8]}-{h}"


def is_ours(client_order_id: str | None, strategy: str | None = None) -> bool:
    if not client_order_id:
        return False
    if strategy is None:
        return client_order_id.startswith(PREFIX + "-")
    return client_order_id.startswith(f"{PREFIX}-{_tag(strategy)}-")
