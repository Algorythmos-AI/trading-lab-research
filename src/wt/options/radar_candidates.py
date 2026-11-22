"""The Radar's candidates for the Options desk's selection (DEC-0070, PROPOSED): a deterministic reading of one stored
`stocksdelta/radar` edition, so the AI research and the rule-based selection meet at a checked, hashed record.

    candidates = extract(edition, session, run_at, desk, cfg)

`edition` is the edition the site stores (the signed GET /api/editions/radar, `wt.options.pipeline_check.read_edition`),
or None when none could be read. `session` is S, the session being selected for; `run_at` the run's clock (aware);
`desk` the desk's 12 names (config/options_desk.yaml). Pure: no network, no clock.

What the record holds: codes, counts, dates, grades and hashes. No `why`, note, label, headline or company text of the
edition is carried (the data classes of AGENTS.md; the edition's prose stays in the edition).

The status is one of:
- `ok`: the edition is S's, fresh, and readable; `candidates` lists every in-scope symbol.
- `radar_missing`: no edition was read.
- `radar_stale`: the edition is not S's, or was stamped before the close of the session before S or after the run,
  or its prices are older than the limit (or carry no time).
- `radar_invalid`: the edition is not one this code reads (schema, shape, or more in-scope symbols than the limit).
Any status but `ok` gives no candidates: the selection then runs on the desk's 12 alone and says so.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from wt.options import levels as lv
from wt.options import select as sel

SCHEMA = "wt.options/radar-candidates"
VERSION = 1
EXTRACTOR_VERSION = "radar-candidates/1"
EDITION_SCHEMA = "stocksdelta/radar"
STATUSES = ("ok", "radar_missing", "radar_stale", "radar_invalid")
SYMBOL_REJECTS = ("malformed_symbol",)
CONFIG_PATH = sel.ROOT / "config" / "options_universe.yaml"

# A US listed symbol as the desk reads it: one to five letters, an optional class letter after a dot (BRK.B).
_SYMBOL = re.compile(r"[A-Z]{1,5}(?:\.[A-Z])?")
# Calendar labels: a ticker is a whole upper-case word of one to five letters, as trading-options-funnel's desk file
# reads them. Used only to reject (a report named on S or the next session), never to admit.
_LABEL_TICKER = re.compile(r"\b[A-Z]{1,5}(?:\.[A-Z])?\b")
_DATE = re.compile(r"\d{4}-\d{2}-\d{2}")
_RUN_ID = re.compile(r"[A-Za-z0-9._:-]{1,80}")


class ConfigError(ValueError):
    """config/options_universe.yaml does not hold what this code implements."""


# ---------------------------------------------------------------- the configuration

GATE_THRESHOLDS = ("price_min", "median_dollar_volume_min", "chain_ntm_strikes_min", "chain_volume_min",
                   "chain_spread_max_pct")


@dataclass(frozen=True)
class Config:
    lists_in_scope: tuple[str, ...]
    max_candidates_in: int
    prices_max_age_minutes: int
    aliases: dict[str, str]
    max_additions: int
    price_min: float | None
    median_dollar_volume_min: float | None
    chain_expiry_max_days: int
    chain_ntm_strikes_min: int | None
    chain_ntm_pct: float
    chain_volume_min: float | None
    chain_spread_max_pct: float | None
    list_priority: tuple[str, ...]
    sha: str

    def unset(self) -> list[str]:
        """The gate thresholds still null: while any is, real data is never gated (`require_thresholds`)."""
        return [k for k in GATE_THRESHOLDS if getattr(self, k) is None]

    def require_thresholds(self) -> None:
        if missing := self.unset():
            raise ConfigError(f"gate thresholds not set (a dated amendment to DEC-0070 sets them): {missing}")


def _exactly(node: Any, keys: set[str], what: str) -> Mapping[str, Any]:
    if not isinstance(node, Mapping) or set(node) != keys:
        raise ConfigError(f"{what} must hold exactly {sorted(keys)}")
    return node


def _pos_int(v: Any, what: str, low: int = 1) -> int:
    if isinstance(v, bool) or not isinstance(v, int) or v < low:
        raise ConfigError(f"{what} must be an integer >= {low}")
    return int(v)


def _opt_num(v: Any, what: str, *, integer: bool = False) -> Any:
    if v is None:
        return None
    if isinstance(v, bool) or not isinstance(v, (int, float)) or v < 0 or (integer and not isinstance(v, int)):
        raise ConfigError(f"{what} must be null or a non-negative {'integer' if integer else 'number'}")
    return v


def _names(v: Any, what: str) -> tuple[str, ...]:
    if not isinstance(v, list) or not v or not all(isinstance(x, str) and x.strip() == x and x for x in v) \
            or len(set(v)) != len(v):
        raise ConfigError(f"{what} must be a list of distinct non-empty names")
    return tuple(v)


def config_from_mapping(cfg: Any) -> Config:
    top = _exactly(cfg, {"version", "radar", "gate", "list_priority"}, "the file")
    if top["version"] != 1 or isinstance(top["version"], bool):
        raise ConfigError("version must be 1")
    r = _exactly(top["radar"], {"lists_in_scope", "max_candidates_in", "prices_max_age_minutes", "aliases"}, "radar")
    g = _exactly(top["gate"], {"max_additions", "price_min", "median_dollar_volume_min", "chain_expiry_max_days",
                               "chain_ntm_strikes_min", "chain_ntm_pct", "chain_volume_min",
                               "chain_spread_max_pct"}, "gate")
    aliases = r["aliases"]
    if not isinstance(aliases, Mapping) or not all(
            isinstance(k, str) and isinstance(v, str) and _SYMBOL.fullmatch(k) and _SYMBOL.fullmatch(v) and k != v
            for k, v in aliases.items()):
        raise ConfigError("radar.aliases must map a symbol to another symbol")
    if any(v in aliases for v in aliases.values()):
        raise ConfigError("radar.aliases must not chain")
    in_scope = _names(r["lists_in_scope"], "radar.lists_in_scope")
    priority = _names(top["list_priority"], "list_priority")
    if set(priority) != set(in_scope):
        raise ConfigError("list_priority must order exactly the lists in scope")
    ntm = g["chain_ntm_pct"]
    if isinstance(ntm, bool) or not isinstance(ntm, float) or not 0 < ntm < 1:
        raise ConfigError("gate.chain_ntm_pct must be a fraction between 0 and 1, written as a float")
    return Config(
        lists_in_scope=in_scope,
        max_candidates_in=_pos_int(r["max_candidates_in"], "radar.max_candidates_in"),
        prices_max_age_minutes=_pos_int(r["prices_max_age_minutes"], "radar.prices_max_age_minutes"),
        aliases=dict(aliases),
        max_additions=_pos_int(g["max_additions"], "gate.max_additions", 0),
        price_min=_opt_num(g["price_min"], "gate.price_min"),
        median_dollar_volume_min=_opt_num(g["median_dollar_volume_min"], "gate.median_dollar_volume_min"),
        chain_expiry_max_days=_pos_int(g["chain_expiry_max_days"], "gate.chain_expiry_max_days", 0),
        chain_ntm_strikes_min=_opt_num(g["chain_ntm_strikes_min"], "gate.chain_ntm_strikes_min", integer=True),
        chain_ntm_pct=ntm,
        chain_volume_min=_opt_num(g["chain_volume_min"], "gate.chain_volume_min"),
        chain_spread_max_pct=_opt_num(g["chain_spread_max_pct"], "gate.chain_spread_max_pct"),
        list_priority=priority,
        sha=hashlib.sha256(sel.canonical_json(cfg).encode("ascii")).hexdigest(),
    )


def load_config(path: Path = CONFIG_PATH) -> Config:
    import yaml
    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, yaml.YAMLError) as e:
        raise ConfigError(f"cannot be read ({type(e).__name__})") from e
    return config_from_mapping(raw)


# ---------------------------------------------------------------- symbols and times

def normalise(raw: Any, aliases: Mapping[str, str]) -> str | None:
    """The desk's form of a symbol (upper case; BRK-B, BRK/B and BRK.B all BRK.B; an alias folded into its target),
    or None when it is not a symbol."""
    if not isinstance(raw, str):
        return None
    s = raw.strip().upper().replace("/", ".").replace("-", ".")
    if not _SYMBOL.fullmatch(s):
        return None
    return aliases.get(s, s)


def _instant(v: Any) -> dt.datetime | None:
    if not isinstance(v, str):
        return None
    try:
        t = dt.datetime.fromisoformat(v.replace("Z", "+00:00"))
    except ValueError:
        return None
    return t if t.tzinfo is not None else None


def close_utc(day: str) -> dt.datetime:
    """The exchange's close of `day`: 16:00 New York, 13:00 on a half day."""
    from wt.options import select_stage2 as s2
    return s2.ny_time(day, (13, 0) if day in lv.HALF_DAYS else (16, 0))


