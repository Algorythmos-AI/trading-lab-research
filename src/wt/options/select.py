"""Stage 1 of the Options desk's two-stage selection (DEC-0046): after the close, every desk name is scored on five
fixed factors and the top names by rank are picked. Pure scoring: bars and event rows in, a ranking out.

The scoring core (`score_stage1`, `run_bundle` and everything they call) reads no file, makes no network call and
reads no clock: the session date comes in with the bundle. The same bundle and parameters give byte-identical
output (`dumps`). Only the outer functions touch files: `load_params` reads `config/options_select.yaml`,
`picker_ref` reads this module's own source and the two it imports, and `main` reads a bundle and writes the
output. Nothing here fetches bars; a later job saves the bundle this reads. The bundle's daily bars are
split-adjusted.

The frozen definitions, in the order the code applies them (DEC-0046 holds the same text):

- Validity, first failing check wins, on the window (the last `min_bars` bars):
  `bad_bar` (a bar that cannot be read; dates not strictly increasing; a bar dated after `D`; in the window a bar
  without high >= low > 0 and open, close > 0 inside its own high-low range, or a negative volume; a window whose ATR14, ATR5 or ATR20 is zero),
  `stale_bar` (no bar, or the last bar not dated `D`), `short_history` (fewer than `min_bars` bars),
  `missing_session` (the window's dates are not the `min_bars` exchange sessions ending at `D`), `suspect_split` (a
  close-to-close ratio of two adjacent bars in the window below the low bound or above the high bound; a ratio
  equal to a bound is not suspect; with split-adjusted bars it is a backstop that should never fire).
- ATR is `levels.atr(window, n)`; `ATR% = ATR14 / close`; `ret(k) = close / close k bars before D - 1`.
- F1 `abs(ret(20)) / (ATR% * sqrt(20))`; F2 `ATR5 / ATR20`; F3 `-d / ATR14`, `d` the distance from the close to the
  nearest bound of the nearest zone of weight at least the floor, the zones merged by `levels.merge_zones` from
  `levels.levels_for(window, next session)["levels"]` without the prior close's own level (`PDC`), `d = 0` inside a
  zone. A name with no such zone keeps its place in the ranking: F3 has no value, the name carries the caution
  `no_zone`, and it takes the last places on F3 (owner decision, 2026-11-12); F4 `max(c, 1 - c)` with `c` from `levels.close_strength` of the bar of `D`; F5
  `abs(ret(5) - benchmark ret(5)) / (ATR% * sqrt(5))`, `benchmark_missing` when the benchmark's bars are not valid.
  Any other factor that cannot be worked out is never given a value: the name is listed unranked with its reason. A
  factor or shown value that is not a finite number is a data fault (`bad_bar`).
- Each factor value is rounded to `rounding_decimals` before ranking. A larger value ranks first; ties share the
  average rank. On F3, names with no zone share the average of the last places. Every name with all five factors is ranked, whatever its events, so an event never moves another
  name's rank. Score = the sum of the five ranks, lower first; ties go to the smaller F3 distance (no zone sorts after
  every distance), then the larger
  20-bar median dollar volume, then the symbol A to Z.
- Events: a report released after the close of `D` and up to the close of the next session makes the name
  ineligible (`earnings_gap`); a report after that, up to `earnings_later_days` calendar days after the next
  session, is a caution (`earnings_later`); a single name whose next date is not in the rows and whose last row is
  more than `earnings_unknown_after_days` old is a caution (`earnings_date_unknown`, `events.earnings_gaps`). A
  high-severity macro row on the next session is a market-wide note.
- Never fill: the picks are the first `min(pick_count, eligible)` eligible names by final rank. None gives
  `no_selection_text`.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import io
import json
import math
import statistics
import sys
import tokenize
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from wt.options import levels as lv
from wt.risk import events as ev

OUTPUT_SCHEMA = "wt.options.select/stage1"
BUNDLE_SCHEMA = "wt.options.select/stage1-bundle"
OUTPUT_VERSION = 1
BUNDLE_VERSION = 1
BUNDLE_ADJUSTMENT = "split"                   # Stage 1's daily bars are split-adjusted (Alpaca `adjustment=split`)

FACTORS = ("F1", "F2", "F3", "F4", "F5")
# The order the validity checks run in; the first that fails names the reason.
VALIDITY_CODES = ("bad_bar", "stale_bar", "short_history", "missing_session", "suspect_split")
REASON_CODES = VALIDITY_CODES + ("benchmark_missing", "internal_error")
ELIGIBILITY_CODES = ("earnings_gap",)
CAUTION_CODES = ("no_zone", "earnings_later", "earnings_date_unknown", "earnings_row_unreadable")
NOTE_CODES = ("macro_high_next_session", "next_session_half_day")
TIE_BREAK = ("f3_distance_smaller", "median_dollar_volume_larger", "symbol_a_to_z")
_WHEN_ORDER = {"bmo": 0, "during": 1, "amc": 2}

ROOT = Path(__file__).resolve().parents[3]
CONFIG_PATH = ROOT / "config" / "options_select.yaml"
# The code the output depends on, as repo paths: the picker_ref is a hash of their tokens.
PICKER_FILES = ("src/wt/options/levels.py", "src/wt/options/select.py", "src/wt/risk/events.py")

# Exit codes of `main`.
EXIT_OK = 0                 # the output is written and every name was scored without an internal error
EXIT_INTERNAL_ERROR = 1     # the output is written and at least one name has `internal_error` (the gate fails)
EXIT_BUNDLE = 2             # the bundle could not be read or is not in the documented shape: nothing written
EXIT_PARAMS = 3             # the parameters file could not be read or holds what the code does not implement
EXIT_WRITE = 4              # the output could not be written
EXIT_CALENDAR = 5           # the session's window or next session lies outside the session calendar's range
EXIT_USAGE = 6              # the command line is not one this command takes
# The session calendar's range (levels.HOLIDAYS covers whole years from 2024; levels.CALENDAR_THROUGH is its end).
CALENDAR_FROM = f"{min(lv.HOLIDAYS)[:4]}-01-01"


class ParamsError(ValueError):
    """The parameters file does not hold what this code implements."""


class BundleError(ValueError):
    """The input bundle is not in the documented shape."""


class CalendarError(ValueError):
    """The session's 260-session window or its next session lies outside the session calendar's range."""


# ---------------------------------------------------------------- parameters

@dataclass(frozen=True)
class Params:
    min_bars: int
    f1_return: int
    f5_return: int
    atr: int
    atr_fast: int
    atr_slow: int
    dollar_volume: int
    zone_weight_floor: int
    zone_exclude: tuple[str, ...]
    split_low: float
    split_high: float
    decimals: int
    benchmark_default: str
    benchmark_when: dict[str, str]
    pick_count: int
    index_names: tuple[str, ...]
    earnings_later_days: int
    earnings_unknown_after_days: int
    macro_note_severity: str
    trend_averages: tuple[int, ...]
    direction_from_return: int
    hv_returns: int
    hv_year_days: int
    no_selection_text: str

    def benchmark(self, symbol: str) -> str:
        return self.benchmark_when.get(symbol, self.benchmark_default)


def _int(v: Any, what: str, low: int = 1) -> int:
    """A YAML integer. A float such as 260.0 is refused: it would give another hash for the same value."""
    if isinstance(v, bool) or not isinstance(v, int) or v < low:
        raise ParamsError(f"{what} must be written as a whole number of at least {low}")
    return int(v)


def _float(v: Any, what: str) -> float:
    """A YAML float. An integer such as 2 is refused: it would give another hash for the same value as 2.0."""
    if not isinstance(v, float) or not math.isfinite(v) or v <= 0:
        raise ParamsError(f"{what} must be written as a positive decimal number (2.0, not 2)")
    return v


def _strs(v: Any, what: str) -> tuple[str, ...]:
    if not isinstance(v, list) or not all(isinstance(x, str) and x for x in v):
        raise ParamsError(f"{what} must be a list of words")
    return tuple(v)


def _same(v: Any, want: tuple[str, ...], what: str) -> None:
    if _strs(v, what) != want:
        raise ParamsError(f"{what} must be exactly {list(want)}: the code implements those and no other")


def _exactly(node: Any, keys: set[str], what: str) -> Mapping[str, Any]:
    if not isinstance(node, Mapping) or set(node) != keys:
        raise ParamsError(f"{what} must hold exactly the keys {sorted(keys)}")
    return node


def params_from_mapping(cfg: Any) -> Params:
    """The parameters as parsed from `config/options_select.yaml`. Raises ParamsError on any key, value or list the
    code does not implement, so the file and the code cannot drift apart."""
    top = _exactly(cfg, {"version", "history", "lookbacks", "zones", "split_suspect", "rounding_decimals",
                         "benchmark", "tie_break", "pick_count", "index_names", "events", "shown", "reason_codes",
                         "eligibility_codes", "caution_codes", "note_codes", "no_selection_text"}, "the parameters")
    if _int(top["version"], "version") != 1:
        raise ParamsError("version must be 1")
    hist = _exactly(top["history"], {"min_bars"}, "history")
    lb = _exactly(top["lookbacks"], {"f1_return", "f5_return", "atr", "atr_ratio", "dollar_volume"}, "lookbacks")
    zn = _exactly(top["zones"], {"weight_floor", "exclude_members"}, "zones")
    sp = _exactly(top["split_suspect"], {"low", "high", "bound_is_suspect"}, "split_suspect")
    bm = _exactly(top["benchmark"], {"default", "when_name_is"}, "benchmark")
    evs = _exactly(top["events"], {"earnings_later_days", "earnings_unknown_after_days", "macro_note_severity"},
                   "events")
    sh = _exactly(top["shown"], {"trend_averages", "direction_from_return", "hv_returns", "hv_year_days",
                                 "hv_stdev"}, "shown")
    fast_slow = lb["atr_ratio"]
    if not isinstance(fast_slow, list) or len(fast_slow) != 2:
        raise ParamsError("lookbacks.atr_ratio must be [fast, slow]")
    if sp["bound_is_suspect"] is not False:
        raise ParamsError("split_suspect.bound_is_suspect must be false: a ratio equal to a bound is valid")
    if sh["hv_stdev"] != "sample":
        raise ParamsError("shown.hv_stdev must be sample: the code uses the sample standard deviation")
    for k, want in (("reason_codes", REASON_CODES), ("eligibility_codes", ELIGIBILITY_CODES),
                    ("caution_codes", CAUTION_CODES), ("note_codes", NOTE_CODES), ("tie_break", TIE_BREAK)):
        _same(top[k], want, k)
    when = bm["when_name_is"]
    if not isinstance(when, Mapping) or not all(isinstance(a, str) and isinstance(b, str) for a, b in when.items()):
        raise ParamsError("benchmark.when_name_is must map a symbol to a symbol")
    if not isinstance(bm["default"], str) or not isinstance(top["no_selection_text"], str):
        raise ParamsError("benchmark.default and no_selection_text must be words")
    if evs["macro_note_severity"] not in ("high", "medium"):
        raise ParamsError("events.macro_note_severity must be a severity the macro file uses")
    if not isinstance(sh["trend_averages"], list):
        raise ParamsError("shown.trend_averages must be a list")
    p = Params(
        min_bars=_int(hist["min_bars"], "history.min_bars"),
        f1_return=_int(lb["f1_return"], "lookbacks.f1_return"),
        f5_return=_int(lb["f5_return"], "lookbacks.f5_return"),
        atr=_int(lb["atr"], "lookbacks.atr"),
        atr_fast=_int(fast_slow[0], "lookbacks.atr_ratio[0]"),
        atr_slow=_int(fast_slow[1], "lookbacks.atr_ratio[1]"),
        dollar_volume=_int(lb["dollar_volume"], "lookbacks.dollar_volume"),
        zone_weight_floor=_int(zn["weight_floor"], "zones.weight_floor"),
        zone_exclude=_strs(zn["exclude_members"], "zones.exclude_members"),
        split_low=_float(sp["low"], "split_suspect.low"),
        split_high=_float(sp["high"], "split_suspect.high"),
        decimals=_int(top["rounding_decimals"], "rounding_decimals"),
        benchmark_default=bm["default"],
        benchmark_when=dict(when),
        pick_count=_int(top["pick_count"], "pick_count"),
        index_names=_strs(top["index_names"], "index_names"),
        earnings_later_days=_int(evs["earnings_later_days"], "events.earnings_later_days", 0),
        earnings_unknown_after_days=_int(evs["earnings_unknown_after_days"], "events.earnings_unknown_after_days"),
        macro_note_severity=evs["macro_note_severity"],
        trend_averages=tuple(_int(n, "shown.trend_averages") for n in sh["trend_averages"]),
        direction_from_return=_int(sh["direction_from_return"], "shown.direction_from_return"),
        hv_returns=_int(sh["hv_returns"], "shown.hv_returns", 2),
        hv_year_days=_int(sh["hv_year_days"], "shown.hv_year_days"),
        no_selection_text=top["no_selection_text"],
    )
    if p.split_low >= p.split_high:
        raise ParamsError("split_suspect.low must be below split_suspect.high")
    longest = max(p.f1_return, p.f5_return, p.atr, p.atr_fast, p.atr_slow, p.dollar_volume, *p.trend_averages,
                  p.direction_from_return, p.hv_returns)
    if p.min_bars <= longest:
        raise ParamsError("history.min_bars must exceed every lookback")
    return p


def canonical_json(obj: Any) -> str:
    """The canonical text of a parsed document: JSON with keys sorted, no spaces (separators `,` and `:`), ASCII only,
    no NaN or infinity. A YAML or JSON integer is written as a JSON integer and a float in Python's float repr, so
    2.0 stays 2.0 and 2 stays 2."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False)


