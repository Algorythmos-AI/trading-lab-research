"""Sleeve S against the forward test: the trades both took, in counts and differences (EXP-0051, measures.agreement).

Sleeve S (wt.live.runner_s, trial HYP-0070) trades the registered reversal rule live on a causal universe. The
nightly forward test trades the same rule (HYP-0019, ledger strategy `r3:REV-1`) after the close on a look-ahead
universe. This module sets the two side by side per session and in total:

  how many trades each took, and how many are the same name on the same session;
  for those pairs, the entry difference in cents, whether the exit is of the same class, and the R difference.

Differences are sleeve S minus the forward test. Names go in and only counts and numbers come out.

What counts
  A session is compared only when both ran it: sleeve S armed (an `armed` row for that day) and the forward test
  completed the trial (its `strategy_marker` row for that session). A night one side did not run is counted on its
  own and never read as "took no trade".
  A sleeve S trade is a `trade_closed` row with origin "entry" (an adopted orphan is not the rule's trade), the
  sleeve's trial id, an entry price and a real exit price. A close whose exit price was estimated from the stop is
  left out and counted in `s_excluded`. Rows repeated under one `trade_id`, or one ledger `key`, count once.
  A name can be tried twice a day on both sides. Within a session and a name the trades are paired in order
  (sleeve S in journal order, the forward test by attempt and entry time); the pairs are the smaller of the two
  counts and the rest are one-sided.
  An exit is one of `stop`, `target`, `time_stop`, `eod`. A pair with a reason outside those is counted as
  unclassified, neither same nor different.

Nothing here splits a result by matched against unmatched: that would be a new trial with its own record.
"""
from __future__ import annotations

import json
import math
from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import Any

S_TRIAL = "HYP-0070"               # wt.live.setups_live.TRIAL (a test holds the two together)
FWD_TRIAL = "HYP-0019"             # scripts/forward_test.R3_HYP[FWD_STRATEGY]
FWD_STRATEGY = "r3:REV-1"
EXIT_CLASSES = ("stop", "target", "time_stop", "eod")
EXCLUDED = ("not_entry_origin", "other_trial", "no_entry_price", "estimated_exit", "no_r")

Row = Mapping[str, Any]


def read_rows(path: Path) -> list[dict[str, Any]]:
    """The JSON objects of a JSON-lines file. An absent file is empty, and a torn or foreign line is skipped."""
    out: list[dict[str, Any]] = []
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                if isinstance(r, dict):
                    out.append(r)
    except OSError:
        pass
    return out


def _num(x: Any) -> float | None:
    ok = isinstance(x, int | float) and not isinstance(x, bool) and math.isfinite(x)
    return float(x) if ok else None


def exit_class(reason: Any) -> str:
    """The class of an exit reason from either side: the runner's (`stop`, `target`, `time_stop_5m`, `eod_flatten`,
    `eod_market`, `eod_verify`) or the simulation's (`stop`, `target`, `time_stop_5m`, `eod_flatten`)."""
    s = str(reason or "")
    if s.startswith("time_stop"):
        return "time_stop"
    if s.startswith("eod"):
        return "eod"
    return s if s in ("stop", "target") else "other"


def s_sessions(journal: Iterable[Row]) -> dict[str, bool]:
    """day -> whether entries were off when sleeve S last armed that day (KILL on, or a refusal: exits only)."""
    out: dict[str, bool] = {}
    for r in journal:
        if r.get("event") == "armed" and r.get("day"):
            out[str(r["day"])] = bool(r.get("kill")) or bool(r.get("entries_off"))
    return out


def s_trades(journal: Iterable[Row]) -> tuple[dict[str, list[dict[str, Any]]], dict[str, int]]:
    """(day -> sleeve S's own closed trades in journal order, how many closes were left out and why)."""
    days: dict[str, list[dict[str, Any]]] = {}
    left = dict.fromkeys(EXCLUDED, 0)
    seen: set[str] = set()
    for i, r in enumerate(journal):
        if r.get("event") != "trade_closed":
            continue
        tid = str(r.get("trade_id") or f"row-{i}")
        if tid in seen:
            continue
        seen.add(tid)
        entry, exit_px, r_mult = _num(r.get("entry")), _num(r.get("exit")), _num(r.get("R"))
        if r.get("origin") != "entry":
            why = "not_entry_origin"
        elif r.get("trial") != S_TRIAL:
            why = "other_trial"
        elif entry is None or entry <= 0:
            why = "no_entry_price"
        elif r.get("exit_price_estimated") is not False or exit_px is None:
            why = "estimated_exit"
        elif r_mult is None:
            why = "no_r"
        else:
            days.setdefault(str(r.get("day")), []).append(
                {"symbol": str(r.get("symbol")), "entry": entry, "R": r_mult, "exit": exit_class(r.get("reason"))})
            continue
        left[why] += 1
    return days, left


