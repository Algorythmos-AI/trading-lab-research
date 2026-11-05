"""The external-trader post record under research/external/<source>/posts/*.jsonl.

One object per post, one file per New York calendar month, sorted by time. Two kinds of field:

* mechanical: derived from the collected post by this module (``ts_et``, ``session``, ``text_clean``, ``symbols``,
  ``month``). ``build`` recomputes them every run, so a rule change here reaches every row.
* coded: written by a reader following ``CODING.md`` (``kind``, ``signal``, ``setups``, ``vehicle``, ``direction``,
  ``levels``, ``entry_time_et``, ``outcome_claim``, the ``*_claim`` numbers, ``lesson``). ``build`` never changes
  them; a new post starts uncoded (``kind`` = ``uncoded``).

No network access; collection happens in a browser (see the record's COLLECT.md).
"""
from __future__ import annotations

import datetime as dt
import json
import re
from collections import Counter
from pathlib import Path
from typing import Any, Iterable
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")

RAW_FIELDS = ("id", "url", "ts_utc", "text", "quoted_id", "quoted_text", "image_ids", "has_video")
CODED_DEFAULTS: dict[str, Any] = {
    "kind": "uncoded", "signal": False, "setups": [], "vehicle": None, "direction": None, "levels": [],
    "entry_time_et": None, "outcome_claim": "none", "pnl_usd_claim": None, "pct_claim": None,
    "points_claim": None, "lesson": None,
}
FIELD_ORDER = ("id", "url", "ts_utc", "ts_et", "month", "session", "text", "text_clean", "quoted_id", "quoted_text",
               "image_ids", "has_video", "symbols", *CODED_DEFAULTS)

# Futures roots and their micro or contract-month spellings, all folded to one root.
FUTURES = {"NQ": "NQ", "MNQ": "NQ", "ES": "ES", "MES": "ES", "YM": "YM", "MYM": "YM", "RTY": "RTY", "M2K": "RTY",
           "GC": "GC", "MGC": "GC", "CL": "CL", "MCL": "CL", "SI": "SI", "BTC": "BTC", "MBT": "BTC", "10Y": "10Y"}
INDEXES = {"SPX", "NDX", "VIX", "SOX", "KOSPI"}
ETFS = {"SPY", "QQQ", "IWM", "DIA", "SMH", "IGV", "XLP", "XLV", "XLE", "XLF", "XLK", "GLD", "SLV", "USO", "IBIT",
        "TQQQ", "SQQQ", "REMX", "DRAM", "MUU", "SNXX", "SOXL"}
NOT_TICKERS = {"ATH", "PDH", "PDL", "PDC", "PMH", "PML", "HOD", "LOD", "VWAP", "EOD", "EOW", "EOY", "EOM", "NFA", "FOMC",
               "CPI", "PPI", "GDP", "AH", "ER", "LT", "DMA", "NTZ", "TTL", "ORB", "ET", "AM", "PM", "IV", "R", "W", "L"}

_URL = re.compile(r"(https?://\S+|\b(?:x|twitter|youtube|youtu|whop|discord|kalshi)\.(?:com|be|gg)/\S*|\S+…)")
_CASHTAG = re.compile(r"\$([A-Za-z]{1,5})\b")
_SLASH_FUT = re.compile(r"(?<![\w/])/(M?[A-Z]{2,3}|10Y)\b")
_BARE_FUT = re.compile(r"\b(MNQ|MES|MYM|NQ|ES|YM|RTY)(?:[FGHJKMNQUVXZ]\d)?\b")


def ts_et(ts_utc: str) -> dt.datetime:
    return dt.datetime.fromisoformat(ts_utc.replace("Z", "+00:00")).astimezone(ET)


def session_of(t: dt.datetime) -> str:
    """The US session a New York time falls in. A weekend is overnight."""
    if t.weekday() >= 5:
        return "overnight"
    m = t.hour * 60 + t.minute
    if m < 4 * 60:
        return "overnight"
    if m < 9 * 60 + 30:
        return "pre"
    if m < 11 * 60:
        return "rth_open"
    if m < 15 * 60:
        return "rth_mid"
    if m < 16 * 60:
        return "rth_close"
    if m < 20 * 60:
        return "post"
    return "overnight"


