"""Deterministic, idempotent client order ids: <prefix>-<sha1(date|strategy|symbol|leg|attempt)[:16]>."""
from __future__ import annotations

import hashlib

PREFIX = "wt"


def coid(date: str, strategy: str, symbol: str, leg: str, attempt: int = 0) -> str:
    h = hashlib.sha1(f"{date}|{strategy}|{symbol}|{leg}|{attempt}".encode()).hexdigest()[:16]
    return f"{PREFIX}-{h}"


def is_ours(client_order_id: str | None) -> bool:
    return bool(client_order_id) and client_order_id.startswith(PREFIX + "-")
