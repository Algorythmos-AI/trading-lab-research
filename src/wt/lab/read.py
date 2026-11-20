"""Reading a recorded session for research (EXP-0041 and what comes after), with the tape's traps closed.

    s = read.open_session(folder)                 # refuses an unfinished, changed or unrecorded session
    q = s.quote_at("AAA261119C00100000", t_ns)    # the quote known at t_ns, or a Missing saying why not

What it guarantees, so a study cannot get a better answer from the tape than a trader could have had:
- **No look-ahead.** A quote at `t` is built only from rows *received* by `t` (`recv_ns`), never from `quote_ts`,
  which is the exchange's time and can be seconds older or, on a bad clock, newer.
- **Sampled, not assumed.** Rows are written only when a quote changed, so "the last row before t" is right only if
  the contract was asked for and answered at the last sweep before `t`. The sample stream says exactly that; a
  contract whose last sweep failed, was skipped by the budget, or never happened (the recorder was down) is Missing,
  never the older row.
- **Stale is visible, name by name.** Each answer carries the quote's age at `t` and whether its name was fresh at
  `t`: the newest tier-1 quote received for that name by `t` at most `stale_after_s` old. On 2026-11-19 three names
  were answered with the previous day's quotes for the first hour while one moved; a test over all names would
  have missed it. A quote stamped before the session's open is never handed back.
- **Verified input.** The session's files must match the sha256s in its manifest.

Only sessions written by a recorder with the sample stream can be read this way; older ones (the first session,
2026-11-19) are refused with the reason, because which contracts were sampled at a tick cannot be known for them.
"""
from __future__ import annotations

import bisect
import datetime as dt
import json
import zoneinfo
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pyarrow as pa
import pyarrow.parquet as pq

from wt.lab import manifest
from wt.lab.tape import STREAMS, ts_ns

NY = zoneinfo.ZoneInfo("America/New_York")
TIER1_WINDOW_S = 10.0          # a tier-1 sample older than two ticks says nothing about now
TIER2_WINDOW_S = 120.0         # tier 2: two minutes


class NotReadable(Exception):
    """The session cannot be used for research, and why."""


@dataclass(frozen=True)
class Quote:
    symbol: str
    bid: float | None
    ask: float | None
    bid_size: int | None
    ask_size: int | None
    quote_ns: int | None           # the exchange's quote time
    sampled_ns: int                # when the sweep that vouches for it was answered
    age_s: float | None            # how old the quote was at the time asked about
    tick: int
    tier: int
    fresh_name: bool               # the contract's name had a fresh tier-1 quote at the time asked about


@dataclass(frozen=True)
class Missing:
    symbol: str
    reason: str


def _table(folder: Path, stream: str) -> list[dict[str, Any]]:
    parts = sorted(folder.glob(f"{stream}-*.parquet"))
    if not parts:
        return []
    out: list[dict[str, Any]] = pa.concat_tables([pq.read_table(p) for p in parts]).to_pylist()
    return out


