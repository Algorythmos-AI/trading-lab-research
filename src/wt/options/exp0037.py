"""EXP-0037's bookkeeping and verdict (DEC-0054, HYP-0062 to HYP-0064). Pure: no I/O, no clock.

- The session list: every session after DEC-0054 is accepted, in order, until 40 sessions or 2027-04-30.
- The match: a trade is keyed by (session, root, setup, side, signal bar); `added` are a variant's trades the
  control does not take, `displaced` the control's trades the variant does not take.
- The verdict, read once per hypothesis: at least 30 added trades in at least 15 sessions; the lower end of the
  98.33% session-bootstrap range of the added trades' mean return on premium at 1x above 0; their mean at 2x above
  0; and the variant's total return on premium over all its trades at 1x not below the control's.
"""
from __future__ import annotations

import datetime as dt
import re
from collections import Counter
from collections.abc import Callable, Mapping, Sequence
from typing import Any

import numpy as np

HYPOTHESES = {"room_open_sky": "HYP-0062", "retest_free_confirm": "HYP-0063", "rejection_spy_trend": "HYP-0064"}
SEEDS = {"room_open_sky": 20261162, "retest_free_confirm": 20261163, "rejection_spy_trend": 20261164}
RESAMPLES = 5000
INTERVAL = (0.8333, 99.1667)          # Bonferroni 95% over three hypotheses
MIN_ADDED, MIN_SESSIONS = 30, 15
MAX_SESSIONS = 40
LAST_DAY = dt.date(2027, 4, 30)
ENGINE_KEYS = ("signal_bar", "level")  # keys EXP-0037 added to each trade; the pre-switch engine has neither

_ACCEPTED = re.compile(r"^- \*\*Status: ACCEPTED on (\d{4}-\d{2}-\d{2})", re.M)
_SESSION = re.compile(r"^- (\d{4}-\d{2}-\d{2})\b")


# ---------------------------------------------------------------- the session list
def accepted_on(decision_md: str) -> dt.date | None:
    """The day DEC-0054 was accepted, from its status line; None while it is not."""
    m = _ACCEPTED.search(decision_md)
    return dt.date.fromisoformat(m.group(1)) if m else None


def listed(readme_md: str) -> list[dt.date]:
    """The sessions written under README.md's `## Sessions` heading (lines `- YYYY-MM-DD`), in order."""
    out: list[dt.date] = []
    inside = False
    for line in readme_md.splitlines():
        if line.startswith("## "):
            inside = line.strip() == "## Sessions"
            continue
        if inside and (m := _SESSION.match(line)):
            out.append(dt.date.fromisoformat(m.group(1)))
    return out


def due(accepted: dt.date, finished_through: dt.date, is_session: Callable[[dt.date], bool],
        already: Sequence[dt.date]) -> list[dt.date]:
    """The sessions to add to the list: after `accepted`, up to `finished_through` (the last session that has
    closed), not after LAST_DAY, and no more than MAX_SESSIONS in all."""
    out: list[dt.date] = []
    have = set(already)
    d = max([accepted, *already]) + dt.timedelta(days=1)
    while d <= min(finished_through, LAST_DAY) and len(already) + len(out) < MAX_SESSIONS:
        if d not in have and is_session(d):
            out.append(d)
        d += dt.timedelta(days=1)
    return out


def complete(sessions: Sequence[dt.date], today: dt.date) -> bool:
    """The list is closed: 40 sessions, or 2027-04-30 has passed."""
    return bool(sessions) and (len(sessions) >= MAX_SESSIONS or today > LAST_DAY)


# ---------------------------------------------------------------- the match
def key(t: Mapping[str, Any]) -> tuple[str, str, str, str, str]:
    return (str(t["session"]), str(t["root"]), str(t["setup"]), str(t["side"]), str(t["signal_bar"]))


