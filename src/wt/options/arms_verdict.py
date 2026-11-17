"""The verdicts of the clone's research arms (DEC-0041 point 7; EXP-0030; HYP-0034 to HYP-0047). Pure: rows in,
figures out, no I/O. `scripts/options_clone_arms_verdict.py` reads the files and writes each report once.

Inputs: the clone's journal (`trade_closed` rows), its decision lines (each entered signal's `arms` object carries
the trade id it opened, its tags, the release and the control's config hash) and the shadow file's records.

Each trial's unit, all return on premium after $0.03 a contract each way, resampled by session (DEC-0030 section 6):

- a tag trial (NTZ, GAP, LEADER, IVGATE, EARLY): the control's trades of its base setup (`review.trial_of`), in the
  window of EXP-0029 (sessions from `review.SPREAD5_START`; DEC-0056 left this open-ended, since the hash rule of
  point 5 already ends a trial at the first session under another config), split by the flag. A trade whose flag is None is in
  neither group and is counted apart; a trade without the flag (LEADER outside QQQ) is not in the trial. The
  quantity is the difference in means, the rest minus the tagged (EARLY: early minus late). Count: 30 trades in
  each group and 20 sessions.
- a runner trial: per real trade of its base setup, the virtual runner's return minus the real one's (paired). Count:
  30 pairs and 20 sessions.
- TRAP and RECLAIM-FAST: each closed virtual trade's own return. Count: 30 trades and 20 sessions.

Falsified when the lower end of the 95% bootstrap range is at or below zero, or the quantity is at or below zero in
either half of the units taken in order; passes otherwise. A trial that has not reached its count by CLOSE_DATE
closes with no verdict.

Window (DEC-0041 point 5): only units stamped by a release that writes the arms count, and only while the control's
config hash is the one the trial's first unit carried; from the first session under another hash the trial stops
with what it has.

Before a trial reaches its count or its close date, `status` gives counts only (trades per group, sessions), never a
mean or a split of returns: nothing about an arm's result is shown before its report.
"""
from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

import numpy as np

from wt.options import review

CLOSE_DATE = "2027-11-05"
MIN_UNITS, MIN_SESSIONS = 30, 20
SEED, N_BOOT = 7, 5000


@dataclass(frozen=True)
class Trial:
    name: str
    hyp: str
    kind: str          # tag | runner | own
    base: str          # retest | rejection | trap | reclaim_fast
    flag: str = ""     # tag trials: the key in the `arms` object
    tagged_first: bool = False   # EARLY: the quantity is the flagged group minus the rest (early minus late)


TRIALS: tuple[Trial, ...] = (
    Trial("OC-NTZ-RETEST", "HYP-0034", "tag", "retest", "ntz"),
    Trial("OC-NTZ-REJECT", "HYP-0035", "tag", "rejection", "ntz"),
    Trial("OC-GAP-RETEST", "HYP-0036", "tag", "retest", "gap_against"),
    Trial("OC-GAP-REJECT", "HYP-0037", "tag", "rejection", "gap_against"),
    Trial("OC-LEADER-RETEST", "HYP-0038", "tag", "retest", "leader_against"),
    Trial("OC-LEADER-REJECT", "HYP-0039", "tag", "rejection", "leader_against"),
    Trial("OC-IVGATE-RETEST", "HYP-0040", "tag", "retest", "iv_rich"),
    Trial("OC-IVGATE-REJECT", "HYP-0041", "tag", "rejection", "iv_rich"),
    Trial("OC-EARLY-RETEST", "HYP-0042", "tag", "retest", "early", tagged_first=True),
    Trial("OC-EARLY-REJECT", "HYP-0043", "tag", "rejection", "early", tagged_first=True),
    Trial("OC-RUNNER-RETEST", "HYP-0044", "runner", "retest"),
    Trial("OC-RUNNER-REJECT", "HYP-0045", "runner", "rejection"),
    Trial("OC-TRAP", "HYP-0046", "own", "trap"),
    Trial("OC-RECLAIM-FAST", "HYP-0047", "own", "reclaim_fast"),
)
BY_NAME = {t.name: t for t in TRIALS}