def edition_sha(edition: Mapping[str, Any]) -> str:
    return hashlib.sha256(sel.canonical_json(edition).encode("ascii")).hexdigest()


def _matching(v: Any, pattern: re.Pattern[str]) -> str | None:
    """`v` when it is a string the pattern matches whole, else None: nothing free-form from the edition is kept."""
    return v if isinstance(v, str) and pattern.fullmatch(v) else None


def _grade(v: Any) -> int | None:
    return v if isinstance(v, int) and not isinstance(v, bool) and 1 <= v <= 3 else None


# ---------------------------------------------------------------- the extraction

def _record(session: str, run_at: dt.datetime, status: str, cfg: Config, *, provenance: dict[str, Any] | None = None,
            candidates: list[dict[str, Any]] | None = None, counts: dict[str, Any] | None = None,
            detail: str | None = None) -> dict[str, Any]:
    return {
        "schema": SCHEMA,
        "version": VERSION,
        "extractor_version": EXTRACTOR_VERSION,
        "universe_sha": cfg.sha,
        "session": session,
        "run_at": run_at.astimezone(dt.UTC).isoformat(),
        "status": status,
        "detail": detail,
        "provenance": provenance,
        "counts": counts or {"in_scope_symbols": 0, "out_of_scope_symbols": 0, "unknown_lists": 0,
                             "rejected": {}, "candidates": 0, "core": 0, "discovered": 0},
        "candidates": candidates or [],
    }


