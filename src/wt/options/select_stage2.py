"""Stage 2 of the Options desk's two-stage selection (DEC-0046 section 5): before the open, every desk name is
checked against the overnight gap rules and given one status. Pure: a Stage 1 output, a saved Stage 2 input bundle,
the pass and the thresholds in; the confirmation of every name out.

The core (`confirm` and everything it calls) reads no file, makes no network call and reads no clock: the pass's
assessment time `T` is worked out from the session date and the pass's time of day in New York, never from the
clock. The same inputs give byte-identical output (`dumps`), whatever the order of the bundle's lists. Only `main`
and the loaders touch files. Nothing here fetches: `wt.options.select_fetch` saves the bundle this reads, and a
replay reads only that bundle.

The rules, in the record's words (DEC-0046 section 5), and where each is implemented:

- G1 `prior_close`: "the close of the last raw daily bar dated before the session, 'before' from the session
  calendar. The snapshot's previous daily bar is a cross-check only. When Alpaca's corporate actions show an ex-date
  on the session for the name, the gap is worked out from the adjusted close (a split by its ratio) and the card is
  marked `close_adjusted`."
- G2 `reference`: "the close of the last finished 1-minute SIP bar, valid only if that bar ended at most 120 s before
  `T`. Otherwise the bid/ask midpoint when both sides have a price and a size above zero and the spread is within the
  limit (the card says 'mid'). Otherwise none. The raw last trade and its age are shown as evidence only."
- G3 `gap`: "`gap_pct = ref / prior_close - 1`; `gap_atr = (ref - prior_close) / ATR14`" (ATR14 from the Stage 1 block).
- G4 `premarket_window`: "the sum of 5-minute bars with start >= 04:00 and end <= `T` (New York). A missing bar is
  zero volume; a bar still forming at `T` is dropped."
- G5 `relative_volume` (the one definition in the repository; see its docstring): "that sum / the median of the same
  window over the previous 20 sessions of the session calendar (half days included). Fewer than 10 complete sessions
  gives 'not available', a neutral mark."
- G6 `position`: "Pre-market high and low come from the same 5-minute bars, never from the daily bar. ... Position
  is one of: past upper target 1, above the ceiling, between, below the floor, past lower target 1." The ceiling,
  floor and targets come from the card-field code, which is not built: they are read from a Stage 1 row's `card`
  when present; when not, position reads "not available" and its check is undetermined (Amendment 1 item 11).
- The status table, "one per name, the first matching rule wins", is `config/options_select_stage2.yaml` `rules`,
  applied by `decide`. A check is True, False or None (not determined); a rule fires on any True; a rule with no
  True and a None makes the status `unclassified`, because the record's first matching rule cannot be known. Every
  check is reported, so the measured values can be counted.
- Thresholds: "Stage 2's four thresholds ... are not set by this record". They come in as `Thresholds`; an absent
  one leaves every check that needs it None (`unclassified`), with the measured value reported.

The points section 5 leaves open are settled by DEC-0046's Amendment 1 (proposed with this code) and implemented
here: a split ex-date is `not_confirmed` and never scaled; a dividend ex-date uses the raw close and is a
`close_adjusted` caution; any other action effective on the session is `not_confirmed`; the spread is in basis points
of the midpoint and a crossed quote has none; every desk name "normally trades pre-market"; entitlement comes from
the fetch's own evidence (`evidence`); the extra rule 2 reasons and cautions; a macro row of any severity; a zero
baseline median is "not available"; without card fields the position check is undetermined (`card_fields`); the age
limit of a quote (`quote_max_age_s`) and the freshness of a halt report (`halt_max_age_s`) are absent until frozen,
and every use of the quote or the report needs them; a time after `T` is stale.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import math
import os
import re
import statistics
import sys
import tempfile
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from wt.options import levels as lv
from wt.options import select as sel
from wt.risk import events as ev

OUTPUT_SCHEMA = "wt.options.select/stage2"
BUNDLE_SCHEMA = "wt.options.select/stage2-bundle"
OUTPUT_VERSION = 1
BUNDLE_VERSION = 1
PASSES = ("A", "B")
FEED = "sip"
NY = ZoneInfo("America/New_York")
UTC = dt.UTC

ROOT = Path(__file__).resolve().parents[3]
CONFIG_PATH = ROOT / "config" / "options_select_stage2.yaml"

STATUSES = ("no_longer_qualifies", "not_confirmed", "caution", "confirmed")
UNCLASSIFIED = "unclassified"
# The status table, as config/options_select_stage2.yaml holds it; the loader refuses any other.
RULES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("no_longer_qualifies", ("halted", "earnings_released")),
    ("not_confirmed", ("entitlement_not_passed", "feed_not_named", "fetch_cut_short", "bad_data",
                       "no_reference_price", "stale_prior_close", "stale_quote", "split_ex_date",
                       "corporate_action_not_handled", "stage1_atr_missing", "internal_error")),
    ("no_longer_qualifies", ("spread_above_limit", "gap_at_or_above_fail_limit")),
    ("caution", ("beyond_ceiling_or_floor", "gap_at_or_above_caution_limit", "relative_volume_at_or_above_limit",
                 "earnings_today", "macro_event_today", "close_adjusted", "possibly_halted",
                 "earnings_row_unreadable", "halt_report_stale")),
)
CHECKS = tuple(c for _, codes in RULES for c in codes)
THRESHOLD_KEYS = ("spread_limit_bps", "gap_fail_atr", "gap_caution_atr", "relative_volume_limit")
MISSING_NUMBER_KEYS = ("quote_max_age_s", "halt_max_age_s")
POSITIONS = ("past_upper_target1", "above_ceiling", "between", "below_floor", "past_lower_target1",
             "not_available")
CARD_KEYS = ("ceiling", "floor", "upper_target1", "lower_target1")
SPLIT_TYPES = ("forward_splits", "reverse_splits")
DIVIDEND_TYPES = ("cash_dividends",)
ENTITLEMENT_STATES = ("passed", "failed", "unknown")
HALT_STATES = ("halted", "not_halted")
# What can leave a fetch incomplete (Amendment 1 item 7). The fetcher writes the cause; the scorer adds its own.
CUT_SHORT = ("auth", "forbidden", "rate_limit", "server_error", "timeout", "transport", "http_error", "bad_answer",
             "feed_guard", "request_budget", "time_budget", "late")
SCORER_PROBLEMS = ("incomplete", "early", "late", "answer_not_200", "request_missing")
MERGER_NAME_TYPES = ("name_changes", "cash_mergers", "stock_mergers", "stock_and_cash_mergers")
# The requests whose answers are market data and must have named feed=sip. News and corporate actions take no feed.
DATA_REQUESTS = ("daily_raw", "minute", "premarket", "snapshots")
OTHER_REQUESTS = ("corporate_actions", "news")

# Exit codes of `main`.
EXIT_OK = 0              # the output is written; no name has internal_error and the pass is not degraded
EXIT_FLAGGED = 1         # the output is written, and the pass is degraded or a name has internal_error
EXIT_BUNDLE = 2          # the bundle cannot be read or is not in the documented shape: nothing written
EXIT_PARAMS = 3          # the parameters or thresholds file cannot be read or holds what the code does not implement
EXIT_WRITE = 4           # the output cannot be written, or already exists
EXIT_CALENDAR = 5        # the session lies outside the session calendar's range
EXIT_USAGE = 6           # the command line is not one this command takes
EXIT_STAGE1 = 7          # the Stage 1 block is refused: unreadable, another session, or its hash does not match
EXIT_PASS_A = 8          # Pass A's output (for Pass B) is refused: unreadable, another session or Stage 1 block, or
                         # not older than this pass


class ParamsError(ValueError):
    """The parameters or thresholds do not hold what this code implements."""


class BundleError(ValueError):
    """The Stage 2 input bundle is not in the documented shape."""


class Stage1Error(ValueError):
    """The Stage 1 block is not the one this bundle was fetched for, or has been changed."""


class PassAError(ValueError):
    """Pass A's output cannot be compared with this pass."""


# ---------------------------------------------------------------- parameters