def params_sha(cfg: Mapping[str, Any]) -> str:
    """SHA-256 (hex) of `canonical_json` of the parsed file, encoded as UTF-8. Comments and layout do not count."""
    return hashlib.sha256(canonical_json(cfg).encode("utf-8")).hexdigest()


def bundle_sha(doc: Any) -> str:
    """SHA-256 (hex) of `canonical_json` of the parsed input bundle, encoded as UTF-8: which input an output came from.
    Key order and spacing in the file do not count; every value does."""
    return hashlib.sha256(canonical_json(doc).encode("utf-8")).hexdigest()


def load_params(path: Path = CONFIG_PATH) -> tuple[Params, str]:
    """Read and check the parameters file; return the parameters and their `params_sha`. Raises ParamsError for a file
    that cannot be read, is not YAML, or is not in the documented shape."""
    import yaml
    try:
        cfg = yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, yaml.YAMLError) as e:
        raise ParamsError(f"cannot read {path.name} ({type(e).__name__})") from None
    return params_from_mapping(cfg), params_sha(cfg)


def picker_ref(root: Path = ROOT, files: Sequence[str] = PICKER_FILES) -> str:
    """The code version: `s1-` and the first 12 hex digits of SHA-256 over the Python tokens of `files`, in the order
    given, comments and blank lines dropped, each file's path then its tokens joined by one space. A change to the
    code the scoring runs gives a new value; a comment does not. No clock and no git state enter it."""
    h = hashlib.sha256()
    for rel in files:
        text = (root / rel).read_text(encoding="utf-8")
        toks = [t.string for t in tokenize.generate_tokens(io.StringIO(text).readline)
                if t.type not in (tokenize.COMMENT, tokenize.NL)]
        h.update(rel.encode("utf-8") + b"\n" + " ".join(toks).encode("utf-8") + b"\n")
    return "s1-" + h.hexdigest()[:12]