def clean_text(text: str) -> str:
    """The post with links and truncated link stubs removed and whitespace collapsed."""
    return " ".join(_URL.sub(" ", text).split())


def asset_of(symbol: str) -> str:
    if symbol in FUTURES.values():
        return "future"
    if symbol in INDEXES:
        return "index"
    if symbol in ETFS:
        return "etf"
    return "equity"


def symbols_of(text: str) -> list[dict[str, str]]:
    """Canonical tickers in a post: $NQ, /NQ, NQ, MNQ and NQZ5 are all NQ; SPX stays apart from SPY."""
    found: list[str] = []
    for m in _CASHTAG.finditer(text):
        s = m.group(1).upper()
        found.append(FUTURES.get(s, s))
    for m in _SLASH_FUT.finditer(text):
        s = m.group(1).upper()
        if s in FUTURES:
            found.append(FUTURES[s])
    for m in _BARE_FUT.finditer(text):
        found.append(FUTURES[m.group(1)])
    out: list[str] = []
    for s in found:
        if s not in NOT_TICKERS and s not in out:
            out.append(s)
    return [{"symbol": s, "asset": asset_of(s)} for s in out]


def mechanical(raw: dict[str, Any]) -> dict[str, Any]:
    t = ts_et(str(raw["ts_utc"]))
    text = str(raw.get("text") or "")
    return {
        "id": str(raw["id"]),
        "url": str(raw["url"]),
        "ts_utc": str(raw["ts_utc"]).replace(".000Z", "Z"),
        "ts_et": t.isoformat(timespec="seconds"),
        "month": t.strftime("%Y-%m"),
        "session": session_of(t),
        "text": text,
        "text_clean": clean_text(text),
        "quoted_id": raw.get("quoted_id") or None,
        "quoted_text": raw.get("quoted_text") or None,
        "image_ids": list(raw.get("image_ids") or []),
        "has_video": bool(raw.get("has_video")),
        "symbols": symbols_of(text),
    }


def load(posts_dir: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for f in sorted(posts_dir.glob("*.jsonl")):
        rows.extend(json.loads(line) for line in f.read_text(encoding="utf-8").splitlines() if line.strip())
    return rows


def build(posts_dir: Path, raw_batches: Iterable[list[dict[str, Any]]]) -> dict[str, int]:
    """Merge collected posts into the monthly files. Coded fields already in a file are kept as they are."""
    existing = {r["id"]: r for r in load(posts_dir)}
    merged: dict[str, dict[str, Any]] = {}
    for pid, r in existing.items():
        raw = {k: r.get(k) for k in RAW_FIELDS}
        merged[pid] = {**CODED_DEFAULTS, **{k: r[k] for k in CODED_DEFAULTS if k in r}, **mechanical(raw)}
    added = 0
    for batch in raw_batches:
        for raw in batch:
            pid = str(raw["id"])
            if pid in merged:
                continue
            merged[pid] = {**CODED_DEFAULTS, **mechanical(raw)}
            added += 1
    _write(posts_dir, merged.values())
    return {"posts": len(merged), "added": added, "months": len({r["month"] for r in merged.values()})}


SIGNAL_KINDS = frozenset({"trade", "plan", "level_call", "lesson", "recap", "swing"})


def apply_codes(posts_dir: Path, codes: Iterable[dict[str, Any]]) -> dict[str, int]:
    """Write coded fields onto existing posts by id. ``signal`` always follows ``kind``; unknown keys are an error."""
    rows = load(posts_dir)
    by_id = {r["id"]: r for r in rows}
    applied = 0
    missing: list[str] = []
    for code in codes:
        pid = str(code["id"])
        extra = set(code) - set(CODED_DEFAULTS) - {"id"}
        if extra:
            raise ValueError(f"{pid}: not coded fields: {sorted(extra)}")
        if pid not in by_id:
            missing.append(pid)
            continue
        row = by_id[pid]
        row.update({k: v for k, v in code.items() if k != "id"})
        row["signal"] = row["kind"] in SIGNAL_KINDS
        applied += 1
    if missing:
        raise ValueError(f"codes for unknown posts: {missing[:5]} ({len(missing)} in all)")
    _write(posts_dir, rows)
    return {"applied": applied, "posts": len(rows)}


def _write(posts_dir: Path, rows: Iterable[dict[str, Any]]) -> None:
    by_month: dict[str, list[dict[str, Any]]] = {}
    for r in rows:
        by_month.setdefault(r["month"], []).append({k: r[k] for k in FIELD_ORDER})
    posts_dir.mkdir(parents=True, exist_ok=True)
    for old in posts_dir.glob("*.jsonl"):
        if old.stem not in by_month:
            old.unlink()
    for month, items in by_month.items():
        items.sort(key=lambda r: (r["ts_utc"], r["id"]))
        body = "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in items)
        (posts_dir / f"{month}.jsonl").write_text(body, encoding="utf-8")


def _table(title: str, counts: Counter[str], note: str = "") -> list[str]:
    lines = [f"### {title}", ""]
    if note:
        lines += [note, ""]
    lines += ["| value | posts |", "|---|---:|"]
    lines += [f"| {k} | {v} |" for k, v in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))]
    return lines + [""]


