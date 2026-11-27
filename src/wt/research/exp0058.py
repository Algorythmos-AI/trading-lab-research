"""EXP-0058: classifier v3 on fiscal.ai headlines (DEC-0082).

Two steps, each run by its own script:

  draw   build the frame (fiscal.ai items for pool names in the pool's own window, on the 43 post-holdout sessions),
         then draw 100 items, stratified by v3's category, and the 30 owner-blind ids (`scripts/exp0058_sample.py`)
  score  read the labels, build the owner review queue, and give the verdict (`scripts/exp0058_score.py`)

Headlines are RESTRICTED and this repository is public (DEC-0082 point 8). Nothing here prints or logs a headline.
The files that hold headline text are written to the private archive clone only; the public folder gets item ids,
sha256 sums, counts and the report. `check_public` refuses a public object that carries a headline field.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import random
import re
from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from pathlib import Path
from typing import Any

import pandas as pd

from wt.core.clock import ET
from wt.research.exp0057 import Share, accepted
from wt.scanner.catalyst import EXCLUDED, QUALIFYING, classify_spec

__all__ = ["accepted"]

FRAME = (dt.date(2026, 9, 28), dt.date(2026, 11, 25))
SESSIONS_IN_FRAME = 43
CLASSIFIER_SHA256 = "96411f7a9016c3b8aee4ef2a6981a8c8bef9f6dd7943c6710fc6b2cf015d157f"
SEED = 5801
N = 100
PER_CATEGORY = 9
OWNER_BLIND = 30
TARGET = 0.85
MIN_LABELLED = 80
LABELLER_MIN = 0.85
WINDOW_START = dt.time(16, 0)
CUT = dt.time(9, 25)
ID_PREFIX = "F"
CATS = ("fda_approval", "clinical_study_results", "earnings_release", "price_target_upgrade", "breaking_news",
        "buyout_offer", "unconfirmed_rumor", "offering_dilution", "reverse_split", "hype_only", "none")
_PUBLIC_FORBIDDEN = re.compile(r"(^|_)(headline|headlines|text|url|title)(_|$)", re.I)


class Refused(RuntimeError):
    """A step that the records do not allow; nothing was written."""


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def check_classifier(path: Path) -> None:
    """DEC-0082 point 1: v3 is read by its sha256 and any other file is refused."""
    got = sha256(path)
    if got != CLASSIFIER_SHA256:
        raise Refused(f"{path.name} is not classifier v3 (sha256 {got[:16]}, frozen {CLASSIFIER_SHA256[:16]})")


def decision(category: str) -> str:
    return "qualifying" if category in QUALIFYING else "excluded" if category in EXCLUDED else "non_qualifying"


def normalise(headline: str) -> str:
    return " ".join(headline.lower().split())


def window(session: dt.date, prev_session: dt.date) -> tuple[pd.Timestamp, pd.Timestamp]:
    """16:00 New York on the previous session, and the 09:25 cut on the session (both inclusive)."""
    if prev_session >= session:
        raise ValueError("the previous session must come before the session")
    return (pd.Timestamp(dt.datetime.combine(prev_session, WINDOW_START), tz=ET),
            pd.Timestamp(dt.datetime.combine(session, CUT), tz=ET))


def previous(sessions: Sequence[dt.date]) -> dict[dt.date, dt.date]:
    s = sorted(set(sessions))
    return {b: a for a, b in zip(s, s[1:], strict=False)}


def frame(pools: Mapping[dt.date, Iterable[str]], prev: Mapping[dt.date, dt.date],
          items: pd.DataFrame) -> list[dict[str, Any]]:
    """DEC-0082 point 2. One row per (normalised headline, session), the lowest id kept.

    An item belongs to a session when its `created_at` is in that session's window and one of its symbols is in the
    session's pool; the row's symbol is the first such symbol in the item's own order. Only `created_at`
    places an item. The archive keeps an item's latest edit, so `edited_after_cut` marks text the pool may not have
    seen (plan R4); it is counted, not dropped.
    """
    created = pd.to_datetime(items["created_at"], utc=True) if len(items) else pd.Series([], dtype="datetime64[ns, UTC]")
    rows: dict[tuple[str, dt.date], dict[str, Any]] = {}
    for session in sorted(pools):
        if session not in prev:
            raise ValueError(f"{session}: no previous session in the calendar")
        names = set(pools[session])
        lo, hi = window(session, prev[session])
        inside = items[(created >= lo) & (created <= hi)]
        for it in inside.itertuples(index=False):
            headline = str(it.headline or "").strip()
            sym = next((s for s in (it.symbols or []) if s in names), None)
            if not headline or sym is None:
                continue
            key = (normalise(headline), session)
            cur = rows.get(key)
            if cur is None or int(it.id) < cur["id"]:
                rows[key] = {"id": int(it.id), "session": session, "symbol": sym, "headline": headline,
                             "created_at": str(it.created_at),
                             "edited_after_cut": bool(pd.Timestamp(str(it.updated_at)) > hi)}
    out = sorted(rows.values(), key=lambda r: (r["session"], r["id"]))
    for r in out:
        r["v3"] = classify_spec(r["headline"])
    return out


def draw(rows: Sequence[Mapping[str, Any]], seed: int = SEED, n: int = N, per_category: int = PER_CATEGORY,
         owner_blind: int = OWNER_BLIND) -> tuple[list[dict[str, Any]], list[str]]:
    """DEC-0082 point 3: up to `per_category` per v3 category first (in CATS order), then the rest at random, shuffled
    and numbered F001...; then `owner_blind` ids drawn by the same generator. Deterministic for a given frame."""
    if len(rows) < n:
        raise Refused(f"the frame holds {len(rows)} items, fewer than the {n} the sample needs")
    unknown = {r["v3"] for r in rows} - set(CATS)
    if unknown:
        raise ValueError(f"categories outside the spec: {sorted(unknown)}")
    rng = random.Random(seed)
    order = sorted(rows, key=lambda r: (r["session"], r["id"]))
    picked: list[Mapping[str, Any]] = []
    for c in CATS:
        members = [r for r in order if r["v3"] == c]
        picked += rng.sample(members, min(per_category, len(members)))
    taken = {r["id"] for r in picked}
    rest = [r for r in order if r["id"] not in taken]
    picked += rng.sample(rest, n - len(picked)) if len(picked) < n else []
    rng.shuffle(picked)
    sample = [{**r, "item_id": f"{ID_PREFIX}{i:03d}"} for i, r in enumerate(picked, 1)]
    blind = sorted(rng.sample([s["item_id"] for s in sample], owner_blind))
    return sample, blind


# ---- scoring ----------------------------------------------------------------------------------------------------


def _check_labels(name: str, labels: Mapping[str, str], ids: set[str]) -> None:
    bad = sorted(v for v in set(labels.values()) if v not in CATS)
    if bad:
        raise ValueError(f"{name}: labels outside the spec's categories: {bad}")
    extra = sorted(set(labels) - ids)
    if extra:
        raise ValueError(f"{name}: ids not in the sample: {extra[:5]}")


def validate(ids: Iterable[str], agent: Mapping[str, str], owner_blind_ids: Sequence[str],
             owner_blind: Mapping[str, str], owner_review: Mapping[str, str]) -> None:
    """Every label is a spec category and names an item it may name; raises ValueError otherwise."""
    known = set(ids)
    for name, d in (("agent", agent), ("owner_blind", owner_blind), ("owner_review", owner_review)):
        _check_labels(name, d, known)
    if set(owner_blind) - set(owner_blind_ids):
        raise ValueError("owner_blind: a label for an item outside the owner-blind ids")


def label_digest(labels: Mapping[str, str]) -> str:
    """sha256 of the sorted (item_id, label) pairs: a re-saved file with the same labels gives the same digest."""
    text = "\n".join(f"{i}\t{v}" for i, v in sorted(labels.items()))
    return hashlib.sha256(text.encode()).hexdigest()


def reference(ids: Iterable[str], agent: Mapping[str, str], owner_blind: Mapping[str, str],
              owner_review: Mapping[str, str]) -> dict[str, tuple[str, str]]:
    """DEC-0082 point 4: id -> (label, source), owner review first, then owner blind, then agent blind."""
    out: dict[str, tuple[str, str]] = {}
    for i in ids:
        for src, d in (("owner_review", owner_review), ("owner_blind", owner_blind), ("agent_blind", agent)):
            if i in d:
                out[i] = (d[i], src)
                break
    return out


def review_queue(v3: Mapping[str, str], agent: Mapping[str, str], owner_blind: Mapping[str, str],
                 owner_review: Mapping[str, str]) -> list[str]:
    """Items where v3 and the best label so far (owner blind, else agent) disagree at the decision level, and that the
    owner has not yet ruled on."""
    best = {**agent, **owner_blind}
    return sorted(i for i in v3 if i in best and i not in owner_review and decision(v3[i]) != decision(best[i]))


def score(sample_v3: Mapping[str, str], strata_population: Mapping[str, int], agent: Mapping[str, str],
          owner_blind_ids: Sequence[str], owner_blind: Mapping[str, str],
          owner_review: Mapping[str, str]) -> dict[str, Any]:
    """The EXP-0058 report (counts and shares only). `complete` is False while a label or a ruling is missing."""
    ids = set(sample_v3)
    validate(ids, agent, owner_blind_ids, owner_blind, owner_review)
    ref = reference(sorted(ids), agent, owner_blind, owner_review)
    labelled = sorted(ref)
    dec = Share(sum(decision(sample_v3[i]) == decision(ref[i][0]) for i in labelled), len(labelled))
    exact = Share(sum(sample_v3[i] == ref[i][0] for i in labelled), len(labelled))
    checked = [i for i in owner_blind_ids if i in owner_blind and i in agent]
    check = Share(sum(decision(agent[i]) == decision(owner_blind[i]) for i in checked), len(checked))
    owner_only = Share(sum(decision(sample_v3[i]) == decision(owner_blind[i]) for i in owner_blind_ids
                           if i in owner_blind), sum(1 for i in owner_blind_ids if i in owner_blind))
    total = sum(strata_population.values())
    weighted = 0.0
    for c, pop in strata_population.items():
        members = [i for i in labelled if sample_v3[i] == c]
        if pop and members:
            weighted += pop / total * sum(decision(c) == decision(ref[i][0]) for i in members) / len(members)
    queue = review_queue(sample_v3, agent, owner_blind, owner_review)
    missing_agent = sorted(ids - set(agent))
    missing_owner = sorted(set(owner_blind_ids) - set(owner_blind))
    complete = not (missing_agent or missing_owner or queue)
    conf = Counter((ref[i][0], sample_v3[i]) for i in labelled)
    return {
        "experiment": "EXP-0058", "decision": "DEC-0082", "classifier_sha256": CLASSIFIER_SHA256,
        "complete": complete,
        "missing": {"agent_labels": len(missing_agent), "owner_blind_labels": len(missing_owner),
                    "owner_rulings": len(queue)},
        "sample_n": len(ids), "labelled_n": len(labelled),
        "reference_sources": dict(Counter(src for _, src in ref.values())),
        "decision_level": dec.as_dict(),
        "labeller_check": check.as_dict(),
        "owner_only": owner_only.as_dict(),
        "exact_category": exact.as_dict(),
        "population_weighted_decision_level": weighted if labelled else None,
        "confusion": [{"reference": a, "v3": b, "n": k} for (a, b), k in sorted(conf.items())],
        "verdict": verdict(dec, check) if complete else "pending",
    }


def verdict(dec: Share, check: Share) -> str:
    """DEC-0082 point 6. Reads the point figures; the Wilson intervals are reported beside them."""
    if dec.n < MIN_LABELLED or check.n < OWNER_BLIND or (check.value or 0.0) < LABELLER_MIN:
        return "not_decidable"
    return "pass" if (dec.value or 0.0) >= TARGET else "fail"


def check_public(obj: object, path: str = "") -> None:
    """Refuse a public object with a field that could carry headline text (DEC-0082 point 8)."""
    if isinstance(obj, Mapping):
        for k, v in obj.items():
            if _PUBLIC_FORBIDDEN.search(str(k)):
                raise ValueError(f"public output carries a text field: {path}{k}")
            check_public(v, f"{path}{k}.")
    elif isinstance(obj, list | tuple):
        for v in obj:
            check_public(v, path)