@dataclass(frozen=True)
class Unit:
    session: str
    value: float
    group: bool | None = None     # tag trials: the flag; the others: None
    release: str = ""
    config: str = ""


def _f(v: Any) -> float | None:
    if isinstance(v, bool):
        return None
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return x if np.isfinite(x) else None


def tags_by_trade(decisions: Sequence[Mapping[str, Any]]) -> dict[str, Mapping[str, Any]]:
    """trade id -> the `arms` object of the signal that opened it."""
    out: dict[str, Mapping[str, Any]] = {}
    for d in decisions:
        for s in d.get("signals") or []:
            arms = s.get("arms") if isinstance(s, Mapping) else None
            if isinstance(arms, Mapping) and isinstance(arms.get("trade_id"), str):
                out[str(arms["trade_id"])] = arms
    return out


def units(trial: Trial, trades: Sequence[Mapping[str, Any]], decisions: Sequence[Mapping[str, Any]],
          shadow: Sequence[Mapping[str, Any]]) -> tuple[list[Unit], int, int]:
    """The trial's units in session order, how many trades were left out with an unknown flag, and how many units
    were left out because the release that wrote them is unknown."""
    closed = [r for r in trades if r.get("event") == "trade_closed" and review.session_of(r) >= review.SPREAD5_START
              and r.get("counts") and _f(r.get("rop")) is not None]   # open-ended: the hash rule below ends a trial
    mine = {str(r["trade_id"]): r for r in closed
            if review.trial_of(str(r.get("setup")), str(r.get("symbol", "")), review.session_of(r)) == trial.base}
    out: list[Unit] = []
    unknown = 0
    if trial.kind == "tag":
        tags = tags_by_trade(decisions)
        for tid, r in mine.items():
            t = tags.get(tid)
            if t is None or trial.flag not in t:
                continue
            g = t[trial.flag]
            if not isinstance(g, bool):
                unknown += 1
                continue
            out.append(Unit(review.session_of(r), float(r["rop"]), g, str(t.get("release", "")),
                            str(t.get("config", ""))))
    elif trial.kind == "runner":
        for v in shadow:
            if v.get("arm") != "runner" or v.get("event") != "closed" or str(v.get("paired")) not in mine:
                continue
            real, rop = mine[str(v["paired"])], _f(v.get("rop"))
            if rop is None:
                continue
            out.append(Unit(review.session_of(real), rop - float(real["rop"]), None, str(v.get("release", "")),
                            str(v.get("config", ""))))
    else:
        for v in shadow:
            rop = _f(v.get("rop"))
            if v.get("arm") == trial.base and v.get("event") == "closed" and rop is not None:
                out.append(Unit(str(v.get("vid", ""))[:10], rop, None, str(v.get("release", "")),
                                str(v.get("config", ""))))
    out.sort(key=lambda u: u.session)
    return window(out), unknown, sum(u.release == "unknown" for u in out)


def window(us: Sequence[Unit]) -> list[Unit]:
    """Units stamped by a known release only, under the first unit's config hash; from the first session under
    another, nothing."""
    stamped = [u for u in us if u.release and u.release != "unknown" and u.config]
    if not stamped:
        return []
    first = stamped[0].config
    changed = next((u.session for u in stamped if u.config != first), None)
    return [u for u in stamped if changed is None or u.session < changed]


def counts(trial: Trial, us: Sequence[Unit]) -> dict[str, Any]:
    """Counts only: what may be shown before the report."""
    out: dict[str, Any] = {"sessions": len({u.session for u in us})}
    if trial.kind == "tag":
        out |= {"tagged": sum(u.group is True for u in us), "rest": sum(u.group is False for u in us)}
    else:
        out["units"] = len(us)
    return out