def stats_markdown(rows: list[dict[str, Any]]) -> str:
    """The record's stats.md. Generated only; a test checks the committed file equals this output."""
    sig = [r for r in rows if r.get("signal")]
    out = ["# Stats (generated)", "",
           "Built by `python scripts/external_posts.py stats <record>` from `posts/*.jsonl`. Do not edit by hand.",
           "Every P&L, percent and points figure here is **the trader's own claim**, not a verified result.", "",
           f"- Posts: {len(rows)}; signal posts: {len(sig)}; uncoded: {sum(r['kind'] == 'uncoded' for r in rows)}",
           f"- First post: {min(r['ts_et'] for r in rows)}; last post: {max(r['ts_et'] for r in rows)}", ""]
    out += ["## Posts by month", "", "| month | posts | signal | wins claimed | losses claimed | claimed USD (sum) |",
            "|---|---:|---:|---:|---:|---:|"]
    for month in sorted({r["month"] for r in rows}):
        m = [r for r in rows if r["month"] == month]
        usd = sum(float(r["pnl_usd_claim"]) for r in m if r.get("pnl_usd_claim") is not None)
        out.append(f"| {month} | {len(m)} | {sum(bool(r.get('signal')) for r in m)} | "
                   f"{sum(r.get('outcome_claim') == 'win' for r in m)} | "
                   f"{sum(r.get('outcome_claim') == 'loss' for r in m)} | {usd:,.0f} |")
    out += ["", "The USD column adds every dollar figure he posted that month (day, week or trade); it double-counts "
            "when he posts a day and then a week that contains it. Read it as how loud the month was, not as P&L.", ""]
    out += ["## All posts", ""]
    out += _table("Kind", Counter(r["kind"] for r in rows), "`signal` is true for every kind but promo and personal.")
    out += ["## Signal posts", ""]
    out += _table("Setup", Counter(s for r in sig for s in r.get("setups") or []))
    out += ["### Claimed outcome by setup", "", "His stated outcome on trade and swing posts that name a setup. Claims, "
            "not results; most posts state no outcome.", "", "| setup | posts | win | loss | scratch | none |",
            "|---|---:|---:|---:|---:|---:|"]
    traded = [r for r in sig if r["kind"] in ("trade", "swing")]
    for setup in sorted({s for r in traded for s in r.get("setups") or []}):
        m = [r for r in traded if setup in (r.get("setups") or [])]
        c = Counter(r["outcome_claim"] for r in m)
        out.append(f"| {setup} | {len(m)} | {c['win']} | {c['loss']} | {c['scratch']} | {c['none']} |")
    out.append("")
    out += _table("Vehicle", Counter(r["vehicle"] or "none" for r in sig))
    out += _table("Direction", Counter(r["direction"] or "none" for r in sig))
    out += _table("Level type", Counter(lv["type"] for r in sig for lv in r.get("levels") or []))
    out += _table("Symbol", Counter(s["symbol"] for r in sig for s in r.get("symbols") or []))
    out += _table("Session the post was made in", Counter(r["session"] for r in sig),
                  "Post time, not entry time. A recap is posted after the trade.")
    hours = Counter(str(r["entry_time_et"])[:2] + ":00" for r in sig if r.get("entry_time_et"))
    out += _table("Stated entry hour (ET)", hours, "Only posts that state the entry time or show it in a fill.")
    return "\n".join(out).rstrip() + "\n"