# ---------------------------------------------------------------- bars and validity

def _price(v: Any) -> float | None:
    if isinstance(v, bool) or not isinstance(v, int | float):
        return None
    try:
        x = float(v)
    except OverflowError:                       # an integer too large for a float: a data fault, not a code error
        return None
    return x if math.isfinite(x) else None


def parse_bars(raw: Any) -> list[lv.Bar] | None:
    """A bundle's bar list as `levels.Bar`s, or None when any bar is not an object with a `d` of exactly YYYY-MM-DD
    and finite numbers `o`, `h`, `l`, `c`, `v`."""
    if not isinstance(raw, list):
        return None
    out: list[lv.Bar] = []
    for b in raw:
        if not isinstance(b, Mapping) or set(b) != {"d", "o", "h", "l", "c", "v"} or ev.exact_date(b["d"]) is None:
            return None
        o, h, lo, c, v = (_price(b[k]) for k in ("o", "h", "l", "c", "v"))
        if o is None or h is None or lo is None or c is None or v is None:
            return None
        out.append(lv.Bar(b["d"], o, h, lo, c, v))
    return out


def session_window(session: str, n: int) -> list[str]:
    """The `n` exchange sessions ending at `session`, oldest first, walking back with `levels.prev_session`."""
    out = [session]
    while len(out) < n:
        out.append(lv.prev_session(out[-1]))
    return out[::-1]