def reached(trial: Trial, us: Sequence[Unit]) -> bool:
    c = counts(trial, us)
    n = min(c["tagged"], c["rest"]) if trial.kind == "tag" else c["units"]
    return bool(n >= MIN_UNITS and c["sessions"] >= MIN_SESSIONS)


def quantity(trial: Trial, us: Sequence[Unit]) -> float | None:
    """The trial's quantity on `us`: a difference of means (tag), or a mean."""
    if trial.kind != "tag":
        return float(np.mean([u.value for u in us])) if us else None
    a = [u.value for u in us if u.group is True]
    b = [u.value for u in us if u.group is False]
    if not a or not b:
        return None
    diff = float(np.mean(b) - np.mean(a))
    return -diff if trial.tagged_first else diff


def bootstrap(trial: Trial, us: Sequence[Unit], seed: int = SEED, n_boot: int = N_BOOT) -> list[float] | None:
    """The 95% percentile range of the quantity, resampling whole sessions with replacement. A resample in which a
    tag group is empty is drawn again."""
    days = sorted({u.session for u in us})
    if len(days) < 2:
        return None
    by_day = {d: [u for u in us if u.session == d] for d in days}
    rng = np.random.default_rng(seed)
    got: list[float] = []
    tries = 0
    while len(got) < n_boot and tries < 20 * n_boot:
        tries += 1
        pick = rng.integers(0, len(days), size=len(days))
        sample = [u for i in pick for u in by_day[days[int(i)]]]
        q = quantity(trial, sample)
        if q is not None:
            got.append(q)
    if not got:
        return None
    return [float(np.percentile(got, 2.5)), float(np.percentile(got, 97.5))]


def decide(trial: Trial, us: Sequence[Unit], today: str) -> dict[str, Any]:
    """The trial's report: `pending` (counts only), `closed-no-verdict`, `falsified` or `passes`."""
    c = counts(trial, us)
    if not reached(trial, us):
        if today < CLOSE_DATE:
            return {"trial": trial.name, "hypothesis": trial.hyp, "status": "pending", **c}
        return {"trial": trial.name, "hypothesis": trial.hyp, "status": "closed-no-verdict", **c,
                "why": [f"fewer than {MIN_UNITS} units (per group) or {MIN_SESSIONS} sessions by {CLOSE_DATE}"]}
    half = len(us) // 2
    q, ci = quantity(trial, us), bootstrap(trial, us)
    h1, h2 = quantity(trial, us[:half]), quantity(trial, us[half:])
    why: list[str] = []
    if ci is None or ci[0] <= 0:
        why.append("range-by-session-not-above-zero")
    if h1 is None or h1 <= 0:
        why.append("first-half-not-above-zero")
    if h2 is None or h2 <= 0:
        why.append("second-half-not-above-zero")
    r = 4
    return {"trial": trial.name, "hypothesis": trial.hyp, "status": "falsified" if why else "passes", **c,
            "quantity": None if q is None else round(q, r), "ci_session": None if ci is None else [round(x, r) for x in ci],
            "first_half": None if h1 is None else round(h1, r), "second_half": None if h2 is None else round(h2, r),
            "releases": sorted({u.release for u in us}), "config": us[0].config if us else None,
            "why": why or ["range by session above zero", "both halves above zero"]}


def render(res: Mapping[str, Any]) -> str:
    """One trial's report.md."""
    lines = [f"# EXP-0030: {res['trial']} ({res['hypothesis']}): report", "",
             "- Decision: DEC-0041. Unit: return on premium after $0.03 a contract each way; ranges by session, "
             f"percentile bootstrap, {N_BOOT} resamples, seed {SEED}.", "",
             f"- Status: **{res['status']}**", ""]
    for k in ("tagged", "rest", "units", "sessions", "quantity", "ci_session", "first_half", "second_half",
              "releases", "config"):
        if k in res:
            lines.append(f"- {k}: {res[k]}")
    lines += [f"- why: {'; '.join(res.get('why', []))}", "",
              "A pass changes no rule: a gate, or trading a shadow arm, needs its own record and new trials.", ""]
    return "\n".join(lines)