@dataclass(frozen=True)
class Params:
    pass_at: dict[str, tuple[int, int]]
    publish_by: dict[str, tuple[int, int]]
    fetch_delay_s: int
    ref_bar_s: int
    ref_max_age_s: int
    premarket_from: tuple[int, int]
    premarket_bar_s: int
    baseline_sessions: int
    baseline_min: int
    no_trade_s: int
    reserves_from_rank: int
    reserves_max: int
    reserve_none_text: str
    reserve_not_classified_text: str
    min_rate_limit: int


@dataclass(frozen=True)
class Thresholds:
    """The four thresholds DEC-0046 leaves to a dated amendment, and two numbers its rules need that it does not
    give. None is absent: every check that needs it is not determined (`unclassified`)."""
    spread_limit_bps: float | None = None
    gap_fail_atr: float | None = None
    gap_caution_atr: float | None = None
    relative_volume_limit: float | None = None
    quote_max_age_s: float | None = None
    halt_max_age_s: float | None = None

    def as_dict(self) -> dict[str, float | None]:
        return {k: getattr(self, k) for k in THRESHOLD_KEYS + MISSING_NUMBER_KEYS}


_HHMM = re.compile(r"([01]\d|2[0-3]):([0-5]\d)", re.ASCII)


def _hhmm(v: Any, what: str) -> tuple[int, int]:
    m = _HHMM.fullmatch(v) if isinstance(v, str) else None
    if m is None:
        raise ParamsError(f"{what} must be a New York time written \"HH:MM\"")
    return int(m.group(1)), int(m.group(2))


def _int(v: Any, what: str) -> int:
    if isinstance(v, bool) or not isinstance(v, int) or v < 1:
        raise ParamsError(f"{what} must be written as a whole number of at least 1")
    return int(v)


def _exactly(node: Any, keys: set[str], what: str) -> Mapping[str, Any]:
    if not isinstance(node, Mapping) or set(node) != keys:
        raise ParamsError(f"{what} must hold exactly the keys {sorted(keys)}")
    return node


def params_from_mapping(cfg: Any) -> Params:
    """The parameters as parsed from `config/options_select_stage2.yaml`. Raises ParamsError on any key, value or
    rule the code does not implement, so the file and the code cannot drift apart."""
    top = _exactly(cfg, {"version", "passes", "fetch_delay_s", "reference_bar", "premarket", "baseline",
                         "possibly_halted", "reserves", "degraded", "rules", "thresholds", "missing_numbers",
                         "entitlement"},
                   "the parameters")
    if _int(top["version"], "version") != 1:
        raise ParamsError("version must be 1")
    passes = _exactly(top["passes"], set(PASSES), "passes")
    at: dict[str, tuple[int, int]] = {}
    by: dict[str, tuple[int, int]] = {}
    for k in PASSES:
        one = _exactly(passes[k], {"at", "publish_by"}, f"passes.{k}")
        at[k], by[k] = _hhmm(one["at"], f"passes.{k}.at"), _hhmm(one["publish_by"], f"passes.{k}.publish_by")
        if by[k] <= at[k]:
            raise ParamsError(f"passes.{k}.publish_by must be after passes.{k}.at")
    if at["A"] >= at["B"]:
        raise ParamsError("Pass A must be before Pass B")
    rb = _exactly(top["reference_bar"], {"seconds", "max_age_s"}, "reference_bar")
    pm = _exactly(top["premarket"], {"from", "bar_seconds"}, "premarket")
    bl = _exactly(top["baseline"], {"sessions", "min_sessions"}, "baseline")
    ph = _exactly(top["possibly_halted"], {"no_trade_s", "normally_trades_premarket"}, "possibly_halted")
    rs = _exactly(top["reserves"], {"from_rank", "max", "none_text", "not_classified_text"}, "reserves")
    en = _exactly(top["entitlement"], {"from", "min_rate_limit"}, "entitlement")
    if en["from"] != "fetch_evidence":
        raise ParamsError("entitlement.from must be fetch_evidence: the code implements no other (Amendment 1 item 6)")
    if ph["normally_trades_premarket"] != "all_names":
        raise ParamsError("possibly_halted.normally_trades_premarket must be all_names: the code implements no other")
    if top["degraded"] != "more_than_half_not_confirmed":
        raise ParamsError("degraded must be more_than_half_not_confirmed: the code implements no other rule")
    rules = top["rules"]
    if (not isinstance(rules, list) or len(rules) != len(RULES)
            or any(not isinstance(r, Mapping) or set(r) != {"status", "checks"} for r in rules)
            or tuple((r["status"], tuple(r["checks"]) if isinstance(r["checks"], list) else None)
                     for r in rules) != RULES):
        raise ParamsError("rules must be exactly the status table the code implements, in its order")
    if top["thresholds"] != list(THRESHOLD_KEYS) or top["missing_numbers"] != list(MISSING_NUMBER_KEYS):
        raise ParamsError("thresholds and missing_numbers must name exactly the keys the code reads, and no value")
    if not all(isinstance(rs[k], str) and rs[k] for k in ("none_text", "not_classified_text")):
        raise ParamsError("reserves.none_text and reserves.not_classified_text must be words")
    p = Params(
        pass_at=at, publish_by=by,
        fetch_delay_s=_int(top["fetch_delay_s"], "fetch_delay_s"),
        ref_bar_s=_int(rb["seconds"], "reference_bar.seconds"),
        ref_max_age_s=_int(rb["max_age_s"], "reference_bar.max_age_s"),
        premarket_from=_hhmm(pm["from"], "premarket.from"),
        premarket_bar_s=_int(pm["bar_seconds"], "premarket.bar_seconds"),
        baseline_sessions=_int(bl["sessions"], "baseline.sessions"),
        baseline_min=_int(bl["min_sessions"], "baseline.min_sessions"),
        no_trade_s=_int(ph["no_trade_s"], "possibly_halted.no_trade_s"),
        reserves_from_rank=_int(rs["from_rank"], "reserves.from_rank"),
        reserves_max=_int(rs["max"], "reserves.max"),
        reserve_none_text=rs["none_text"],
        reserve_not_classified_text=rs["not_classified_text"],
        min_rate_limit=_int(en["min_rate_limit"], "entitlement.min_rate_limit"),
    )
    if p.baseline_min > p.baseline_sessions:
        raise ParamsError("baseline.min_sessions cannot exceed baseline.sessions")
    if p.premarket_from >= p.pass_at["A"]:
        raise ParamsError("premarket.from must be before Pass A")
    return p


def load_params(path: Path = CONFIG_PATH) -> tuple[Params, str]:
    """Read and check the parameters file; return the parameters and their `stage2_params_sha`."""
    import yaml
    try:
        cfg = yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, yaml.YAMLError) as e:
        raise ParamsError(f"cannot read {path.name} ({type(e).__name__})") from None
    return params_from_mapping(cfg), sel.params_sha(cfg)


def thresholds_from_mapping(doc: Any) -> Thresholds:
    """Thresholds from a mapping holding any of THRESHOLD_KEYS and MISSING_NUMBER_KEYS, each a positive finite
    number or null. Any other key is refused. An absent key is None."""
    if doc is None:
        return Thresholds()
    if not isinstance(doc, Mapping) or not set(doc) <= set(THRESHOLD_KEYS + MISSING_NUMBER_KEYS):
        raise ParamsError(f"thresholds may hold only {list(THRESHOLD_KEYS + MISSING_NUMBER_KEYS)}")
    vals: dict[str, float | None] = {}
    for k, v in doc.items():
        if v is None:
            vals[k] = None
            continue
        if isinstance(v, bool) or not isinstance(v, int | float) or not math.isfinite(float(v)) or v <= 0:
            raise ParamsError(f"threshold {k} must be a positive number or null")
        vals[k] = float(v)
    th = Thresholds(**vals)
    if th.gap_fail_atr is not None and th.gap_caution_atr is not None and th.gap_fail_atr < th.gap_caution_atr:
        raise ParamsError("gap_fail_atr cannot be below gap_caution_atr")
    return th


# ---------------------------------------------------------------- time

def ny_time(day: str, hm: tuple[int, int]) -> dt.datetime:
    """`day` at `hm` New York, as an aware UTC time (the zone's own rules, so both clock changes are right)."""
    d = dt.date.fromisoformat(day)
    return dt.datetime(d.year, d.month, d.day, hm[0], hm[1], tzinfo=NY).astimezone(UTC)


