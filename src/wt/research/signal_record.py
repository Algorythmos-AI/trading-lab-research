"""The Options desk's sealed signal record (DEC-0051 section 3), version 1, read strictly in Python.

A line-for-line mirror of `parseSignalRecord` in dashboard/src/lib/signal-record.ts: exactly the keys of the record's
mode at every level, every enum one of its own words, every instant a canonical ISO time (`toISOString` form, with
milliseconds and `Z`). Anything else reads as None; it never raises. The EXP-0034 read script reads records only
through `parse_signal_record`. Pure: no I/O and no clock.
"""
from __future__ import annotations

import json
import math
import re
from collections.abc import Callable, Sequence
from datetime import datetime, timezone
from typing import Any

SIGNAL_RECORD_V = 1
SIDES = ("call", "put")
ROW_STATES = ("no_trade", "watch", "get_ready", "enter_zone", "plan_off", "missed", "paused")
WORDS = ("CALL", "PUT", "WAIT", "NO TRADE")
LIFECYCLE = ("developing", "confirmed", "weakening", "invalidated")
SCORING = ("a", "b", "not_usable", "gate_unavailable", "contract_failed")
MISSING = ("market_direction", "volume", "stock_bid_ask", "shock", "contract", "enter_zone")
DIRECTIONS = ("up", "down", "range")
CHECKS = ("listed", "quote", "premium", "bid_ask", "volume", "delta")
NO_CONTRACT = ("no-chain", "other-name", "not-opra", "no-expiry", "no-strikes", "none-passed")
STATUSES = ("ok", "wrong-day", "no-focus", "degraded")
DEGRADED = ("edition-missing", "edition-error", "store-timeout", "bad-symbol", "bars-off", "bars-failed",
            "bars-timeout", "bars-unsettled", "snapshot-off", "snapshot-failed", "snapshot-timeout")
DAY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
SYMBOL = re.compile(r"^[A-Z][A-Z0-9.]{0,9}$")
HEX64 = re.compile(r"^[0-9a-f]{64}$")
_ISO = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")

Check = Callable[[Any], bool]


def _obj(v: Any) -> bool:
    return type(v) is dict


def _exact(v: Any, keys: Sequence[str]) -> bool:
    return _obj(v) and len(v) == len(keys) and all(k in v for k in keys)


def _str(v: Any) -> bool:
    return type(v) is str


def _num(v: Any) -> bool:
    return type(v) in (int, float) and math.isfinite(v)


def _num_n(v: Any) -> bool:
    return v is None or _num(v)


def _str_n(v: Any) -> bool:
    return v is None or _str(v)


def _bool_n(v: Any) -> bool:
    return v is None or type(v) is bool


def iso(v: Any) -> bool:
    """A canonical `Date.toISOString()` instant: 2026-11-13T14:32:00.000Z, and a real one."""
    if not _str(v) or not _ISO.match(v):
        return False
    try:
        datetime.strptime(v, "%Y-%m-%dT%H:%M:%S.%fZ")
    except ValueError:
        return False
    return True


def _iso_n(v: Any) -> bool:
    return v is None or iso(v)


def _one_of(items: Sequence[str], v: Any) -> bool:
    return _str(v) and v in items


def _strs(v: Any) -> bool:
    return type(v) is list and all(_str(x) for x in v)


def _all(v: Any, ok: Check) -> bool:
    return type(v) is list and all(ok(x) for x in v)


def _day(v: Any) -> bool:
    return _str(v) and bool(DAY_RE.match(v))


def _gate(v: Any, value: Check) -> bool:
    return (_exact(v, ["pass", "not_yet", "why", "value"]) and _bool_n(v["pass"]) and type(v["not_yet"]) is bool
            and _str(v["why"]) and value(v["value"]))


def _check(c: Any) -> bool:
    return (_exact(c, ["id", "pass", "value", "why"]) and _one_of(CHECKS, c["id"]) and type(c["pass"]) is bool
            and _num_n(c["value"]) and _str(c["why"]))


def _candidate(v: Any) -> bool:
    return (_exact(v, ["occ", "expiry", "strike", "kind", "bid", "ask", "at", "volume", "delta", "failed", "checks"])
            and _str_n(v["occ"]) and _day(v["expiry"]) and _num(v["strike"]) and _one_of(SIDES, v["kind"])
            and _num_n(v["bid"]) and _num_n(v["ask"]) and _iso_n(v["at"]) and _num_n(v["volume"])
            and _num_n(v["delta"]) and (v["failed"] is None or _one_of(CHECKS, v["failed"]))
            and _all(v["checks"], _check))


def _contract(v: Any) -> bool:
    return (_exact(v, ["expiry", "why", "picked", "candidates"]) and (v["expiry"] is None or _day(v["expiry"]))
            and (v["why"] is None or _one_of(NO_CONTRACT, v["why"])) and _str_n(v["picked"])
            and _all(v["candidates"], _candidate))


