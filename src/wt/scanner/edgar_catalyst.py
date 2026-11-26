"""The EDGAR proxy for a pool name's catalyst (DEC-0081 point 4, frozen in EXP-0057's config). Pure functions.

For one (name, session), the SEC filings accepted in the pool's own news window, from 16:00 New York on the previous
session to the 09:25 cut (accepted at or after the start, strictly before the cut), are read in this order and the
first match wins:

  buyout    SC 14D9, SC14D9C, PREM14A or DEFM14A under the name's CIK; or SC TO-T, SC TO-T/A, SC TO-C, 425 or SC 13E3
            whose EDGAR index page names the name's CIK "(Subject)"
  offering  424B1, 424B4 or 424B5
  earnings  8-K or 8-K/A with item 2.02
  other     8-K or 8-K/A with item 7.01 or 8.01
  none      nothing above

A name the proxy cannot read is `unknown`, never `none` (DEC-0081 point 5): no CIK in today's map, `map_suspect`
(the CIK filed nothing that year, or its EDGAR names disagree with Alpaca's asset name), or a subject-role filing
whose index page could not be read while nothing else made it a buyout.

`as_pool_columns` gives the reading in the pool's own columns, as DEC-0068's selection reads them. It is the EDGAR
proxy, never "Set F" and never a headline.
"""
from __future__ import annotations

import datetime as dt
import re
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass

import pandas as pd

from wt.core.clock import ET

TARGET_ONLY = frozenset({"SC 14D9", "SC14D9C", "PREM14A", "DEFM14A"})
SUBJECT_ROLE = frozenset({"SC TO-T", "SC TO-T/A", "SC TO-C", "425", "SC 13E3"})
OFFERING = frozenset({"424B1", "424B4", "424B5"})
EIGHT_K = frozenset({"8-K", "8-K/A"})
EARNINGS_ITEMS = frozenset({"2.02"})
OTHER_ITEMS = frozenset({"7.01", "8.01"})
NEEDED_FORMS = TARGET_ONLY | SUBJECT_ROLE | OFFERING | EIGHT_K
CATEGORIES = ("buyout", "offering", "earnings", "other", "none", "unknown")
WINDOW_START = dt.time(16, 0)
CUT = dt.time(9, 25)

# Role of a CIK on a filing: True = "(Subject)", False = listed but not the subject (or not listed), None = unreadable.
RoleLookup = Callable[[str, int], "bool | None"]


@dataclass(frozen=True)
class Reading:
    category: str                       # one of CATEGORIES
    reason: str = ""                    # for unknown: unmapped, map_suspect or role_unreadable
    first_at: pd.Timestamp | None = None    # earliest acceptance (ET) among the filings of the chosen category
    accessions: tuple[str, ...] = ()


def window(session: dt.date, prev_session: dt.date) -> tuple[pd.Timestamp, pd.Timestamp]:
    """[16:00 ET on the previous session, 09:25 ET on the session)."""
    start = pd.Timestamp(dt.datetime.combine(prev_session, WINDOW_START), tz=ET)
    end = pd.Timestamp(dt.datetime.combine(session, CUT), tz=ET)
    if not start < end:
        raise ValueError("the previous session must come before the session")
    return start, end


def in_window(filings: pd.DataFrame, start: pd.Timestamp, end: pd.Timestamp) -> pd.DataFrame:
    t = filings["accepted_at_et"]
    return filings[(t >= start) & (t < end)]


def items_of(value: object) -> frozenset[str]:
    return frozenset(x.strip() for x in str(value or "").split(",") if x.strip())


def _pick(category: str, rows: pd.DataFrame) -> Reading:
    rows = rows.sort_values(["accepted_at_et", "accession"])
    return Reading(category, "", rows["accepted_at_et"].iloc[0], tuple(rows["accession"]))


def classify(filings: pd.DataFrame, cik: int, role: RoleLookup) -> Reading:
    """The proxy category of one name from its filings already cut to the window (columns: form, items,
    accepted_at_et, accession). `role` is asked only for subject-role forms."""
    if filings.empty:
        return Reading("none")
    form = filings["form"]
    target = filings[form.isin(TARGET_ONLY)]
    shared = filings[form.isin(SUBJECT_ROLE)]
    subject_rows, unreadable = [], False
    for idx, acc in zip(shared.index, shared["accession"], strict=True):
        r = role(str(acc), int(cik))
        if r is None:
            unreadable = True
        elif r:
            subject_rows.append(idx)
    buyout = pd.concat([target, filings.loc[subject_rows]])
    if len(buyout):
        return _pick("buyout", buyout)
    if unreadable:
        return Reading("unknown", "role_unreadable")
    offering = filings[form.isin(OFFERING)]
    if len(offering):
        return _pick("offering", offering)
    eight = filings[form.isin(EIGHT_K)]
    items = eight["items"].map(items_of)
    earnings = eight[items.map(lambda s: bool(s & EARNINGS_ITEMS))]
    if len(earnings):
        return _pick("earnings", earnings)
    other = eight[items.map(lambda s: bool(s & OTHER_ITEMS))]
    if len(other):
        return _pick("other", other)
    return Reading("none")