def validity(bars: list[lv.Bar] | None, session: str, p: Params, sessions: Sequence[str] | None = None) -> str | None:
    """The first validity check that fails (VALIDITY_CODES order), or None when the name is data-valid. `sessions` is
    `session_window(session, p.min_bars)`, passed in so a run works it out once."""
    if bars is None or any(a.d >= b.d for a, b in zip(bars, bars[1:], strict=False)):
        return "bad_bar"
    if bars and bars[-1].d > session:
        return "bad_bar"
    window = bars[-p.min_bars:]
    if any(not (b.h >= b.l > 0 and b.l <= b.o <= b.h and b.l <= b.c <= b.h and b.v >= 0) for b in window):
        return "bad_bar"
    longest_atr = max(p.atr, p.atr_fast, p.atr_slow)
    if len(window) > longest_atr and any(lv.atr(window, n) <= 0 for n in (p.atr, p.atr_fast, p.atr_slow)):
        return "bad_bar"                                         # a rangeless window: ATR of zero
    if not bars or bars[-1].d != session:
        return "stale_bar"
    if len(bars) < p.min_bars:
        return "short_history"
    want = sessions if sessions is not None else session_window(session, p.min_bars)
    if [b.d for b in window] != list(want):
        return "missing_session"
    for a, b in zip(window, window[1:], strict=False):
        r = b.c / a.c
        if r < p.split_low or r > p.split_high:
            return "suspect_split"
    return None


# ---------------------------------------------------------------- factors

def _r(x: float, p: Params) -> float:
    return round(x, p.decimals) + 0.0          # + 0.0 turns -0.0 into 0.0, so the text never says "-0.0"


def ret(window: Sequence[lv.Bar], k: int) -> float:
    """Close on the last bar over the close `k` bars before it, minus 1."""
    return window[-1].c / window[-1 - k].c - 1


def atr_pct(window: Sequence[lv.Bar], p: Params) -> float:
    """ATR14 over the last close."""
    return lv.atr(list(window), p.atr) / window[-1].c


def f1(window: Sequence[lv.Bar], p: Params) -> float:
    """F1: abs(ret(20)) over ATR% times the square root of 20."""
    return abs(ret(window, p.f1_return)) / (atr_pct(window, p) * math.sqrt(p.f1_return))


def f2(window: Sequence[lv.Bar], p: Params) -> float:
    """F2: ATR5 over ATR20."""
    w = list(window)
    return lv.atr(w, p.atr_fast) / lv.atr(w, p.atr_slow)