def _dir_n(v: Any) -> bool:
    return v is None or _one_of(DIRECTIONS, v)


def _side_gates(v: Any) -> bool:
    return (_exact(v, ["market_direction", "volume", "stock_bid_ask", "shock", "contract"])
            and _gate(v["market_direction"], lambda x: _exact(x, ["SPY", "QQQ"]) and _dir_n(x["SPY"])
                      and _dir_n(x["QQQ"]))
            and _gate(v["volume"], _num_n)
            and _gate(v["stock_bid_ask"], lambda x: _exact(x, ["bps", "age_ms"]) and _num_n(x["bps"])
                      and _num_n(x["age_ms"]))
            and _gate(v["shock"], lambda x: _exact(x, ["ranges", "release"]) and _all(x["ranges"], _num_n)
                      and _str_n(x["release"]))
            and _gate(v["contract"], _contract))


def _dry_side(v: Any) -> bool:
    return _exact(v, ["side", "gates"]) and _one_of(SIDES, v["side"]) and _side_gates(v["gates"])


def _card(v: Any) -> bool:
    return v is None or (_exact(v, ["level", "entry", "stop", "t1"]) and all(_num_n(v[k]) for k in v))


LOG_SIDE_KEYS = ["side", "gates", "state", "broke_at", "broke_earlier", "gap", "card", "word", "lifecycle",
                 "scoring", "missing", "for", "against", "unusable"]


def _log_side(v: Any) -> bool:
    return (_exact(v, LOG_SIDE_KEYS) and _one_of(SIDES, v["side"]) and _side_gates(v["gates"])
            and (v["state"] is None or _one_of(ROW_STATES, v["state"])) and _iso_n(v["broke_at"])
            and _bool_n(v["broke_earlier"]) and _bool_n(v["gap"]) and _card(v["card"]) and _one_of(WORDS, v["word"])
            and (v["lifecycle"] is None or _one_of(LIFECYCLE, v["lifecycle"]))
            and (v["scoring"] is None or _one_of(SCORING, v["scoring"]))
            and (v["missing"] is None or _one_of(MISSING, v["missing"]))
            and _strs(v["for"]) and _strs(v["against"]) and _strs(v["unusable"]))


def _stock(v: Any) -> bool:
    return v is None or (_exact(v, ["price", "bid", "ask", "trade_at", "quote_at", "age_ms"])
                         and _num_n(v["price"]) and _num_n(v["bid"]) and _num_n(v["ask"]) and _str_n(v["trade_at"])
                         and _str_n(v["quote_at"]) and _num_n(v["age_ms"]))


def _chain(v: Any) -> bool:
    return v is None or (_exact(v, ["as_of", "served_at", "feed", "fallback", "checked_age_ms"]) and _str(v["as_of"])
                         and _str_n(v["served_at"]) and _str(v["feed"]) and _str_n(v["fallback"])
                         and _num_n(v["checked_age_ms"]))


def _name_entry(side: Check) -> Check:
    def ok(v: Any) -> bool:
        return (_exact(v, ["symbol", "stock", "volume_slot", "chain", "sides"]) and _str(v["symbol"])
                and bool(SYMBOL.match(v["symbol"])) and _stock(v["stock"])
                and _exact(v["volume_slot"], ["value", "why"]) and _num_n(v["volume_slot"]["value"])
                and _str_n(v["volume_slot"]["why"]) and _chain(v["chain"]) and type(v["sides"]) is list
                and len(v["sides"]) <= 2 and all(side(s) for s in v["sides"])
                and len({s["side"] for s in v["sides"]}) == len(v["sides"]))
    return ok


def _index_entry(sym: str) -> Check:
    def ok(v: Any) -> bool:
        return v is None or (
            _exact(v, ["symbol", "direction", "why", "price", "vwap", "closes", "bid", "ask", "spread_bps", "age_ms"])
            and v["symbol"] == sym and _dir_n(v["direction"]) and _str_n(v["why"]) and _num_n(v["price"])
            and _num_n(v["vwap"]) and _all(v["closes"], _num) and _num_n(v["bid"]) and _num_n(v["ask"])
            and _num_n(v["spread_bps"]) and _num_n(v["age_ms"]))
    return ok


def _break_entry(v: Any) -> bool:
    return (_exact(v, ["symbol", "side", "broke_at", "confirmed_at", "occ", "volume_failed_at"]) and _str(v["symbol"])
            and bool(SYMBOL.match(v["symbol"])) and _one_of(SIDES, v["side"]) and iso(v["broke_at"])
            and _iso_n(v["confirmed_at"]) and _str_n(v["occ"]) and _iso_n(v["volume_failed_at"]))