def pass_time(session: str, pass_id: str, p: Params) -> dt.datetime:
    """`T`: the pass's scheduled assessment time on `session`, from the session date and the calendar only."""
    if pass_id not in PASSES:
        raise ValueError(f"pass must be one of {list(PASSES)}")
    if not lv.is_session(session):
        raise ValueError(f"{session} is not a session")
    return ny_time(session, p.pass_at[pass_id])


def iso(t: dt.datetime) -> str:
    return t.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


_TS = re.compile(r"(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})", re.ASCII)


def parse_ts(v: Any) -> dt.datetime | None:
    """An RFC 3339 time as Alpaca writes it (up to nine fractional digits; kept to the microsecond, truncated), as an
    aware UTC time; None when `v` is not one."""
    m = _TS.fullmatch(v) if isinstance(v, str) else None
    if m is None:
        return None
    frac = (m.group(5) or "")[:6].ljust(6, "0")
    zone = "+00:00" if m.group(6) == "Z" else m.group(6)
    try:
        t = dt.datetime.fromisoformat(f"{m.group(1)}T{m.group(2)}:{m.group(3)}:{m.group(4)}.{frac}{zone}")
    except ValueError:
        return None
    return t.astimezone(UTC)


def ny_date(t: dt.datetime) -> str:
    return t.astimezone(NY).date().isoformat()


# ---------------------------------------------------------------- bars and quotes

@dataclass(frozen=True)
class IBar:
    """A bar as Alpaca labels it: by its start."""
    start: dt.datetime
    o: float
    h: float
    l: float  # noqa: E741
    c: float
    v: float


def _num(v: Any) -> float | None:
    if isinstance(v, bool) or not isinstance(v, int | float):
        return None
    try:
        x = float(v)
    except OverflowError:
        return None
    return x if math.isfinite(x) else None


def parse_bars(raw: Any) -> list[IBar] | None:
    """A list of Alpaca bars (`t` and numbers `o`, `h`, `l`, `c`, `v`; other keys are kept in the bundle and not
    read), oldest first, or None when any bar cannot be read, has no positive range (high >= low > 0), a negative
    volume, or shares its start with another."""
    if not isinstance(raw, list):
        return None
    out: list[IBar] = []
    for b in raw:
        if not isinstance(b, Mapping):
            return None
        t = parse_ts(b.get("t"))
        o, h, lo, c, v = (_num(b.get(k)) for k in ("o", "h", "l", "c", "v"))
        if t is None or o is None or h is None or lo is None or c is None or v is None:
            return None
        if not (h >= lo > 0 and c > 0 and v >= 0):
            return None
        out.append(IBar(t, o, h, lo, c, v))
    out.sort(key=lambda b: b.start)
    if any(a.start == b.start for a, b in zip(out, out[1:], strict=False)):
        return None
    return out


@dataclass(frozen=True)
class Quote:
    bid: float | None
    bid_size: float | None
    ask: float | None
    ask_size: float | None
    t: dt.datetime | None
    state: str                 # two_sided, locked, crossed, one_sided, empty

    @property
    def spread_bps(self) -> float | None:
        """(ask - bid) over the midpoint, in basis points; only for a two-sided or locked quote."""
        if self.state not in ("two_sided", "locked") or self.bid is None or self.ask is None:
            return None
        mid = (self.bid + self.ask) / 2
        return (self.ask - self.bid) / mid * 10_000

    @property
    def mid(self) -> float | None:
        if self.state not in ("two_sided", "locked") or self.bid is None or self.ask is None:
            return None
        return (self.bid + self.ask) / 2


def parse_quote(raw: Any) -> Quote | None:
    """Alpaca's latest quote (`bp`, `bs`, `ap`, `as`, `t`). A side has a price only when its price and its size are
    both above zero; "a zero price or size on a side reads as one-sided, not crossed". None when a field present is
    not a number."""
    if raw is None:
        return Quote(None, None, None, None, None, "empty")
    if not isinstance(raw, Mapping):
        return None
    vals: dict[str, float | None] = {}
    for k in ("bp", "bs", "ap", "as"):
        if raw.get(k) is None:
            vals[k] = None
            continue
        x = _num(raw.get(k))
        if x is None:
            return None
        vals[k] = x
    t = parse_ts(raw.get("t")) if raw.get("t") is not None else None
    bid_ok = (vals["bp"] or 0) > 0 and (vals["bs"] or 0) > 0
    ask_ok = (vals["ap"] or 0) > 0 and (vals["as"] or 0) > 0
    if bid_ok and ask_ok:
        bp, ap = vals["bp"] or 0.0, vals["ap"] or 0.0
        state = "crossed" if ap < bp else "locked" if ap == bp else "two_sided"
    else:
        state = "one_sided" if bid_ok or ask_ok else "empty"
    return Quote(vals["bp"], vals["bs"], vals["ap"], vals["as"], t, state)


# ---------------------------------------------------------------- G4, G5: the pre-market window

def premarket_window(bars: Sequence[IBar], day: str, end_hm: tuple[int, int], p: Params) -> list[IBar]:
    """G4's bars on `day`: start at or after 04:00 New York and end (start plus the bar's length) at or before
    `end_hm` New York. A bar still forming at the end is dropped; a bar that is not there is zero volume."""
    lo, hi = ny_time(day, p.premarket_from), ny_time(day, end_hm)
    span = dt.timedelta(seconds=p.premarket_bar_s)
    return [b for b in bars if b.start >= lo and b.start + span <= hi]


def relative_volume(today: float, baseline: Sequence[float], min_sessions: int) -> float | None:
    """G5, the one definition of the pre-market relative volume in this repository: `today` (the window's volume)
    over the median of the same window's volume on the baseline's complete sessions. "Fewer than 10 complete sessions
    gives 'not available', a neutral mark" (None). DEC-0046 asks for "one shared function with the
    market-intelligence plan's baseline"; that plan's function did not exist when this was written (no
    `wt.market.flow`, no baseline function under `src/wt`), so this is it: the window is the caller's
    (`premarket_window`), a missing bar counts as zero volume. A median of zero is also "not available": no ratio can
    be taken."""
    if len(baseline) < min_sessions:
        return None
    med = statistics.median(baseline)
    if med <= 0:
        return None
    return today / med


# ---------------------------------------------------------------- the Stage 1 block

def stage1_sha(s1: Mapping[str, Any]) -> str:
    """"a hash over the items, the ranking and `params_sha`": SHA-256 of the canonical JSON of the Stage 1 output's
    picks (the items), its rows (the ranking) and its `params_sha`."""
    body = {"items": s1.get("picks"), "ranking": s1.get("names"), "params_sha": s1.get("params_sha")}
    return hashlib.sha256(sel.canonical_json(body).encode("utf-8")).hexdigest()


def stage1_doc_sha(s1: Mapping[str, Any]) -> str:
    """SHA-256 of the canonical JSON of the whole Stage 1 output: a change anywhere in the block is refused too."""
    return hashlib.sha256(sel.canonical_json(s1).encode("utf-8")).hexdigest()


def check_stage1(s1: Any, session: str) -> None:
    if not isinstance(s1, Mapping) or s1.get("schema") != sel.OUTPUT_SCHEMA or s1.get("version") != sel.OUTPUT_VERSION:
        raise Stage1Error("not a Stage 1 output of a version this code reads")
    if s1.get("next_session") != session:
        raise Stage1Error(f"the Stage 1 block selects for {s1.get('next_session')}, not {session}")
    if s1.get("session") != lv.prev_session(session):
        raise Stage1Error(f"the Stage 1 block scores {s1.get('session')}, not the session before {session}")
    rows = s1.get("names")
    if not isinstance(rows, list) or not all(isinstance(r, Mapping) and isinstance(r.get("symbol"), str)
                                             for r in rows):
        raise Stage1Error("the Stage 1 block has no rows")
    if not isinstance(s1.get("picks"), list) or not isinstance(s1.get("params_sha"), str):
        raise Stage1Error("the Stage 1 block has no picks or params_sha")


# ---------------------------------------------------------------- the bundle

def _all_finite(x: Any) -> bool:
    if isinstance(x, float):
        return math.isfinite(x)
    if isinstance(x, Mapping):
        return all(_all_finite(v) for v in x.values())
    if isinstance(x, list):
        return all(_all_finite(v) for v in x)
    return True


BUNDLE_KEYS = {"schema", "version", "session", "pass", "T", "fetched_at", "stage1_sha", "stage1_doc_sha", "names",
               "requests", "plan_check", "entitlement", "halt", "fetch", "data", "earnings_rows", "macro_rows"}