def f3_zones(levels: Sequence[lv.Level], close: float, p: Params) -> list[lv.Zone]:
    """F3's zones: the levels engine's merge (`levels.merge_zones`) of the session's levels without the excluded
    members (the prior close's own level, `PDC`: the close is not support or resistance for itself)."""
    return lv.merge_zones([x for x in levels if x.name not in p.zone_exclude], close)


def zone_distance(zones: Sequence[lv.Zone], close: float, p: Params) -> float | None:
    """`d` for F3: the distance from `close` to the nearest bound of the nearest zone of weight >= the floor; 0 inside
    a zone (bounds included); None when no zone qualifies."""
    best: float | None = None
    for z in zones:
        if z["weight"] < p.zone_weight_floor:
            continue
        d = 0.0 if z["lo"] <= close <= z["hi"] else min(abs(close - z["lo"]), abs(close - z["hi"]))
        best = d if best is None else min(best, d)
    return best


def f3_distance(window: list[lv.Bar], next_session: str, p: Params) -> float | None:
    """`d / ATR14` for F3 (F3 is its negative), or None for `no_zone`."""
    close = window[-1].c
    zones = f3_zones(lv.levels_for(window, next_session)["levels"], close, p)
    d = zone_distance(zones, close, p)
    return None if d is None else d / lv.atr(window, p.atr)


def f4(window: Sequence[lv.Bar]) -> float:
    """F4: max(c, 1 - c), `c` where the close of the last bar sits in its range (0.5 when high equals low)."""
    c, _ = lv.close_strength(window[-1])
    return max(c, 1 - c)


def f5(window: Sequence[lv.Bar], bench: Sequence[lv.Bar], p: Params) -> float:
    """F5: abs(ret(5) minus the benchmark's ret(5)) over ATR% times the square root of 5."""
    return abs(ret(window, p.f5_return) - ret(bench, p.f5_return)) / (atr_pct(window, p) * math.sqrt(p.f5_return))


def hv(window: Sequence[lv.Bar], p: Params) -> float:
    """Shown only: the sample standard deviation of the last `hv_returns` daily log returns, times sqrt(hv_year_days)."""
    closes = [b.c for b in window[-p.hv_returns - 1:]]
    logs = [math.log(b / a) for a, b in zip(closes, closes[1:], strict=False)]
    return statistics.stdev(logs) * math.sqrt(p.hv_year_days)


@dataclass
class Computed:
    """One name's factors as worked out, before rounding: `score_stage1` rounds them before it ranks."""
    factors: dict[str, float | None]   # F3 is None when no zone qualifies (the caution `no_zone`)
    f3_distance: float | None          # d / ATR14, None when no zone qualifies
    dollar_volume: float               # median of close x volume over the last `dollar_volume` bars
    shown: dict[str, Any]              # rounded already: shown, never ranked


def _finite(x: Any) -> bool:
    if isinstance(x, dict):
        return all(_finite(v) for v in x.values())
    return not isinstance(x, float) or math.isfinite(x)          # None (F3 with no zone) is not a number: passes


def _rn(x: float | None, p: Params) -> float | None:
    return None if x is None else _r(x, p)


def factors(window: list[lv.Bar], bench: list[lv.Bar] | None, next_session: str, p: Params) -> Computed | str:
    """The five factors of one data-valid name, or the reason code when one cannot be worked out. F3 with no zone is
    None (the name stays ranked, last on F3). A value that is not a finite number is a data fault: `bad_bar`."""
    close = window[-1].c
    a14 = lv.atr(window, p.atr)
    if bench is None:
        return "benchmark_missing"
    dist = f3_distance(window, next_session, p)
    vals: dict[str, float | None] = {"F1": f1(window, p), "F2": f2(window, p), "F3": None if dist is None else -dist,
                                     "F4": f4(window), "F5": f5(window, bench, p)}
    dv = statistics.median(b.c * b.v for b in window[-p.dollar_volume:])
    trend = {}
    for n in p.trend_averages:
        ma = _r(sum(b.c for b in window[-n:]) / n, p)
        trend[f"ma{n}"] = "above" if _r(close, p) > ma else "below" if _r(close, p) < ma else "at"
    rd = _r(ret(window, p.direction_from_return), p)
    shown = {"atr14": _r(a14, p), "atr_pct": _r(atr_pct(window, p), p), "close": _r(close, p),
             f"hv{p.hv_returns}": _r(hv(window, p), p), "trend": trend,
             "direction": "up" if rd > 0 else "down" if rd < 0 else "flat"}
    if not (_finite(vals) and _finite(shown) and (dist is None or math.isfinite(dist)) and math.isfinite(dv)):
        return "bad_bar"
    return Computed(vals, dist, dv, shown)