def _follow_entry(v: Any) -> bool:
    return (_exact(v, ["symbol", "side", "broke_at", "occ", "bid", "ask", "at", "age_ms", "checked_age_ms", "why"])
            and _str(v["symbol"]) and _one_of(SIDES, v["side"]) and iso(v["broke_at"]) and _str(v["occ"])
            and _num_n(v["bid"]) and _num_n(v["ask"]) and _iso_n(v["at"]) and _num_n(v["age_ms"])
            and _num_n(v["checked_age_ms"]) and _str_n(v["why"]))


COMMON_KEYS = ["v", "mode", "switch", "session", "slot_end", "evaluated_at", "engine", "params_hash", "params_status",
               "code_hash", "frozen_params_hash", "frozen_code_hash", "dec0044", "stamp", "stamp_usable", "feed_stock",
               "flow", "flow_why", "baseline", "context", "edition", "focus", "unusable", "names"]
DRY_KEYS = [*COMMON_KEYS, "last_log"]
LOG_KEYS = [*COMMON_KEYS, "breaks", "breaks_from", "history_usable", "follow"]


def _hex64(v: Any) -> bool:
    return _str(v) and bool(HEX64.match(v))


def _common(v: dict[str, Any]) -> bool:
    d, s, f, b, c, e = v["dec0044"], v["stamp"], v["flow"], v["baseline"], v["context"], v["edition"]
    return (v["v"] == SIGNAL_RECORD_V and type(v["v"]) is int and _day(v["session"]) and iso(v["slot_end"])
            and iso(v["evaluated_at"]) and _str(v["engine"]) and _hex64(v["params_hash"])
            and _one_of(("candidate", "frozen"), v["params_status"]) and _str(v["code_hash"])
            and (v["frozen_params_hash"] is None or _hex64(v["frozen_params_hash"])) and _str_n(v["frozen_code_hash"])
            and _exact(d, ["key", "sha256", "status", "reason", "evaluated_at"]) and _str(d["key"])
            and _hex64(d["sha256"]) and _one_of(STATUSES, d["status"])
            and (d["reason"] is None or _one_of(DEGRADED, d["reason"])) and iso(d["evaluated_at"])
            and (s is None or (_exact(s, ["key", "feed", "answered", "at"]) and all(_str(s[k]) for k in s)))
            and type(v["stamp_usable"]) is bool and _str_n(v["feed_stock"])
            and (f is None or (_exact(f, ["as_of", "age_ms", "missing"]) and iso(f["as_of"]) and _num_n(f["age_ms"])
                               and _strs(f["missing"])))
            and _str_n(v["flow_why"])
            and (b is None or (_exact(b, ["v", "for_session", "built_at", "sessions"]) and _num(b["v"])
                               and _str(b["for_session"]) and _str(b["built_at"]) and _num(b["sessions"])))
            and _exact(c, ["SPY", "QQQ"]) and _index_entry("SPY")(c["SPY"]) and _index_entry("QQQ")(c["QQQ"])
            and (e is None or (_exact(e, ["session", "as_of"]) and _str(e["session"]) and _str_n(e["as_of"])))
            and _strs(v["focus"]) and all(SYMBOL.match(x) for x in v["focus"]) and _strs(v["unusable"]))


def _no_constant(c: str) -> Any:
    raise ValueError(f"not JSON: {c}")      # NaN and Infinity are not JSON; JSON.parse refuses them


def parse_signal_record(text: str) -> dict[str, Any] | None:
    """A stored signal record read back strictly, as `parseSignalRecord` reads it; None for anything else."""
    try:
        v = json.loads(text, parse_constant=_no_constant)
    except (ValueError, RecursionError):
        return None
    if not _obj(v):
        return None
    try:
        if v.get("mode") == "dry":
            if (not _exact(v, DRY_KEYS) or v["switch"] != "dry" or not _common(v) or not _str_n(v["last_log"])
                    or not _all(v["names"], _name_entry(_dry_side))):
                return None
            return v  # type: ignore[no-any-return]
        if v.get("mode") == "log":
            if (not _exact(v, LOG_KEYS) or v["switch"] not in ("log", "show") or not _common(v)
                    or not _all(v["names"], _name_entry(_log_side))):
                return None
            if (not _all(v["breaks"], _break_entry) or not _str_n(v["breaks_from"])
                    or type(v["history_usable"]) is not bool or not _all(v["follow"], _follow_entry)):
                return None
            return v  # type: ignore[no-any-return]
    except (TypeError, KeyError):
        return None
    return None


def iso_ms(v: str) -> int:
    """Milliseconds since the epoch of a canonical ISO instant (as `Date.parse`)."""
    t = datetime.strptime(v, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=timezone.utc)
    return int(round(t.timestamp() * 1000))