NAME_KEYS = {"daily_raw", "minute", "premarket", "snapshot", "corporate_actions", "news_count"}


def check_bundle(doc: Any) -> None:
    """Raise BundleError unless `doc` is a Stage 2 input bundle of the documented shape (see
    `wt.options.select_fetch` for how each part is fetched):

        {"schema": "wt.options.select/stage2-bundle", "version": 1,
         "session": "YYYY-MM-DD",          the session being confirmed (Stage 1's next_session)
         "pass": "A" | "B",
         "T": "YYYY-MM-DDTHH:MM:SSZ",       the pass's assessment time, UTC
         "fetched_at": "...Z",              when the fetch ended (at most the pass's publish-by time)
         "stage1_sha": hex, "stage1_doc_sha": hex,   the Stage 1 block the bundle was fetched for
         "names": ["SPY", ...],
         "requests": [{"what": "daily_raw" | "minute" | "premarket" | "snapshots" | "corporate_actions" | "news",
                       "session": "YYYY-MM-DD" | null, "path": "/v2/stocks/bars", "feed": "sip" | null,
                       "status": 200, "pages": 1, "x_ratelimit_limit": 10000 | null}, ...],
         "plan_check": {"x_ratelimit_limit": int | null},     as read: the smallest value on any data answer
         "entitlement": {"state": "passed" | "failed" | "unknown", "source": str | null, "checked_at": str | null},
         "halt": {"SYM": {"state": "halted" | "not_halted", "source": str, "as_of": "...Z"}, ...},  absent: unknown
         "fetch": {"complete": bool, "cut_short": null | one of CUT_SHORT, "started_at": "...Z" (at least T + 60 s)},
                                            an incomplete fetch is saved with what it got: every name is not_confirmed
         "data": {"SYM": {
             "daily_raw": [bar, ...],       raw daily bars (adjustment=raw) of the last sessions before the session
             "minute": [bar, ...],          1-minute bars from T - 15 min to T
             "premarket": {"YYYY-MM-DD": [bar, ...], ...},   5-minute bars from 04:00 to T's time of day, for the
                                            session and each of the previous 20 sessions; a session missing here
                                            was not fetched completely
             "snapshot": {...} | null,      Alpaca's snapshot as given (latestQuote, latestTrade, prevDailyBar, ...)
             "corporate_actions": [{"type": "forward_splits", "ex_date": "YYYY-MM-DD", ...}, ...],
             "news_count": int | null}},    items since the last close; no headline is ever stored
         "earnings_rows": [{...}], "macro_rows": [{...}]}     the event files' rows, as Stage 1's bundle holds them

    A bar is Alpaca's: {"t": RFC 3339 start, "o", "h", "l", "c", "v", and anything else as given}. A NaN or infinite
    number anywhere is not the documented shape. A name's unreadable data is that name's `bad_data`, not a bundle
    error."""
    if not isinstance(doc, Mapping):
        raise BundleError("the bundle is not an object")
    if not _all_finite(doc):
        raise BundleError("the bundle is not in the documented shape: it holds a NaN or infinite number")
    if set(doc) != BUNDLE_KEYS:
        raise BundleError(f"the bundle must hold exactly the keys {sorted(BUNDLE_KEYS)}")
    if doc["schema"] != BUNDLE_SCHEMA or isinstance(doc["version"], bool) or doc["version"] != BUNDLE_VERSION:
        raise BundleError("not a Stage 2 bundle of a version this code reads")
    s = doc["session"]
    if ev.exact_date(s) is None:
        raise BundleError("session is not a date")
    if doc["pass"] not in PASSES:
        raise BundleError("pass must be A or B")
    if parse_ts(doc["T"]) is None or parse_ts(doc["fetched_at"]) is None:
        raise BundleError("T and fetched_at must be RFC 3339 times")
    names = doc["names"]
    if (not isinstance(names, list) or not names or len(set(map(str, names))) != len(names)
            or not all(isinstance(n, str) and n and n == n.strip().upper() for n in names)):
        raise BundleError("names must be distinct upper-case symbols")
    if not isinstance(doc["requests"], list) or not all(
            isinstance(r, Mapping) and r.get("what") in DATA_REQUESTS + OTHER_REQUESTS for r in doc["requests"]):
        raise BundleError("requests must list each request with its kind")
    ent = doc["entitlement"]
    if not isinstance(ent, Mapping) or ent.get("state") not in ENTITLEMENT_STATES:
        raise BundleError("entitlement.state must be passed, failed or unknown")
    fetch = doc["fetch"]
    if (not isinstance(fetch, Mapping) or set(fetch) != {"complete", "cut_short", "started_at"}
            or not isinstance(fetch.get("complete"), bool) or fetch.get("cut_short") not in (None,) + CUT_SHORT
            or parse_ts(fetch.get("started_at")) is None or (fetch["complete"] and fetch["cut_short"] is not None)):
        raise BundleError("fetch must say when it began, whether it was complete and what cut it short")
    if not isinstance(doc["plan_check"], Mapping) or not isinstance(doc["halt"], Mapping):
        raise BundleError("plan_check and halt must be objects")
    for sym, h in doc["halt"].items():
        if not isinstance(h, Mapping) or h.get("state") not in HALT_STATES or not isinstance(h.get("source"), str):
            raise BundleError(f"halt for {sym} must give a state and its source")
    if not isinstance(doc["data"], Mapping) or not all(isinstance(v, Mapping) and set(v) == NAME_KEYS
                                                       for v in doc["data"].values()):
        raise BundleError(f"data must map a symbol to exactly {sorted(NAME_KEYS)}")
    if not isinstance(doc["earnings_rows"], list) or not isinstance(doc["macro_rows"], list):
        raise BundleError("earnings_rows and macro_rows must be lists")


def _sort_key(x: Any) -> str:
    return sel.canonical_json(x)


def normalised(doc: Mapping[str, Any]) -> dict[str, Any]:
    """The bundle with every list whose order carries no meaning sorted, so `bundle_sha` names its content, not the
    order Alpaca or a hand happened to write it in."""
    out = dict(doc)
    out["names"] = sorted(doc["names"])
    out["requests"] = sorted(doc["requests"], key=_sort_key)
    out["earnings_rows"] = sorted(doc["earnings_rows"], key=_sort_key)
    out["macro_rows"] = sorted(doc["macro_rows"], key=_sort_key)
    data: dict[str, Any] = {}
    for sym, d in doc["data"].items():
        one = dict(d)
        for k in ("daily_raw", "minute", "corporate_actions"):
            if isinstance(one.get(k), list):
                one[k] = sorted(one[k], key=_sort_key)
        if isinstance(one.get("premarket"), Mapping):
            one["premarket"] = {day: sorted(v, key=_sort_key) if isinstance(v, list) else v
                                for day, v in one["premarket"].items()}
        data[sym] = one
    out["data"] = data
    return out


def bundle_sha(doc: Mapping[str, Any]) -> str:
    return hashlib.sha256(sel.canonical_json(normalised(doc)).encode("utf-8")).hexdigest()


# ---------------------------------------------------------------- one name

Check = bool | None


@dataclass
class Context:
    session: str
    stage1_session: str
    prev: str
    T: dt.datetime
    t_hm: tuple[int, int]
    baseline_days: list[str]
    entitlement: bool
    feed_ok: bool
    fetch_problems: list[str]
    earnings_rows: list[Mapping[str, Any]]
    unreadable_earnings: set[str]
    macro_types: list[str]
    halt: Mapping[str, Any]


def on_session(a: Mapping[str, Any], session: str) -> bool:
    """Whether a corporate action is effective on the session: by its ex-date; a name change or a merger (which have
    none) by its effective date or its process date. Alpaca's own date filter is on the process date, so the
    fetcher asks for a window and this decides."""
    if a.get("type") in MERGER_NAME_TYPES:
        return session in (a.get("ex_date"), a.get("effective_date"), a.get("process_date"))
    return a.get("ex_date") == session


def _row_card(row: Mapping[str, Any]) -> dict[str, float] | None:
    card = row.get("card")
    if not isinstance(card, Mapping):
        return None
    vals = {k: _num(card.get(k)) for k in CARD_KEYS}
    if any(v is None for v in vals.values()):
        return None
    return {k: float(v) for k, v in vals.items() if v is not None}