def average_ranks(values: Mapping[str, float | None]) -> dict[str, float]:
    """Rank 1 for the largest value; equal values share the mean of the places they take. Names whose value is None
    (F3 with no zone) take the last places together: with n names of which k have None, each gets (n - k + 1 + n) / 2.
    A None never enters arithmetic or a comparison of values."""
    have = {s: v for s, v in values.items() if v is not None}
    missing = sorted(s for s, v in values.items() if v is None)
    out = _ranks_of(have)
    n, k = len(values), len(missing)
    for s in missing:
        out[s] = (n - k + 1 + n) / 2
    return out


def _ranks_of(values: Mapping[str, float]) -> dict[str, float]:
    order = sorted(values, key=lambda s: (-values[s], s))
    out: dict[str, float] = {}
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and values[order[j + 1]] == values[order[i]]:
            j += 1
        for s in order[i:j + 1]:
            out[s] = (i + 1 + j + 1) / 2
        i = j + 1
    return out


# ---------------------------------------------------------------- events

def _release_key(row: Mapping[str, Any]) -> tuple[str, int]:
    return str(row["date"]), _WHEN_ORDER[str(row["when"])]


@dataclass
class Events:
    gap: set[str]
    cautions: dict[str, list[str]]
    notes: list[dict[str, Any]]
    unreadable: dict[str, int]


def read_events(names: Sequence[str], session: str, next_session: str, earnings_rows: Sequence[Any],
                macro_rows: Sequence[Any], p: Params) -> Events:
    """R4 from the bundle's event rows. A row the repo's own readers call malformed (`events.earnings_row_problem`,
    `events.macro_row_problem`) takes no part and is counted; a malformed earnings row naming a desk name is a
    caution for that name."""
    cautions: dict[str, set[str]] = {n: set() for n in names}
    good: list[Mapping[str, Any]] = []
    bad_e = bad_m = 0
    for r in earnings_rows:
        if not isinstance(r, Mapping) or ev.earnings_row_problem(r) is not None:
            bad_e += 1
            sym = r.get("symbol") if isinstance(r, Mapping) else None
            if isinstance(sym, str) and sym.strip().upper() in cautions:
                cautions[sym.strip().upper()].add("earnings_row_unreadable")
            continue
        good.append(r)
    gap: set[str] = set()
    start, end = (session, _WHEN_ORDER["amc"]), (next_session, _WHEN_ORDER["during"])
    later_to = (dt.date.fromisoformat(next_session) + dt.timedelta(days=p.earnings_later_days)).isoformat()
    for r in good:
        sym = str(r["symbol"])
        if sym not in cautions:
            continue
        k = _release_key(r)
        if start <= k <= end:
            gap.add(sym)
        elif k > end and k[0] <= later_to:
            cautions[sym].add("earnings_later")
    single = ev.single_names(names, p.index_names)
    for sym in ev.earnings_gaps(good, single, dt.date.fromisoformat(session), p.earnings_unknown_after_days):
        cautions[sym].add("earnings_date_unknown")
    macro: set[str] = set()
    for r in macro_rows:
        if not isinstance(r, Mapping) or ev.macro_row_problem(r) is not None:
            bad_m += 1
            continue
        if r["date"] == next_session and r["severity"] == p.macro_note_severity:
            macro.add(str(r["type"]))
    notes: list[dict[str, Any]] = []
    if macro:
        notes.append({"code": "macro_high_next_session", "types": sorted(macro)})
    if next_session in lv.HALF_DAYS:
        notes.append({"code": "next_session_half_day"})
    return Events(gap, {n: sorted(c) for n, c in cautions.items()}, notes,
                  {"earnings_rows": bad_e, "macro_rows": bad_m})


# ---------------------------------------------------------------- the run