def extract(edition: Any, session: str, run_at: dt.datetime, desk: Sequence[str], cfg: Config) -> dict[str, Any]:
    """The candidate record for session `session` from `edition` (see the module text)."""
    if run_at.tzinfo is None:
        raise ValueError("run_at must be timezone-aware")
    if ev_date(session) is None or not lv.is_session(session):
        raise ValueError(f"{session} is not a session date")
    if edition is None:
        return _record(session, run_at, "radar_missing", cfg, detail="no edition read")
    if not isinstance(edition, Mapping) or edition.get("schema") != EDITION_SCHEMA:
        return _record(session, run_at, "radar_invalid", cfg, detail="not a stocksdelta/radar edition")
    try:
        sha = edition_sha(edition)
    except (TypeError, ValueError):
        return _record(session, run_at, "radar_invalid", cfg, detail="not canonical JSON")
    as_of, prices_at = _instant(edition.get("as_of")), _instant(edition.get("prices_as_of"))
    prov = {
        "run_id": _matching(edition.get("run_id"), _RUN_ID),
        "as_of": as_of.astimezone(dt.UTC).isoformat() if as_of else None,
        "edition_date": _matching(edition.get("edition_date"), _DATE),
        "prices_as_of": prices_at.astimezone(dt.UTC).isoformat() if prices_at else None,
        "edition_sha256": sha,
    }
    if prov["edition_date"] is None or ev_date(prov["edition_date"]) is None:
        return _record(session, run_at, "radar_invalid", cfg, provenance=prov, detail="edition_date is not a date")
    if prov["edition_date"] != session:
        return _record(session, run_at, "radar_stale", cfg, provenance=prov,
                       detail=f"edition is for {prov['edition_date']}, not {session}")
    if as_of is None or not (close_utc(lv.prev_session(session)) < as_of <= run_at):
        return _record(session, run_at, "radar_stale", cfg, provenance=prov,
                       detail="as_of missing, before the prior close, or after the run")
    if prices_at is None or run_at - prices_at > dt.timedelta(minutes=cfg.prices_max_age_minutes) \
            or prices_at > run_at:
        return _record(session, run_at, "radar_stale", cfg, provenance=prov, detail="prices too old or untimed")

    lists = edition.get("lists")
    tickers = edition.get("tickers")
    if not isinstance(lists, list) or not (tickers is None or isinstance(tickers, list)):
        return _record(session, run_at, "radar_invalid", cfg, provenance=prov, detail="lists or tickers malformed")

    in_scope: dict[str, set[str]] = {}
    out_of_scope: set[str] = set()
    unknown_lists = 0
    rejected: dict[str, int] = {}
    for item in lists:
        if not isinstance(item, Mapping) or not isinstance(item.get("name"), str):
            return _record(session, run_at, "radar_invalid", cfg, provenance=prov, detail="a list is malformed")
        name = item["name"].strip().upper()
        known = name in cfg.lists_in_scope
        syms = item.get("symbols") or []
        if not isinstance(syms, list):
            return _record(session, run_at, "radar_invalid", cfg, provenance=prov, detail="a list is malformed")
        if not known:
            unknown_lists += 1
        for raw in syms:
            s = normalise(raw, cfg.aliases)
            if s is None:
                rejected["malformed_symbol"] = rejected.get("malformed_symbol", 0) + 1
                continue
            if known:
                in_scope.setdefault(s, set()).add(name)
            else:
                out_of_scope.add(s)
    if len(in_scope) > cfg.max_candidates_in:
        return _record(session, run_at, "radar_invalid", cfg, provenance=prov,
                       detail=f"{len(in_scope)} in-scope symbols, more than {cfg.max_candidates_in}")

    grades: dict[str, Mapping[str, Any]] = {}
    for t in tickers or []:
        if isinstance(t, Mapping):
            s = normalise(t.get("symbol"), cfg.aliases)
            if s is not None and s in in_scope:
                # Two rows for one company (GOOG and GOOGL): keep the higher evidence grade, as written.
                old = grades.get(s)
                if old is None or (_grade(t.get("evidence_grade")) or 0) > (_grade(old.get("evidence_grade")) or 0):
                    grades[s] = t

    reports = calendar_earnings(edition, cfg)
    avoided = avoid_symbols(edition, cfg)
    core = set(desk)
    candidates = []
    for s in sorted(in_scope):
        t = grades.get(s, {})
        tag = t.get("tag")
        candidates.append({
            "symbol": s,
            "lists": sorted(in_scope[s], key=cfg.list_priority.index),
            "evidence_grade": _grade(t.get("evidence_grade")),
            "chart_grade": _grade(t.get("chart_grade")),
            "risk_tag": tag == "risk",
            "avoid": s in avoided,
            "core": s in core,
            "calendar_earnings": sorted(reports.get(s, set())),
        })
    counts = {
        "in_scope_symbols": len(in_scope),
        "out_of_scope_symbols": len(out_of_scope - set(in_scope)),
        "unknown_lists": unknown_lists,
        "rejected": dict(sorted(rejected.items())),
        "candidates": len(candidates),
        "core": sum(1 for c in candidates if c["core"]),
        "discovered": sum(1 for c in candidates if not c["core"]),
    }
    return _record(session, run_at, "ok", cfg, provenance=prov, candidates=candidates, counts=counts)