def position(price: float | None, card: Mapping[str, float] | None) -> str:
    """G6 position of `price` against the card's levels. "Beyond" is strictly past a level: a price exactly at the
    ceiling, the floor or a target is on the inner side."""
    if price is None or card is None:
        return "not_available"
    if price > card["upper_target1"]:
        return "past_upper_target1"
    if price > card["ceiling"]:
        return "above_ceiling"
    if price < card["lower_target1"]:
        return "past_lower_target1"
    if price < card["floor"]:
        return "below_floor"
    return "between"


def _age(t: dt.datetime | None, at: dt.datetime) -> float | None:
    return None if t is None else (at - t).total_seconds()


def assess(sym: str, row: Mapping[str, Any] | None, data: Mapping[str, Any] | None, ctx: Context, p: Params,
           th: Thresholds) -> dict[str, Any]:
    """Every check of one name, its measured values and its status."""
    checks: dict[str, Check] = dict.fromkeys(CHECKS, False)
    needs: dict[str, str] = {}
    d: Mapping[str, Any] = data if data is not None else {k: None for k in NAME_KEYS}
    T = ctx.T

    # rule 2's run-wide checks
    checks["entitlement_not_passed"] = not ctx.entitlement
    checks["feed_not_named"] = not ctx.feed_ok
    checks["fetch_cut_short"] = bool(ctx.fetch_problems)
    bad: list[str] = []
    if data is None:
        bad.append("no_data")

    # G1: the prior close
    daily = parse_bars(d.get("daily_raw") if data is not None else [])
    if daily is None:
        bad.append("daily_raw")
        daily = []
    before = [b for b in daily if ny_date(b.start) < ctx.session]
    last = before[-1] if before else None
    raw_close = last.c if last is not None else None
    checks["stale_prior_close"] = last is None or ny_date(last.start) != ctx.prev
    actions_raw = d.get("corporate_actions") if data is not None else []
    if not isinstance(actions_raw, list) or not all(isinstance(a, Mapping) for a in actions_raw):
        bad.append("corporate_actions")
        actions_raw = []
    actions = sorted((a for a in actions_raw if on_session(a, ctx.session)), key=_sort_key)
    types = sorted({str(a.get("type")) for a in actions})
    adjusted: float | None = None
    adjustment = "none"
    ratio = 1.0
    splits = [a for a in actions if a.get("type") in SPLIT_TYPES]
    for a in splits:                                      # two splits on one day multiply
        old, new = _num(a.get("old_rate")), _num(a.get("new_rate"))
        if old is None or new is None or old <= 0 or new <= 0:
            bad.append("split_ratio")
        else:
            ratio *= old / new
    if any(a.get("type") not in SPLIT_TYPES + DIVIDEND_TYPES for a in actions):
        adjustment = "not_handled"                        # precedence: not handled, then split, then dividend
        checks["corporate_action_not_handled"] = True
    elif splits:
        adjustment = "split"
        if raw_close is not None and "split_ratio" not in bad:
            adjusted = raw_close * ratio
    elif actions:
        adjustment = "dividend_not_defined"               # Amendment 1 item 2: the raw close, no adjustment
    checks["split_ex_date"] = bool(splits)
    checks["close_adjusted"] = bool(actions)
    snap = d.get("snapshot") if data is not None else None
    if snap is not None and not isinstance(snap, Mapping):
        bad.append("snapshot")
        snap = None
    cross = None
    if isinstance(snap, Mapping) and isinstance(snap.get("prevDailyBar"), Mapping):
        pdb = snap["prevDailyBar"]
        pt, pc = parse_ts(pdb.get("t")), _num(pdb.get("c"))
        cross = {"date": None if pt is None else ny_date(pt), "close": pc,
                 "agrees": pc is not None and raw_close is not None and pc == raw_close
                 and pt is not None and last is not None and ny_date(pt) == ny_date(last.start)}

    # the quote and its age: every use of the quote needs it fresh (Amendment 1 items 12, 13)
    quote = parse_quote(snap.get("latestQuote") if isinstance(snap, Mapping) else None)
    if quote is None:
        bad.append("quote")
        quote = Quote(None, None, None, None, None, "empty")
    quote_age = _age(quote.t, T)
    q_fresh: Check = None if th.quote_max_age_s is None else (
        quote_age is not None and 0 <= quote_age <= th.quote_max_age_s)
    if q_fresh is None:
        checks["stale_quote"], needs["stale_quote"] = None, "quote_max_age_s"
    else:
        checks["stale_quote"] = not q_fresh

    # G2: the reference price
    minute = parse_bars(d.get("minute") if data is not None else [])
    if minute is None:
        bad.append("minute")
        minute = []
    span = dt.timedelta(seconds=p.ref_bar_s)
    finished = [b for b in minute if b.start + span <= T]
    ref: float | None = None
    ref_kind: str | None = None
    bar_end: dt.datetime | None = None
    ref_known = True
    if finished:
        bar_end = finished[-1].start + span
        if (T - bar_end).total_seconds() <= p.ref_max_age_s:
            ref, ref_kind = finished[-1].c, "bar"
    spread = quote.spread_bps
    if ref is None and quote.mid is not None and spread is not None:
        if th.spread_limit_bps is None:
            ref_known = False
            needs["no_reference_price"] = "spread_limit_bps"
        elif q_fresh is None:
            ref_known = False
            needs["no_reference_price"] = "quote_max_age_s"
        elif q_fresh and spread <= th.spread_limit_bps:
            ref, ref_kind = quote.mid, "mid"
    checks["no_reference_price"] = None if not ref_known else ref is None
    trade = snap.get("latestTrade") if isinstance(snap, Mapping) else None
    trade_t = parse_ts(trade.get("t")) if isinstance(trade, Mapping) else None
    trade_p = _num(trade.get("p")) if isinstance(trade, Mapping) else None

    # G3: the gap
    atr14 = None
    shown = row.get("shown") if row is not None else None
    if isinstance(shown, Mapping):
        a14 = _num(shown.get("atr14"))
        atr14 = a14 if a14 is not None and a14 > 0 else None
    checks["stage1_atr_missing"] = atr14 is None
    base = adjusted if splits else raw_close
    gap_pct = None if ref is None or base is None else ref / base - 1
    gap_atr = (None if ref is None or base is None or atr14 is None or splits
               else (ref - base) / atr14)              # on a split ex-date ATR14 is in pre-split units: not used

    # rule 3
    if spread is None:
        checks["spread_above_limit"] = False                  # one-sided, empty or crossed: no spread to measure
    elif th.spread_limit_bps is None:
        checks["spread_above_limit"], needs["spread_above_limit"] = None, "spread_limit_bps"
    else:
        checks["spread_above_limit"] = spread > th.spread_limit_bps
    for code, limit, key in (("gap_at_or_above_fail_limit", th.gap_fail_atr, "gap_fail_atr"),
                             ("gap_at_or_above_caution_limit", th.gap_caution_atr, "gap_caution_atr")):
        if gap_atr is None:
            checks[code] = None                               # only after a rule 2 check has fired
        elif limit is None:
            checks[code], needs[code] = None, key
        else:
            checks[code] = abs(gap_atr) >= limit

    # G4, G5, G6
    pm = d.get("premarket") if data is not None else {}
    if not isinstance(pm, Mapping):
        bad.append("premarket")
        pm = {}
    windows: dict[str, list[IBar]] = {}
    dropped: list[str] = []
    for day in [ctx.session] + ctx.baseline_days:
        if day not in pm:
            continue
        got = parse_bars(pm[day])
        if got is None:
            if day == ctx.session:
                bad.append("premarket")                       # the session's own bars
            else:
                dropped.append(day)                           # an old day's bad bar drops that day only
            continue
        windows[day] = premarket_window(got, day, ctx.t_hm, p)
    today = windows.get(ctx.session)
    pm_volume = None if today is None else sum(b.v for b in today)
    pm_high = max((b.h for b in today), default=None) if today else None
    pm_low = min((b.l for b in today), default=None) if today else None
    base_vols = [sum(b.v for b in windows[day]) for day in ctx.baseline_days if day in windows]
    rvol = None if pm_volume is None else relative_volume(pm_volume, base_vols, p.baseline_min)
    if rvol is None:
        checks["relative_volume_at_or_above_limit"] = False   # "not available": a neutral mark
    elif th.relative_volume_limit is None:
        checks["relative_volume_at_or_above_limit"] = None
        needs["relative_volume_at_or_above_limit"] = "relative_volume_limit"
    else:
        checks["relative_volume_at_or_above_limit"] = rvol >= th.relative_volume_limit
    card = _row_card(row) if row is not None else None
    if splits:
        pos = "not_available"                                 # Amendment 1 item 1
        checks["beyond_ceiling_or_floor"] = False             # rule 2 has decided
    elif card is None:
        pos = "not_available"
        checks["beyond_ceiling_or_floor"], needs["beyond_ceiling_or_floor"] = None, "card_fields"
    elif ref is None:
        pos = "not_available"
        checks["beyond_ceiling_or_floor"] = None              # only after a rule 2 check has fired
    else:
        pos = position(ref, card)
        checks["beyond_ceiling_or_floor"] = pos not in ("between", "not_available")
    side = "upper" if pos == "past_upper_target1" else "lower" if pos == "past_lower_target1" else None

    # halt
    h = ctx.halt.get(sym)
    halt_state, halt_source, halt_age, reported = "unknown", None, None, None
    if isinstance(h, Mapping):
        reported, halt_source = h["state"], h["source"]
        halt_age = _age(parse_ts(h.get("as_of")), T)
        fresh: Check = None if th.halt_max_age_s is None else (
            halt_age is not None and 0 <= halt_age <= th.halt_max_age_s)   # a report after T is stale
        if fresh:
            halt_state = reported
        if reported == "halted":
            if fresh is None:
                checks["halted"], needs["halted"] = None, "halt_max_age_s"
            else:
                checks["halted"] = fresh
                checks["halt_report_stale"] = not fresh
    traded = (trade_t is not None and T - dt.timedelta(seconds=p.no_trade_s) <= trade_t <= T) or any(
        b.v > 0 and b.start >= T - dt.timedelta(seconds=p.no_trade_s) for b in finished)
    possibly: Check
    if halt_state != "unknown" or traded or quote.state not in ("one_sided", "empty"):
        possibly = False
    elif q_fresh is None:
        possibly = None
        needs["possibly_halted"] = "quote_max_age_s"
    else:
        possibly = bool(q_fresh)                              # a stale quote shows nothing about now
    checks["possibly_halted"] = possibly

    # events
    released = today_e = False
    for r in ctx.earnings_rows:
        if r["symbol"] != sym:
            continue
        k = (str(r["date"]), str(r["when"]))
        if (ctx.stage1_session, "amc") == k or ctx.stage1_session < k[0] < ctx.session or k == (ctx.session, "bmo"):
            released = True
        elif k[0] == ctx.session:
            today_e = True
    checks["earnings_released"] = released
    checks["earnings_today"] = today_e
    checks["earnings_row_unreadable"] = sym in ctx.unreadable_earnings
    checks["macro_event_today"] = bool(ctx.macro_types)

    news = d.get("news_count") if data is not None else None
    news_count = news if isinstance(news, int) and not isinstance(news, bool) and news >= 0 else None
    checks["bad_data"] = bool(bad)

    status, rule, reasons, unclassified_by = decide(checks, needs)
    s1 = {"final_rank": None, "eligible": False, "picked": False} if row is None else {
        "final_rank": row.get("final_rank"), "eligible": bool(row.get("eligible")), "picked": bool(row.get("picked"))}
    return {
        "symbol": sym,
        "stage1": s1,
        "status": status,
        "rule": rule,
        "reasons": reasons,
        "unclassified_by": unclassified_by,
        "cautions": sorted(c for c in RULES[3][1] if checks[c] is True),
        "checks": checks,
        "bad_data": sorted(set(bad)),
        "prior_close": {"raw": raw_close, "date": None if last is None else ny_date(last.start),
                        "expected_date": ctx.prev, "adjusted": adjusted,
                        "adjustment": adjustment, "close_adjusted": bool(actions), "split_ratio": ratio if splits else None,
                        "corporate_actions": types, "snapshot_cross_check": cross},
        "reference": {"kind": ref_kind, "price": ref, "bar_end": None if bar_end is None else iso(bar_end),
                      "bar_age_s": None if bar_end is None else (T - bar_end).total_seconds()},
        "quote": {"state": quote.state, "bid": quote.bid, "bid_size": quote.bid_size, "ask": quote.ask,
                  "ask_size": quote.ask_size, "spread_bps": spread, "age_s": quote_age},
        "last_trade": {"price": trade_p, "age_s": _age(trade_t, T), "evidence_only": True},
        "gap": {"pct": gap_pct, "atr": gap_atr, "atr14": atr14},
        "premarket": {"volume": pm_volume, "high": pm_high, "low": pm_low,
                      "bars": None if today is None else len(today), "baseline_days_dropped": sorted(dropped)},
        "relative_volume": {"value": rvol, "available": rvol is not None, "baseline_sessions": len(base_vols),
                            "baseline_median": statistics.median(base_vols) if base_vols else None},
        "position": pos,
        "side_missed": side,
        "halt": {"state": halt_state, "reported": reported, "source": halt_source, "age_s": halt_age,
                 "possibly_halted": possibly, "report_stale": checks["halt_report_stale"]},
        "news_count": news_count,
        "events": {"earnings_released": released, "earnings_today": today_e, "macro_today": ctx.macro_types},
    }