def score_stage1(session: str, names: Sequence[str], bars: Mapping[str, Any], earnings_rows: Sequence[Any],
                 macro_rows: Sequence[Any], p: Params, *, sha: str, ref: str,
                 input_sha: str | None = None) -> dict[str, Any]:
    """Stage 1 for `session` (the finished session D). `bars` maps a name to its bundle bar list. The result is a
    plain JSON-ready structure; see `dumps` for its text form. `input_sha` is the bundle's `bundle_sha`."""
    syms = sorted(set(names))
    nxt = lv.next_session(session)
    want = session_window(session, p.min_bars)
    windows: dict[str, list[lv.Bar]] = {}
    reason: dict[str, str] = {}
    error: dict[str, str] = {}
    for s in syms:
        try:
            parsed = parse_bars(bars.get(s, []))
            why = validity(parsed, session, p, want)
            if why is None and parsed is not None:
                windows[s] = parsed[-p.min_bars:]
            else:
                reason[s] = why or "bad_bar"
        except Exception as e:                                    # one name never stops the others
            reason[s], error[s] = "internal_error", type(e).__name__
    done: dict[str, Computed] = {}
    for s in sorted(windows):
        try:
            got = factors(windows[s], windows.get(p.benchmark(s)), nxt, p)
        except Exception as e:
            reason[s], error[s] = "internal_error", type(e).__name__
            continue
        if isinstance(got, str):
            reason[s] = got
        else:                                                     # rounded here, before any ranking
            done[s] = Computed({f: _rn(got.factors[f], p) for f in FACTORS}, _rn(got.f3_distance, p),
                               _r(got.dollar_volume, p), got.shown)
    events = read_events(syms, session, nxt, earnings_rows, macro_rows, p)

    ranks = {f: average_ranks({s: c.factors[f] for s, c in done.items()}) for f in FACTORS}
    score = {s: sum(ranks[f][s] for f in FACTORS) for s in done}
    def tie_key(s: str) -> tuple[float, bool, float, float, str]:
        d = done[s].f3_distance                                    # no zone: after every name with a distance
        return score[s], d is None, 0.0 if d is None else d, -done[s].dollar_volume, s

    order = sorted(done, key=tie_key)
    final = {s: i + 1 for i, s in enumerate(order)}
    eligible = [s for s in order if s not in events.gap]
    picks = eligible[:min(p.pick_count, len(eligible))]
    valid = [s for s in syms if s in windows and reason.get(s) not in VALIDITY_CODES]

    rows = []
    for s in order + sorted(set(syms) - set(done)):
        c = done.get(s)
        why = reason.get(s)
        elig = "earnings_gap" if c is not None and s in events.gap else (why or "eligible")
        rows.append({
            "symbol": s,
            "data_valid": s in valid,
            "reason": why,
            "error_class": error.get(s),
            "benchmark": p.benchmark(s),
            "factors": None if c is None else {f: {"value": c.factors[f], "rank": ranks[f][s]} for f in FACTORS},
            "f3_distance_atr": None if c is None else c.f3_distance,
            "median_dollar_volume": None if c is None else c.dollar_volume,
            "score": None if c is None else score[s],
            "final_rank": final.get(s),
            "eligible": elig == "eligible",
            "eligibility": elig,
            "cautions": sorted(events.cautions.get(s, []) + (["no_zone"] if c is not None and c.f3_distance is None
                                                              else [])),
            "picked": s in picks,
            "shown": None if c is None else c.shown,
        })
    return {
        "schema": OUTPUT_SCHEMA,
        "version": OUTPUT_VERSION,
        "session": session,
        "next_session": nxt,
        "params_sha": sha,
        "picker_ref": ref,
        "bundle_sha": input_sha,
        "status": "internal_error" if error else "ok",
        "counts": {"names": len(syms), "data_valid": len(valid), "ranked": len(done), "eligible": len(eligible),
                   "picked": len(picks)},
        "picks": picks,
        "selection_note": None if picks else p.no_selection_text,
        "market_notes": events.notes,
        "unreadable_event_rows": events.unreadable,
        "names": rows,
    }


def _all_finite(x: Any) -> bool:
    if isinstance(x, float):
        return math.isfinite(x)
    if isinstance(x, Mapping):
        return all(_all_finite(v) for v in x.values())
    if isinstance(x, list):
        return all(_all_finite(v) for v in x)
    return True


def check_calendar(session: str, p: Params) -> None:
    """Raise CalendarError unless the `min_bars` sessions ending at `session` and the session after it all lie inside
    the session calendar's range (CALENDAR_FROM to levels.CALENDAR_THROUGH)."""
    if session < CALENDAR_FROM or session > lv.CALENDAR_THROUGH:
        raise CalendarError(f"session {session} is outside the session calendar ({CALENDAR_FROM} to "
                            f"{lv.CALENDAR_THROUGH})")
    try:
        nxt = lv.next_session(session)
    except ValueError:
        nxt = ""
    if not nxt or nxt > lv.CALENDAR_THROUGH:
        raise CalendarError(f"the session after {session} is past the session calendar's end ({lv.CALENDAR_THROUGH})")
    first = session_window(session, p.min_bars)[0]
    if first < CALENDAR_FROM:
        raise CalendarError(f"the {p.min_bars} sessions ending at {session} start on {first}, before the session "
                            f"calendar's first covered date ({CALENDAR_FROM})")