def groups(control: Sequence[Mapping[str, Any]], variant: Sequence[Mapping[str, Any]]
           ) -> tuple[list[Mapping[str, Any]], list[Mapping[str, Any]]]:
    """(added, displaced): the variant's trades with no control trade of the same key, and the control's with no
    variant trade of the same key. Counted as multisets, so a key twice on one side is matched once."""
    left = Counter(key(t) for t in control)
    added: list[Mapping[str, Any]] = []
    for t in variant:
        if left[key(t)] > 0:
            left[key(t)] -= 1
        else:
            added.append(t)
    right = Counter(key(t) for t in variant)
    displaced: list[Mapping[str, Any]] = []
    for t in control:
        if right[key(t)] > 0:
            right[key(t)] -= 1
        else:
            displaced.append(t)
    return added, displaced


def same_as_pre_switch(old: Sequence[Mapping[str, Any]], new: Sequence[Mapping[str, Any]]) -> bool:
    """check_first: the control's trades equal the pre-switch engine's, once the keys EXP-0037 added are set aside."""
    def strip(t: Mapping[str, Any]) -> dict[str, Any]:
        return {k: v for k, v in t.items() if k not in ENGINE_KEYS}
    return [strip(t) for t in old] == [strip(t) for t in new]


# ---------------------------------------------------------------- the verdict
def session_range(rop: Sequence[float], days: Sequence[str], seed: int) -> tuple[float, float]:
    """The bootstrap range of the mean, resampling sessions with replacement (RESAMPLES times; numpy's PCG64 seeded
    `seed`; numpy's linear percentiles at INTERVAL). Each resample's mean is over the trades of its sessions."""
    r = np.asarray(rop, dtype=float)
    _, day_of = np.unique(np.asarray(days).astype(str), return_inverse=True)
    sums, counts = np.bincount(day_of, weights=r), np.bincount(day_of)
    rng = np.random.Generator(np.random.PCG64(seed))
    pick = rng.integers(0, len(sums), size=(RESAMPLES, len(sums)))
    boots = sums[pick].sum(axis=1) / counts[pick].sum(axis=1)
    lo, hi = np.percentile(boots, INTERVAL, method="linear")
    return float(lo), float(hi)


def _total(trades: Sequence[Mapping[str, Any]]) -> float:
    return float(sum(float(t["rop"]) for t in trades))


def verdict(variant: str, control_1x: Sequence[Mapping[str, Any]], variant_1x: Sequence[Mapping[str, Any]],
            control_2x: Sequence[Mapping[str, Any]], variant_2x: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """One hypothesis's reading: supported, falsified or too_few, with every number behind it."""
    added, displaced = groups(control_1x, variant_1x)
    added_2x, _ = groups(control_2x, variant_2x)
    rop = [float(t["rop"]) for t in added]
    mean_2x = float(np.mean([float(t["rop"]) for t in added_2x])) if added_2x else None
    days = [str(t["session"]) for t in added]
    n_sessions = len(set(days))
    out: dict[str, Any] = {
        "hypothesis": HYPOTHESES[variant], "variant": variant, "seed": SEEDS[variant],
        "added": len(added), "added_sessions": n_sessions, "displaced": len(displaced),
        "added_mean_1x": round(float(np.mean(rop)), 6) if rop else None,
        "added_mean_2x": round(mean_2x, 6) if mean_2x is not None else None,
        "added_2x": len(added_2x),
        "displaced_mean_1x": round(float(np.mean([float(t["rop"]) for t in displaced])), 6) if displaced else None,
        "total_1x": {"variant": round(_total(variant_1x), 6), "control": round(_total(control_1x), 6)},
        "range_1x": None,
    }
    if len(added) < MIN_ADDED or n_sessions < MIN_SESSIONS:
        out["verdict"] = "too_few"
        return out
    lo, hi = session_range(rop, days, SEEDS[variant])
    out["range_1x"] = [round(lo, 6), round(hi, 6)]
    tests = {"range_low_above_0": lo > 0,
             "mean_2x_above_0": mean_2x is not None and mean_2x > 0,          # unrounded
             "total_not_below_control": _total(variant_1x) - _total(control_1x) >= 0}
    out["tests"] = tests
    out["verdict"] = "supported" if all(tests.values()) else "falsified"
    return out