def decide(checks: Mapping[str, Check], needs: Mapping[str, str]) -> tuple[str, int | None, list[str], list[str]]:
    """The first matching rule wins. A rule matches when any of its checks is True. A rule with none True and one
    not determined (None) stops the walk: the status is `unclassified`, with the thresholds whose absence left it
    open. None of the four rules: `confirmed`, rule 5."""
    for i, (status, codes) in enumerate(RULES, 1):
        fired = [c for c in codes if checks[c] is True]
        if fired:
            return status, i, fired, []
        open_ = [c for c in codes if checks[c] is None]
        if open_:
            return UNCLASSIFIED, i, [], sorted({needs.get(c, f"not_determined:{c}") for c in open_})
    return "confirmed", len(RULES) + 1, [], []


def _internal(sym: str, row: Mapping[str, Any] | None, err: Exception) -> dict[str, Any]:
    checks: dict[str, Check] = dict.fromkeys(CHECKS, None)
    checks["internal_error"] = True
    for c in RULES[0][1]:
        checks[c] = False
    status, rule, reasons, _ = decide(checks, {})
    return {"symbol": sym, "stage1": None if row is None else {"final_rank": row.get("final_rank"),
                                                               "eligible": bool(row.get("eligible")),
                                                               "picked": bool(row.get("picked"))},
            "status": status, "rule": rule, "reasons": reasons, "unclassified_by": [], "cautions": [],
            "checks": checks, "error_class": type(err).__name__}


# ---------------------------------------------------------------- the pass

def _events(doc: Mapping[str, Any], names: Sequence[str], session: str) -> tuple[list[Mapping[str, Any]], set[str],
                                                                                    list[str], dict[str, int]]:
    good: list[Mapping[str, Any]] = []
    unreadable: set[str] = set()
    bad_e = bad_m = 0
    for r in doc["earnings_rows"]:
        if not isinstance(r, Mapping) or ev.earnings_row_problem(r) is not None:
            bad_e += 1
            sym = r.get("symbol") if isinstance(r, Mapping) else None
            if isinstance(sym, str) and sym.strip().upper() in names:
                unreadable.add(sym.strip().upper())
            continue
        good.append(r)
    macro: set[str] = set()
    for r in doc["macro_rows"]:
        if not isinstance(r, Mapping) or ev.macro_row_problem(r) is not None:
            bad_m += 1
            continue
        if r["date"] == session:
            macro.add(str(r["type"]))
    return good, unreadable, sorted(macro), {"earnings_rows": bad_e, "macro_rows": bad_m}


