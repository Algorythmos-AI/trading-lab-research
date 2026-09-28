"""Scope rules for K0 (single source of truth, used by inventory and batching)."""
from __future__ import annotations

DEEP_TOP = {
    "WAHEGURU DAY TRADING 🌞☀️ ", "VWAP Playbook (X post)", "SET UP", "TECHNICAL INDICATOR",
    "Candles Information ", "ATR", "WHEN TO BUY - LONG POSITION", "TREND BASES EXTENSION ",
    "Economic Event", "NEWS", "HIGH FREQUENCY TRADING & BOOK", "Imgaes 21 Jan 2024",
    "WAHEGURU options & henry💰👱‍♂️",
}
OUT_TOP = {
    "PE - PRICE TO EARNINGS": "fundamentals", "PS - PRICE TO SALES": "fundamentals",
    "EARNING PER SHARE ": "fundamentals", "DIVIDENDS": "fundamentals",
    "WHAT IS EARNING REPORT": "fundamentals", "Long Term Investment ": "long-term investing",
    "WAHEGURU crypto mining": "crypto (not tradable via Webull)", "WAHEGURU ark invest": "long-term investing",
    "INVOICE": "personal admin",
}


def top_of(path: str) -> str:
    return path.split("/", 1)[0] if "/" in path else "(root)"


def classify(path: str, doc_type: str) -> tuple[bool, str]:
    """Return (in_deep_scope, reason)."""
    top = top_of(path)
    if top in DEEP_TOP:
        return True, "deep: day-trading folder"
    if top == "(root)":
        if doc_type == "image":
            return True, "deep: root chart screenshot"
        return False, "root non-image"
    if top in OUT_TOP:
        return False, OUT_TOP[top]
    return False, "inventory-only folder (secondary)"


def source_family(path: str) -> str:
    p = path.upper()
    if "WARRIOR" in p:
        return "warrior_trading"
    if "HENRY" in p:
        return "henry_options"
    if "KENON GRACE" in p or "KENAN GRACE" in p:
        return "kenan_grace_discord"
    if "ALPHA TRADER" in p:
        return "alpha_trader"
    if "LESSON LEARNED" in p or "JOURNAL" in p or "STATEMENT" in p or "👎" in path or "👍" in path:
        return "own_journal"
    if "VWAP PLAYBOOK" in p or "X POST" in p or "BENZINGA" in p:
        return "blog_x"
    if "BOOK" in p:
        return "book"
    return "own_notes"