def check_bundle(doc: Any) -> None:
    """Raise BundleError unless `doc` is an input bundle of the documented shape:

        {"schema": "wt.options.select/stage1-bundle", "version": 1,
         "session": "YYYY-MM-DD",                 the finished session D, a session of the calendar
         "adjustment": "split",                   the daily bars are split-adjusted (Alpaca adjustment=split)
         "names": ["SPY", ...],                   the names to score, distinct, upper case
         "bars": {"SPY": [{"d": "YYYY-MM-DD", "o": 1.0, "h": 1.0, "l": 1.0, "c": 1.0, "v": 0}, ...], ...},
         "earnings_rows": [{...}, ...],           config/events/earnings.csv rows as csv.DictReader gives them
         "macro_rows": [{...}, ...]}              config/events/macro_events.csv rows, likewise

    A name in `names` with no entry in `bars` is scored as having no bars (`stale_bar`); a malformed bar list is
    that name's `bad_bar`, not a bundle error. Bars are daily, oldest first. A NaN or infinite number anywhere in the
    bundle is not the documented shape."""
    if not isinstance(doc, Mapping):
        raise BundleError("the bundle is not an object")
    if not _all_finite(doc):
        raise BundleError("the bundle is not in the documented shape: it holds a NaN or infinite number")
    want = {"schema", "version", "session", "adjustment", "names", "bars", "earnings_rows", "macro_rows"}
    if set(doc) != want:
        raise BundleError(f"the bundle must hold exactly the keys {sorted(want)}")
    if doc["schema"] != BUNDLE_SCHEMA or isinstance(doc["version"], bool) or doc["version"] != BUNDLE_VERSION:
        raise BundleError("not a stage 1 bundle of a version this code reads")
    if doc["adjustment"] != BUNDLE_ADJUSTMENT:
        raise BundleError("the bundle's bars must be split-adjusted: adjustment must be \"split\"")
    s = doc["session"]
    if ev.exact_date(s) is None or not lv.is_session(s):
        raise BundleError("session is not a session date")
    names = doc["names"]
    if (not isinstance(names, list) or not names or len(set(map(str, names))) != len(names)
            or not all(isinstance(n, str) and n == n.strip().upper() and n for n in names)):
        raise BundleError("names must be distinct upper-case symbols")
    if not isinstance(doc["bars"], Mapping):
        raise BundleError("bars must map a symbol to its bars")
    if not isinstance(doc["earnings_rows"], list) or not isinstance(doc["macro_rows"], list):
        raise BundleError("earnings_rows and macro_rows must be lists")


def run_bundle(doc: Any, p: Params, *, sha: str, ref: str) -> dict[str, Any]:
    """Stage 1 on an input bundle, reading nothing but the bundle. Raises BundleError or CalendarError."""
    check_bundle(doc)
    check_calendar(doc["session"], p)
    return score_stage1(doc["session"], doc["names"], doc["bars"], doc["earnings_rows"], doc["macro_rows"], p,
                        sha=sha, ref=ref, input_sha=bundle_sha(doc))


def dumps(out: Mapping[str, Any]) -> str:
    """The output's text: JSON, keys sorted, one-space indent, ASCII, a final newline."""
    return json.dumps(out, sort_keys=True, indent=1, ensure_ascii=True, allow_nan=False) + "\n"


class _Parser(argparse.ArgumentParser):
    """An argument parser whose usage errors print one line and exit with EXIT_USAGE."""

    def error(self, message: str) -> Any:
        print(f"stage1: usage: {message}", file=sys.stderr)
        raise SystemExit(EXIT_USAGE)


def main(argv: list[str] | None = None) -> int:
    """`stage1 --bundle <file> --out <file> [--params <file>]`. Exit codes: EXIT_OK, EXIT_INTERNAL_ERROR (output
    written, a name failed), EXIT_BUNDLE, EXIT_PARAMS, EXIT_WRITE, EXIT_CALENDAR, EXIT_USAGE; each failure prints one
    line, never a traceback, and writes no output."""
    ap = _Parser(prog="python -m wt.options.select", description="Options desk selection (DEC-0046)")
    sub = ap.add_subparsers(dest="cmd", required=True, parser_class=_Parser)
    s1 = sub.add_parser("stage1", help="score a saved input bundle after the close")
    s1.add_argument("--bundle", type=Path, required=True)
    s1.add_argument("--out", type=Path, required=True)
    s1.add_argument("--params", type=Path, default=CONFIG_PATH)
    try:
        a = ap.parse_args(argv)
    except SystemExit as e:
        return e.code if isinstance(e.code, int) else EXIT_USAGE
    try:
        p, sha = load_params(a.params)
    except ParamsError as e:
        print(f"stage1: parameters: {e}", file=sys.stderr)
        return EXIT_PARAMS
    try:
        doc = json.loads(a.bundle.read_text(encoding="utf-8"))
        out = run_bundle(doc, p, sha=sha, ref=picker_ref())
        text = dumps(out)
    except CalendarError as e:
        print(f"stage1: calendar: {e}", file=sys.stderr)
        return EXIT_CALENDAR
    except (OSError, UnicodeDecodeError, ValueError, RecursionError) as e:
        print(f"stage1: bundle: {type(e).__name__}: {e}", file=sys.stderr)
        return EXIT_BUNDLE
    try:
        a.out.write_text(text, encoding="utf-8")
    except OSError as e:
        print(f"stage1: cannot write the output ({type(e).__name__})", file=sys.stderr)
        return EXIT_WRITE
    print(f"stage1 {out['session']}: {out['counts']['picked']} picked, {out['counts']['eligible']} eligible, "
          f"{out['counts']['data_valid']} of {out['counts']['names']} valid, status {out['status']}")
    return EXIT_OK if out["status"] == "ok" else EXIT_INTERNAL_ERROR


if __name__ == "__main__":
    raise SystemExit(main())