def reserves(stage1: Mapping[str, Any], rows: Mapping[str, Mapping[str, Any]],
             p: Params) -> tuple[list[dict[str, Any]], bool]:
    """"A reserve is a Stage 1-eligible name ranked 5th or lower whose Stage 2 status is `confirmed`. Up to two, in
    Stage 1 rank order ... never among the picks." Nothing is swapped or promoted. The walk stops at a candidate whose
    status is `unclassified`: whether it would be a reserve is not known, so the list is reported as not classified
    (False) rather than letting a later name take its place."""
    picks = set(stage1["picks"])
    cand = []
    for r in stage1["names"]:
        rank = r.get("final_rank")
        if (r.get("eligible") is True and isinstance(rank, int) and not isinstance(rank, bool)
                and rank >= p.reserves_from_rank and r["symbol"] not in picks):
            cand.append((rank, r["symbol"]))
    out: list[dict[str, Any]] = []
    for k, sym in sorted(cand):
        if len(out) == p.reserves_max:
            break
        status = rows.get(sym, {}).get("status")
        if status == UNCLASSIFIED:
            return [], False
        if status == "confirmed":
            out.append({"symbol": sym, "final_rank": k, "changed_since_pass_a": None})
    return out, True


def check_pass_a(a: Any, session: str, s1_sha: str, s1_doc: str, T: dt.datetime) -> None:
    if not isinstance(a, Mapping) or a.get("schema") != OUTPUT_SCHEMA or a.get("version") != OUTPUT_VERSION:
        raise PassAError("not a Stage 2 output of a version this code reads")
    if a.get("pass") != "A" or a.get("session") != session:
        raise PassAError("not Pass A of this session")
    s1 = a.get("stage1")
    if (not isinstance(s1, Mapping) or a.get("stage1_sha") != stage1_sha(s1) or a.get("stage1_doc_sha")
            != stage1_doc_sha(s1)):
        raise PassAError("Pass A's Stage 1 block does not match its own hash: it was changed")
    if a.get("stage1_sha") != s1_sha or a.get("stage1_doc_sha") != s1_doc:
        raise PassAError("Pass A was made from another Stage 1 block")
    at = parse_ts(a.get("as_of"))
    if at is None or at >= T:
        raise PassAError("Pass A's as_of is not older than this pass's")
    if not isinstance(a.get("names"), list) or not isinstance(a.get("reserves"), list):
        raise PassAError("Pass A has no names or reserves")


def changes_since(a: Mapping[str, Any], names: Sequence[Mapping[str, Any]],
                  res: list[dict[str, Any]]) -> dict[str, Any]:
    """What changed from Pass A to this pass: each status that moved, a pre-market high or low that widened (only
    those can move: Stage 1's levels never do), and each reserve that appeared or disappeared."""
    before = {r["symbol"]: r for r in a["names"] if isinstance(r, Mapping) and "symbol" in r}
    status, widened = [], []
    for r in names:
        b = before.get(r["symbol"])
        if b is None:
            continue
        if b.get("status") != r["status"]:
            status.append({"symbol": r["symbol"], "pass_a": b.get("status"), "pass_b": r["status"]})
        hb, hn = (b.get("premarket") or {}).get("high"), (r.get("premarket") or {}).get("high")
        lb, ln = (b.get("premarket") or {}).get("low"), (r.get("premarket") or {}).get("low")
        w = {}
        if isinstance(hn, float | int) and (not isinstance(hb, float | int) or hn > hb):
            w["high"] = [hb, hn]
        if isinstance(ln, float | int) and (not isinstance(lb, float | int) or ln < lb):
            w["low"] = [lb, ln]
        if w:
            widened.append({"symbol": r["symbol"], **w})
    was = {x.get("symbol") for x in a["reserves"] if isinstance(x, Mapping)}
    now = {x["symbol"] for x in res}
    for x in res:
        x["changed_since_pass_a"] = None if x["symbol"] in was else "appeared"
    return {"status": status, "premarket_widened": widened, "reserves_appeared": sorted(now - was),
            "reserves_disappeared": sorted(s for s in was - now if isinstance(s, str))}


def evidence(bundle: Mapping[str, Any], session: str, pass_id: str, T: dt.datetime, baseline: Sequence[str],
             p: Params) -> dict[str, Any]:
    """What the bundle's own record of its fetch shows, checked rather than trusted (Amendment 1 items 6 and 7).

    - `fetch_problems`: the fetcher's cause when it did not finish (`fetch.cut_short`, or `incomplete`); `early` when
      the fetch began before T + 60 s; `late` when it ended after the pass's publish-by time; `answer_not_200` when a
      recorded answer was not 200; `request_missing` when a required request (the daily bars, the 1-minute bars, the
      pre-market bars of the session and of each baseline session, the snapshots) is not recorded with `feed=sip`.
    - `entitlement_passed`: every market-data request named `feed=sip`, every answer was 200, every required request
      is there (so the 1-minute bars and the snapshots, which reach into the last 15 minutes, were answered), every
      data answer carried `X-RateLimit-Limit` and the smallest is at least the plan's lapse bound; and the bundle's
      own entitlement says passed, checked between `T` and the end of the fetch. A missing header fails."""
    reqs = [r for r in bundle["requests"] if isinstance(r, Mapping)]
    data_reqs = [r for r in reqs if r.get("what") in DATA_REQUESTS]
    problems: list[str] = []
    f = bundle["fetch"]
    if not f["complete"]:
        problems.append(str(f["cut_short"] or "incomplete"))
    started, ended = parse_ts(f["started_at"]), parse_ts(bundle["fetched_at"])
    if started is None or started < T + dt.timedelta(seconds=p.fetch_delay_s):
        problems.append("early")
    if ended is None or ended > ny_time(session, p.publish_by[pass_id]) or (started is not None and ended < started):
        problems.append("late")
    if any(r.get("status") != 200 for r in reqs):
        problems.append("answer_not_200")
    named = {(r.get("what"), r.get("session")) for r in data_reqs if r.get("feed") == FEED and r.get("status") == 200}
    required: set[tuple[Any, Any]] = {("daily_raw", None), ("minute", None), ("snapshots", None)}
    required |= {("premarket", d) for d in [session, *baseline]}
    missing = sorted(f"{w}:{d}" if d else str(w) for w, d in required - named)
    if missing:
        problems.append("request_missing")
    feed_named = bool(data_reqs) and all(r.get("feed") == FEED for r in data_reqs)
    limits = [r.get("x_ratelimit_limit") for r in data_reqs]
    limits_ok = bool(limits) and all(isinstance(x, int) and not isinstance(x, bool) for x in limits) and min(
        int(x) for x in limits if isinstance(x, int)) >= p.min_rate_limit
    ent = bundle["entitlement"]
    checked = parse_ts(ent.get("checked_at"))
    ent_ok = (ent.get("state") == "passed" and checked is not None and ended is not None and T <= checked <= ended)
    passed = (feed_named and all(r.get("status") == 200 for r in reqs) and not missing and limits_ok and ent_ok)
    return {"fetch_problems": sorted(set(problems)), "requests_missing": missing, "feed_named": feed_named,
            "rate_limit_ok": limits_ok, "entitlement_recorded": ent_ok, "entitlement_passed": passed}