def calendar_earnings(edition: Mapping[str, Any], cfg: Config) -> dict[str, set[str]]:
    """{symbol: dates} from the edition's calendar rows of kind earnings, by the label's upper-case words. Only ever
    used to reject a candidate; the label text itself is not kept."""
    out: dict[str, set[str]] = {}
    rows = edition.get("calendar")
    if not isinstance(rows, list):
        return out
    for r in rows:
        # Only ever used to reject, so a row without a kind is read too (kind is optional in the edition).
        if not isinstance(r, Mapping) or r.get("kind") not in ("earnings", None):
            continue
        day, label = r.get("date"), r.get("label")
        if not isinstance(day, str) or not isinstance(label, str) or ev_date(day) is None:
            continue
        for tok in _LABEL_TICKER.findall(label):
            s = normalise(tok, cfg.aliases)
            if s is not None:
                out.setdefault(s, set()).add(day)
    return out


def avoid_symbols(edition: Mapping[str, Any], cfg: Config) -> set[str]:
    """The symbols the edition's `avoid` section names (its `symbols` text, by upper-case words). Only ever used to
    reject; the text itself is not kept."""
    out: set[str] = set()
    rows = edition.get("avoid")
    if not isinstance(rows, list):
        return out
    for r in rows:
        text = r.get("symbols") if isinstance(r, Mapping) else None
        if isinstance(text, str):
            for tok in _LABEL_TICKER.findall(text):
                if (sym := normalise(tok, cfg.aliases)) is not None:
                    out.add(sym)
    return out


def ev_date(s: str) -> str | None:
    from wt.risk import events as ev
    if not _DATE.fullmatch(s):                  # date.fromisoformat also takes 20261123; the desk writes 2026-11-23
        return None
    d = ev.exact_date(s)
    return None if d is None else s