class Session:
    def __init__(self, folder: Path, doc: dict[str, Any]) -> None:
        self.folder, self.manifest = folder, doc
        self.stale_after_s = float((doc.get("settings") or {}).get("stale_after_s", 30.0))
        day = dt.date.fromisoformat(folder.name)
        self.open_ns = int(dt.datetime.combine(day, dt.time(9, 30), NY).timestamp()) * 1_000_000_000
        rows = {s: _table(folder, s) for s in STREAMS if s in ("option", "stock", "sample", "gap", "member")}
        self.gaps = sorted(rows["gap"], key=lambda r: r["recv_ns"])
        self.members = sorted(rows["member"], key=lambda r: r["recv_ns"])
        # per symbol: receive times and rows of its changes, in receive order
        self._rows: dict[str, tuple[list[int], list[dict[str, Any]]]] = {}
        for r in sorted(rows["option"] + rows["stock"], key=lambda r: (r["recv_ns"], r["symbol"])):
            rt, rv = self._rows.setdefault(r["symbol"], ([], []))
            rt.append(r["recv_ns"])
            rv.append(r)
        # per name (root): receive times of its tier-1 rows and the newest quote time received by each
        self._name: dict[str, tuple[list[int], list[int]]] = {}
        for r in sorted(rows["option"], key=lambda r: r["recv_ns"]):
            q = ts_ns(r.get("quote_ts"))
            if r["tier"] != 1 or q is None:
                continue
            nt, nq = self._name.setdefault(r["symbol"][:-15], ([], []))
            nt.append(r["recv_ns"])
            nq.append(max(q, nq[-1]) if nq else q)
        # per symbol: every sweep that asked for it (receive time, tick, tier, answered)
        self._asked: dict[str, tuple[list[int], list[tuple[int, int, bool]]]] = {}
        listed: dict[tuple[int, int], list[str]] = {}
        newest: dict[int, int] = {}
        recv_of: dict[int, int] = {}
        for r in sorted(rows["sample"], key=lambda r: (r["recv_ns"], r["tier"], r["batch"])):
            key = (r["tier"], r["batch"])
            if r["symbols"] is not None:
                listed[key] = r["symbols"].split(",") if r["symbols"] else []
            elif r["tier"] == 0:
                listed.setdefault(key, list(doc.get("names") or []))
            syms = listed.get(key)
            if syms is None:
                raise NotReadable(f"sample row before its batch's symbols (tick {r['tick']})")
            lost = set(r["missing"].split(",")) if r["missing"] else set()
            ok = r["result"] == "ok"
            for s in syms:
                at, av = self._asked.setdefault(s, ([], []))
                at.append(r["recv_ns"])
                av.append((r["tick"], r["tier"], ok and s not in lost))
            if r["tier"] == 1 and ok and r["newest_quote_ns"] is not None:
                newest[r["tick"]] = max(newest.get(r["tick"], 0), r["newest_quote_ns"])
                recv_of[r["tick"]] = max(recv_of.get(r["tick"], 0), r["recv_ns"])
        self._fresh = {k: (recv_of[k] - n) / 1e9 <= self.stale_after_s for k, n in newest.items()}

    def fresh(self, tick: int) -> bool:
        """The tier-1 sweep of `tick` answered at least one quote newer than `stale_after_s` (any name)."""
        return self._fresh.get(tick, False)

    def name_fresh(self, name: str, t_ns: int) -> bool:
        """`name`'s newest tier-1 quote received by `t_ns` is at most `stale_after_s` old, and from this session."""
        got = self._name.get(name)
        if not got:
            return False
        i = bisect.bisect_right(got[0], t_ns) - 1
        return i >= 0 and got[1][i] >= self.open_ns and (t_ns - got[1][i]) / 1e9 <= self.stale_after_s

    def quote_at(self, symbol: str, t_ns: int) -> Quote | Missing:
        asked = self._asked.get(symbol)
        if asked is None:
            return Missing(symbol, "never sampled")
        i = bisect.bisect_right(asked[0], t_ns) - 1
        if i < 0:
            return Missing(symbol, "not sampled yet")
        sampled_ns, (tick, tier, ok) = asked[0][i], asked[1][i]
        if not ok:
            return Missing(symbol, f"not answered at tick {tick}")
        window = TIER1_WINDOW_S if tier in (0, 1) else TIER2_WINDOW_S
        if (t_ns - sampled_ns) / 1e9 > window:
            return Missing(symbol, f"no sample for {(t_ns - sampled_ns) / 1e9:.0f} s (last at tick {tick})")
        got = self._rows.get(symbol)
        j = bisect.bisect_right(got[0], sampled_ns) - 1 if got else -1
        if j < 0 or got is None:
            return Missing(symbol, "answered but no row: the recorder lost its first row")
        r = got[1][j]
        q = ts_ns(r.get("quote_ts"))
        if q is not None and q < self.open_ns:
            return Missing(symbol, "quote from before the open")
        return Quote(symbol, r.get("bid"), r.get("ask"), r.get("bid_size"), r.get("ask_size"), q, sampled_ns,
                     None if q is None else (t_ns - q) / 1e9, tick, tier,
                     tier == 0 or self.name_fresh(symbol[:-15] if tier else symbol, t_ns))

    def symbols(self, tier: int | None = None) -> list[str]:
        if tier is None:
            return sorted(self._asked)
        return sorted(s for s, (_, v) in self._asked.items() if any(x[1] == tier for x in v))

    def gaps_between(self, a_ns: int, b_ns: int) -> Iterable[dict[str, Any]]:
        return [g for g in self.gaps if a_ns <= g["recv_ns"] <= b_ns]


def open_session(folder: Path) -> Session:
    """A finished, recorded, unchanged session written with the sample stream; otherwise NotReadable says why."""
    p = folder / manifest.NAME
    if not p.exists():
        raise NotReadable("no manifest: the session is not finished")
    doc = json.loads(p.read_text())
    if not doc.get("recorded"):
        raise NotReadable(f"nothing recorded: {doc.get('reason')}")
    problems = manifest.verify(folder)
    if problems:
        raise NotReadable("files differ from the manifest: " + ", ".join(problems[:5]))
    if not any(folder.glob("sample-*.parquet")):
        raise NotReadable("written before the sample stream: which contracts were sampled at a tick is unknown")
    if str(doc.get("focus_session")) != folder.name:
        raise NotReadable("the focus list is not this session's")
    return Session(folder, doc)