def confirm(stage1: Any, bundle: Any, pass_id: str, p: Params, th: Thresholds, *, sha: str,
            pass_a: Any = None) -> dict[str, Any]:
    """Stage 2 for one pass. Raises BundleError, Stage1Error, PassAError, or select.CalendarError for a session
    outside the calendar. `sha` is the parameters' `stage2_params_sha`."""
    check_bundle(bundle)
    session = bundle["session"]
    if session < sel.CALENDAR_FROM or session > lv.CALENDAR_THROUGH:
        raise sel.CalendarError(f"session {session} is outside the session calendar")
    if not lv.is_session(session):
        raise BundleError("session is not a session date")
    if bundle["pass"] != pass_id:
        raise BundleError(f"the bundle is for Pass {bundle['pass']}, not Pass {pass_id}")
    T = pass_time(session, pass_id, p)
    if parse_ts(bundle["T"]) != T:
        raise BundleError(f"the bundle's T is not Pass {pass_id}'s time on {session} ({iso(T)})")
    check_stage1(stage1, session)
    s1_sha, s1_doc = stage1_sha(stage1), stage1_doc_sha(stage1)
    if bundle["stage1_sha"] != s1_sha or bundle["stage1_doc_sha"] != s1_doc:
        raise Stage1Error("the Stage 1 block does not match the one the bundle was fetched for: it was changed")
    s1_names = sorted(r["symbol"] for r in stage1["names"])
    names = sorted(bundle["names"])
    if names != s1_names:
        raise Stage1Error("the bundle's names are not the Stage 1 block's names")
    if pass_id == "A" and pass_a is not None:
        raise PassAError("Pass A takes no earlier pass")
    if pass_a is not None:
        check_pass_a(pass_a, session, s1_sha, s1_doc, T)

    prev = lv.prev_session(session)
    days = [prev]
    while len(days) < p.baseline_sessions:
        days.append(lv.prev_session(days[-1]))
    ev_ = evidence(bundle, session, pass_id, T, days, p)
    good, unreadable, macro, bad_rows = _events(bundle, names, session)
    ctx = Context(session=session, stage1_session=str(stage1.get("session")), prev=prev, T=T,
                  t_hm=p.pass_at[pass_id], baseline_days=days, entitlement=ev_["entitlement_passed"],
                  feed_ok=ev_["feed_named"], fetch_problems=ev_["fetch_problems"],
                  earnings_rows=good, unreadable_earnings=unreadable, macro_types=macro, halt=bundle["halt"])
    rows = {r["symbol"]: r for r in stage1["names"]}
    out_rows: list[dict[str, Any]] = []
    errors = False
    for sym in names:
        try:
            out_rows.append(assess(sym, rows.get(sym), bundle["data"].get(sym), ctx, p, th))
        except Exception as e:                                    # one name never stops the others
            errors = True
            out_rows.append(_internal(sym, rows.get(sym), e))
    by = {r["symbol"]: r for r in out_rows}
    res, res_complete = reserves(stage1, by, p)
    if not all(getattr(th, k) is not None for k in THRESHOLD_KEYS):
        res, res_complete = [], False                 # reserves are not classified while the thresholds are not set
    changes = None if pass_a is None else changes_since(pass_a, out_rows, res)
    counts = {s: sum(1 for r in out_rows if r["status"] == s) for s in STATUSES + (UNCLASSIFIED,)}
    degraded = counts["not_confirmed"] * 2 > len(out_rows)
    return {
        "schema": OUTPUT_SCHEMA,
        "version": OUTPUT_VERSION,
        "session": session,
        "pass": pass_id,
        "as_of": iso(T),
        "stage1": stage1,
        "stage1_sha": s1_sha,
        "stage1_doc_sha": s1_doc,
        "stage2_params_sha": sha,
        "thresholds": th.as_dict(),
        "thresholds_set": all(getattr(th, k) is not None for k in THRESHOLD_KEYS),
        "bundle_sha": bundle_sha(bundle),
        "status": "internal_error" if errors else "ok",
        "degraded": degraded,
        "counts": counts,
        "entitlement": {**dict(bundle["entitlement"]), "passed": ev_["entitlement_passed"]},
        "fetch_problems": ev_["fetch_problems"],
        "plan_check": dict(bundle["plan_check"]),
        "unreadable_event_rows": bad_rows,
        "names": out_rows,
        "reserves": res,
        "reserve_note": (p.reserve_not_classified_text if not res_complete
                         else None if res else p.reserve_none_text),
        "reserves_classified": res_complete,
        "evidence": ev_,
        "changes_since_pass_a": changes,
    }


def supersedes(new: Mapping[str, Any], current: Mapping[str, Any] | None) -> bool:
    """Whether `new` replaces `current` for the same session: only a document whose `as_of` is later. "Each
    document's `as_of` is its assessment time, so a late Pass A never replaces Pass B." """
    if current is None:
        return True
    if new.get("session") != current.get("session"):
        return False
    a, b = parse_ts(new.get("as_of")), parse_ts(current.get("as_of"))
    return a is not None and b is not None and a > b


def dumps(out: Mapping[str, Any]) -> str:
    """The output's text: JSON, keys sorted, one-space indent, ASCII, a final newline."""
    return json.dumps(out, sort_keys=True, indent=1, ensure_ascii=True, allow_nan=False) + "\n"


def write_new(path: Path, text: str) -> None:
    """Write `text` to `path` atomically (a temporary file in the same folder, then a hard link), never replacing a
    file already there: FileExistsError."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.link(tmp, path)
    finally:
        os.unlink(tmp)
    fd_dir = os.open(path.parent, os.O_RDONLY)        # the link itself survives a crash only once the folder is synced
    try:
        os.fsync(fd_dir)
    finally:
        os.close(fd_dir)


# ---------------------------------------------------------------- command line

class _Parser(argparse.ArgumentParser):
    def error(self, message: str) -> Any:
        print(f"stage2: usage: {message}", file=sys.stderr)
        raise SystemExit(EXIT_USAGE)


def _read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def main(argv: list[str] | None = None) -> int:
    """`--pass A|B --stage1 <file> --bundle <file> [--pass-a <file>] [--thresholds <file>] [--params <file>]
    --out <file>`. Exit codes: EXIT_OK, EXIT_FLAGGED, EXIT_BUNDLE, EXIT_PARAMS, EXIT_WRITE, EXIT_CALENDAR,
    EXIT_USAGE, EXIT_STAGE1, EXIT_PASS_A. Each failure prints one line, never a traceback, and writes no output.
    The output is never written over an existing file."""
    ap = _Parser(prog="python -m wt.options.select_stage2", description="Options desk selection, Stage 2 (DEC-0046)")
    ap.add_argument("--pass", dest="pass_id", choices=PASSES, required=True)
    ap.add_argument("--stage1", type=Path, required=True)
    ap.add_argument("--bundle", type=Path, required=True)
    ap.add_argument("--pass-a", type=Path)
    ap.add_argument("--thresholds", type=Path)
    ap.add_argument("--params", type=Path, default=CONFIG_PATH)
    ap.add_argument("--out", type=Path, required=True)
    try:
        a = ap.parse_args(argv)
    except SystemExit as e:
        return e.code if isinstance(e.code, int) else EXIT_USAGE
    if a.pass_id == "A" and a.pass_a is not None:
        print("stage2: usage: --pass-a is for Pass B only", file=sys.stderr)
        return EXIT_USAGE
    try:
        p, sha = load_params(a.params)
        th = Thresholds()
        if a.thresholds is not None:
            import yaml
            th = thresholds_from_mapping(yaml.safe_load(a.thresholds.read_text(encoding="utf-8")))
    except ParamsError as e:
        print(f"stage2: parameters: {e}", file=sys.stderr)
        return EXIT_PARAMS
    except Exception as e:                       # an unreadable thresholds file
        print(f"stage2: thresholds: cannot read ({type(e).__name__})", file=sys.stderr)
        return EXIT_PARAMS
    try:
        stage1 = _read_json(a.stage1)
    except (OSError, UnicodeDecodeError, ValueError, RecursionError) as e:
        print(f"stage2: stage1: cannot read ({type(e).__name__})", file=sys.stderr)
        return EXIT_STAGE1
    pass_a = None
    if a.pass_a is not None:
        try:
            pass_a = _read_json(a.pass_a)
        except (OSError, UnicodeDecodeError, ValueError, RecursionError) as e:
            print(f"stage2: pass A: cannot read ({type(e).__name__})", file=sys.stderr)
            return EXIT_PASS_A
    try:
        bundle = _read_json(a.bundle)
        out = confirm(stage1, bundle, a.pass_id, p, th, sha=sha, pass_a=pass_a)
        text = dumps(out)
    except Stage1Error as e:
        print(f"stage2: stage1: {e}", file=sys.stderr)
        return EXIT_STAGE1
    except PassAError as e:
        print(f"stage2: pass A: {e}", file=sys.stderr)
        return EXIT_PASS_A
    except sel.CalendarError as e:
        print(f"stage2: calendar: {e}", file=sys.stderr)
        return EXIT_CALENDAR
    except (OSError, UnicodeDecodeError, ValueError, RecursionError) as e:
        print(f"stage2: bundle: {type(e).__name__}: {e}", file=sys.stderr)
        return EXIT_BUNDLE
    try:
        write_new(a.out, text)
    except FileExistsError:
        print("stage2: the output already exists: never written over", file=sys.stderr)
        return EXIT_WRITE
    except OSError as e:
        print(f"stage2: cannot write the output ({type(e).__name__})", file=sys.stderr)
        return EXIT_WRITE
    c = out["counts"]
    print(f"stage2 {out['session']} pass {out['pass']}: " + ", ".join(f"{c[k]} {k}" for k in sorted(c))
          + f"; {len(out['reserves'])} reserves; degraded {out['degraded']}; status {out['status']}")
    return EXIT_FLAGGED if out["degraded"] or out["status"] != "ok" else EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())