# ---- the map check (R3 of the discovery note) -------------------------------------------------------------------
_STOP = frozenset({"inc", "corp", "corporation", "co", "company", "ltd", "limited", "plc", "llc", "lp", "the", "sa",
                   "nv", "ag", "se", "holdings", "holding", "group", "class", "common", "stock", "shares",
                   "ordinary", "american", "depositary", "ads", "adr", "new", "de", "of", "and"})


def name_tokens(name: str) -> frozenset[str]:
    s = re.sub(r"['’`]", "", str(name or "").lower())
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return frozenset(t for t in s.split() if t not in _STOP)


def names_agree(asset_name: str, edgar_names: Iterable[str]) -> bool:
    """Token subset either way, or Jaccard at least 0.5, after normalising (the discovery note's test)."""
    a = name_tokens(asset_name)
    if not a:
        return True                      # nothing to compare: not evidence of a wrong map
    for n in edgar_names:
        b = name_tokens(n)
        if not b:
            continue
        if a <= b or b <= a or len(a & b) / len(a | b) >= 0.5:
            return True
    return False


def map_suspect(cik_filed_that_year: bool, asset_name: str, edgar_names: Iterable[str]) -> bool:
    return (not cik_filed_that_year) or not names_agree(asset_name, edgar_names)


# ---- in the pool's columns ----------------------------------------------------------------------------------------
def as_pool_columns(r: Reading, earnings_score: float) -> dict[str, object]:
    """The reading in the columns DEC-0068's selection reads (catalyst_status, catalyst_category, catalyst_score,
    headlines_n). `unknown` keeps status "unknown" so a caller must decide; it is never silently "none"."""
    if r.category == "buyout":
        return {"catalyst_status": "excluded", "catalyst_category": "buyout_offer", "catalyst_score": -1.0,
                "headlines_n": 1}
    if r.category == "earnings":
        return {"catalyst_status": "qualifying", "catalyst_category": "earnings_release",
                "catalyst_score": earnings_score, "headlines_n": 1}
    if r.category in ("offering", "other"):
        return {"catalyst_status": "non_qualifying",
                "catalyst_category": "offering_dilution" if r.category == "offering" else "other",
                "catalyst_score": 0.0, "headlines_n": 1}
    if r.category == "none":
        return {"catalyst_status": "none", "catalyst_category": "none", "catalyst_score": 0.0, "headlines_n": 0}
    return {"catalyst_status": "unknown", "catalyst_category": "unknown", "catalyst_score": 0.0, "headlines_n": 0}


def read_name(symbol: str, year: int, events_by_cik: Mapping[int, pd.DataFrame], ticker_cik: Mapping[str, int],
              filed_years: Mapping[int, frozenset[int]], asset_names: Mapping[str, str],
              edgar_names: Mapping[int, tuple[str, ...]], start: pd.Timestamp, end: pd.Timestamp,
              role: RoleLookup) -> Reading:
    """One (name, session): map the symbol, check the map, cut the CIK's filings to the window, classify."""
    cik = ticker_cik.get(symbol)
    if cik is None:
        return Reading("unknown", "unmapped")
    if map_suspect(year in filed_years.get(cik, frozenset()), asset_names.get(symbol, ""),
                   edgar_names.get(cik, ())):
        return Reading("unknown", "map_suspect")
    ev = events_by_cik.get(cik)
    if ev is None or ev.empty:
        return Reading("none")
    return classify(in_window(ev, start, end), cik, role)


# ---- one pool day -------------------------------------------------------------------------------------------------
SIDECAR_COLUMNS = ["symbol", "edgar_category", "edgar_reason", "edgar_first_at", "edgar_accessions",
                   "edgar_catalyst_status", "edgar_catalyst_category", "edgar_catalyst_score", "edgar_headlines_n"]


@dataclass(frozen=True)
class Context:
    """Everything `annotate` reads besides the pool: built once per run."""
    events_by_cik: Mapping[int, pd.DataFrame]
    ticker_cik: Mapping[str, int]
    filed_years: Mapping[int, frozenset[int]]
    asset_names: Mapping[str, str]
    edgar_names: Mapping[int, tuple[str, ...]]
    earnings_score: float


def annotate(symbols: Iterable[str], session: dt.date, prev_session: dt.date, ctx: Context,
             role: RoleLookup) -> pd.DataFrame:
    """The sidecar rows for one pool day, one per symbol, in the pool's order."""
    start, end = window(session, prev_session)
    rows = []
    for sym in symbols:
        r = read_name(str(sym), session.year, ctx.events_by_cik, ctx.ticker_cik, ctx.filed_years, ctx.asset_names,
                      ctx.edgar_names, start, end, role)
        cols = as_pool_columns(r, ctx.earnings_score)
        rows.append({"symbol": str(sym), "edgar_category": r.category, "edgar_reason": r.reason,
                     "edgar_first_at": r.first_at.isoformat() if r.first_at is not None else "", "edgar_accessions": ",".join(r.accessions),
                     **{f"edgar_{k}": v for k, v in cols.items()}})
    return pd.DataFrame(rows, columns=SIDECAR_COLUMNS)