def fwd_sessions(ledger: Iterable[Row]) -> set[str]:
    """The sessions for which the forward test completed the trial (its strategy marker is on the ledger)."""
    return {str(r.get("session")) for r in ledger
            if r.get("strategy") == FWD_STRATEGY and r.get("strategy_marker") and "error" not in r}


def fwd_trades(ledger: Iterable[Row]) -> dict[str, list[dict[str, Any]]]:
    """session -> the forward test's trades of the trial, by attempt and entry time. A row repeated under one
    `key` counts once."""
    rows: dict[str, list[tuple[tuple[int, str, int], dict[str, Any]]]] = {}
    seen: set[str] = set()
    for i, r in enumerate(ledger):
        if r.get("strategy") != FWD_STRATEGY or "R" not in r or "error" in r or r.get("strategy_marker"):
            continue
        if r.get("key") is not None:
            k = json.dumps(r["key"], sort_keys=True, default=str)
            if k in seen:
                continue
            seen.add(k)
        attempt = _num(r.get("attempt"))
        order = (int(attempt) if attempt is not None else 0, str(r.get("entry_time") or ""), i)
        rows.setdefault(str(r.get("session")), []).append(
            (order, {"symbol": str(r.get("symbol")), "entry": _num(r.get("entry")), "R": _num(r.get("R")),
                     "exit": exit_class(r.get("exit_reason"))}))
    return {d: [t for _, t in sorted(v, key=lambda x: x[0])] for d, v in rows.items()}


def _by_symbol(trades: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    out: dict[str, list[dict[str, Any]]] = {}
    for t in trades:
        out.setdefault(t["symbol"], []).append(t)
    return out


def compare_session(day: str, s: list[dict[str, Any]], f: list[dict[str, Any]], entries_off: bool = False) -> dict[str, Any]:
    """One session both sides ran. Counts, and for each pair one number per difference; no name."""
    a, b = _by_symbol(s), _by_symbol(f)
    out: dict[str, Any] = {"day": day, "entries_off": entries_off, "s_trades": len(s), "fwd_trades": len(f),
                           "names_s": len(a), "names_fwd": len(b), "names_both": len(a.keys() & b.keys()), "both": 0,
                           "exit_same": 0, "exit_different": 0, "exit_unclassified": 0,
                           "entry_diff_cents": [], "r_diff": []}
    for sym in sorted(a.keys() & b.keys()):
        for x, y in zip(a[sym], b[sym], strict=False):
            out["both"] += 1
            if "other" in (x["exit"], y["exit"]):
                out["exit_unclassified"] += 1
            else:
                out["exit_same" if x["exit"] == y["exit"] else "exit_different"] += 1
            if y["entry"] is not None:
                out["entry_diff_cents"].append(round(100 * (x["entry"] - y["entry"]), 2))
            if y["R"] is not None:
                out["r_diff"].append(round(x["R"] - y["R"], 4))
    out["s_only"], out["fwd_only"] = len(s) - out["both"], len(f) - out["both"]
    return out


def spread(xs: list[float]) -> dict[str, Any]:
    """n, mean, mean absolute and largest absolute of a list of differences; the three are None when it is empty."""
    if not xs:
        return {"n": 0, "mean": None, "mean_abs": None, "max_abs": None}
    return {"n": len(xs), "mean": round(sum(xs) / len(xs), 4), "mean_abs": round(sum(abs(x) for x in xs) / len(xs), 4),
            "max_abs": round(max(abs(x) for x in xs), 4)}


def compare(journal: Iterable[Row], ledger: Iterable[Row]) -> dict[str, Any]:
    """Sleeve S's journal against the forward ledger: the sessions both ran, one row each, and their total. An
    absent or empty journal gives zero sessions and no error."""
    journal, ledger = list(journal), list(ledger)
    armed, ran = s_sessions(journal), fwd_sessions(ledger)
    mine, left = s_trades(journal)
    theirs = fwd_trades(ledger)
    both = sorted(armed.keys() & ran)
    days = [compare_session(d, mine.get(d, []), theirs.get(d, []), armed[d]) for d in both]
    t: dict[str, Any] = {
        "s_trial": S_TRIAL, "fwd_trial": FWD_TRIAL,
        "sessions": len(days), "first": both[0] if both else None, "last": both[-1] if both else None,
        "s_only_sessions": len(armed.keys() - ran), "fwd_only_sessions": len(ran - armed.keys()),
        "entries_off_sessions": sum(1 for d in days if d["entries_off"]),
        "sessions_with_a_pair": sum(1 for d in days if d["both"])}
    for k in ("s_trades", "fwd_trades", "both", "s_only", "fwd_only", "names_both", "exit_same", "exit_different",
              "exit_unclassified"):
        t[k] = sum(d[k] for d in days)
    t["entry_diff_cents"] = spread([x for d in days for x in d["entry_diff_cents"]])
    t["r_diff"] = spread([x for d in days for x in d["r_diff"]])
    t["s_excluded"] = left
    return {"total": t, "sessions": days}
