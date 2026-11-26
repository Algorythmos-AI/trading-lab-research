"""SEC EDGAR filing events: a partial stand-in catalyst source for 2019-2025 (plan step 2, data only).

The Benzinga news history before 2026-04-29 is gone (Alpaca ticket 402305), so a later experiment can use a few SEC
filing types as a proxy for some catalyst categories. This module only collects the filings. It counts nothing against
the candidate pools, and computes no R or P&L.

For each CIK in `data/edgar/ticker_cik.parquet` it reads `https://data.sec.gov/submissions/CIK##########.json` plus
the older pages that file lists under `filings.files`, and writes three tables to `data/edgar/`:

- `events.parquet`: the forms in FORMS filed on or after SINCE, one row per (cik, accession). A filing with a filer
  and a subject (425, SC TO-T) is listed under both CIKs, so it appears once for each. Columns: cik, ticker, form,
  items (8-K item numbers, comma-separated; empty for other forms), accepted_at_et, filing_date, accession, entity
  (the CIK's current EDGAR name). `ticker` holds every ticker the map gives that CIK, sorted and comma-joined
  ("GOOG,GOOGL"); split and explode it to look up by symbol. One row per (filing, ticker) would multiply the banks'
  structured-note 424B2s (JPMorgan alone files ~15k a year under ~10 mapped tickers).
- `cik_meta.parquet`: per CIK, its fetch status, EDGAR name, former names (JSON list of {name, from, to}) and EDGAR's
  own ticker list, for the ticker-reuse check (R3).
- `cik_form_years.parquet`: per (cik, filing year, form), the count of every form filed since SINCE, not only the
  kept ones: whether a CIK filed anything in a year (R3), and the near-miss forms, without a second crawl.

`acceptanceDateTime` is marked "Z" and is true UTC: Apple's 16:30 ET earnings 8-Ks read 20:30Z in summer and 21:30Z
in winter, and the EDGAR index pages show the same instants in ET (R1 in the step-2 discovery note). accepted_at_et
converts UTC to America/New_York.

Resumable: CIKs are fetched in chunks; each finished chunk is written to `data/edgar/events_parts/` as parquets of its
rows and counts, then a JSON checkpoint (written last) naming its CIKs with their meta. A killed build skips every CIK
a checkpoint names as done; a CIK whose older page failed is recorded as failed and retried by the next run. No raw
JSON is kept. Pacing reuses `wt.data.edgar.UA` (generic, no personal contact) at 5 requests/s or fewer, and backs
off on 429/403; if SEC keeps refusing, Throttled stops the build and a rerun resumes it.
"""
from __future__ import annotations

import json
import os
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pandas as pd
import requests

from wt.core.config import DATA_DIR
from wt.data.edgar import MAP, UA

BASE = "https://data.sec.gov/submissions/"
EDGAR = DATA_DIR / "edgar"
OUT = EDGAR / "events.parquet"
PARTS = EDGAR / "events_parts"
SINCE = "2018-06-01"
EIGHT_K = frozenset({"8-K", "8-K/A"})
FORMS = frozenset({"SC TO-T", "SC TO-T/A", "SC TO-C", "SC 14D9", "SC14D9C", "PREM14A", "DEFM14A", "SC 13E3",
                   "425", "424B1", "424B2", "424B3", "424B4", "424B5"}) | EIGHT_K
# SC TO-C and SC14D9C, the tender-offer announcement-day forms, were added by DEC-0081 point 4 (2026-11-26). Each
# checkpoint records the forms it kept (a checkpoint without the field kept LEGACY_FORMS). A CIK whose checkpoint lacks
# a form in FORMS is fetched again; `assemble` reads each CIK from its latest checkpoint only, and `events_meta.json`
# lists the forms every such checkpoint kept, so a store with stale parts can never claim forms it does not hold.
LEGACY_FORMS = FORMS - {"SC TO-C", "SC14D9C"}
COLUMNS = ["cik", "ticker", "form", "items", "accepted_at_et", "filing_date", "accession", "entity"]
ROW_COLUMNS = ["cik", "form", "items", "accepted_at_et", "filing_date", "accession", "entity"]   # before the ticker join
COUNT_COLUMNS = ["cik", "year", "form", "n"]
MIN_INTERVAL = 0.2          # seconds between requests: 5 req/s, half SEC's fair-access ceiling of 10
BACKOFF = (10.0, 30.0, 60.0, 120.0, 300.0)   # waits after a 429/403/5xx or a network error, then give up
ET = "America/New_York"

Getter = Callable[[str], "tuple[int, Any]"]


class Throttled(RuntimeError):
    """SEC kept refusing (429/403/5xx) after every backoff step: stop, and resume later."""


class Fetcher:
    """GET a submissions JSON at no more than one request per MIN_INTERVAL, backing off on 429/403."""

    def __init__(self, session: requests.Session | None = None, sleep: Callable[[float], None] = time.sleep,
                 clock: Callable[[], float] = time.monotonic) -> None:
        self.s = session or requests.Session()
        self.s.headers.update(UA)
        self.sleep, self.clock = sleep, clock
        self.last = -1e9
        self.n = 0

    def _pace(self) -> None:
        wait = self.last + MIN_INTERVAL - self.clock()
        if wait > 0:
            self.sleep(wait)
        self.last = self.clock()

    def __call__(self, name: str) -> tuple[int, Any]:
        """(status, parsed JSON or None). 404 is a normal answer (no such CIK); 429/403/5xx retry with backoff."""
        for wait in (*BACKOFF, None):
            self._pace()
            self.n += 1
            try:
                r = self.s.get(BASE + name, timeout=60)
            except requests.RequestException as e:
                if wait is None:
                    raise Throttled(f"{name}: {type(e).__name__} after {len(BACKOFF)} backoffs") from e
                self.sleep(wait)
                continue
            if r.status_code in (429, 403) or r.status_code >= 500:
                if wait is None:
                    raise Throttled(f"{name}: HTTP {r.status_code} after {len(BACKOFF)} backoffs")
                self.sleep(wait)
                continue
            if r.status_code != 200:
                return r.status_code, None
            return 200, r.json()
        raise AssertionError("unreachable")


def accepted_et(values: Iterable[str]) -> pd.Series:
    """EDGAR acceptanceDateTime strings ("2026-11-02T21:30:23.000Z", true UTC) as tz-aware America/New_York."""
    return pd.to_datetime(pd.Series(list(values), dtype="object"), utc=True, format="ISO8601").dt.tz_convert(ET)


def _block(cols: dict[str, list[Any]], since: str) -> pd.DataFrame:
    """One columnar filings block (the `recent` block or an older page), every form, filed on or after `since`."""
    n = len(cols.get("accessionNumber", []))
    df = pd.DataFrame({"form": cols.get("form", []), "items": cols.get("items") or [""] * n,
                       "accepted": cols.get("acceptanceDateTime", []), "filing_date": cols.get("filingDate", []),
                       "accession": cols.get("accessionNumber", [])})
    return df[df.filing_date >= since]


def _keep(df: pd.DataFrame) -> pd.DataFrame:
    """The kept forms, with acceptance time in ET and 8-K items (other forms carry none)."""
    df = df[df.form.isin(FORMS)].copy()
    df["items"] = df["items"].fillna("").astype(str).where(df.form.isin(EIGHT_K), "")
    df["accepted_at_et"] = accepted_et(df.pop("accepted")).set_axis(df.index)
    df["filing_date"] = pd.to_datetime(df.filing_date).dt.date
    return df


@dataclass
class CikResult:
    status: str                                  # "ok", "missing" (no submissions file) or "failed" (an older page)
    meta: dict[str, Any] = field(default_factory=dict)
    rows: pd.DataFrame | None = None
    counts: pd.DataFrame | None = None


def cik_events(cik: int, get: Getter, since: str = SINCE) -> CikResult:
    """Fetch one CIK's submissions and older pages: its kept rows, its per-year form counts, and its meta."""
    status, d = get(f"CIK{cik:010d}.json")
    if status != 200 or d is None:
        return CikResult("missing", {"cik": cik, "http": status})
    meta = {"cik": cik, "entity": d.get("name") or "", "sec_tickers": ",".join(d.get("tickers") or []),
            "former_names": json.dumps([{"name": f.get("name"), "from": (f.get("from") or "")[:10],
                                         "to": (f.get("to") or "")[:10]} for f in d.get("formerNames") or []])}
    blocks = [_block(d["filings"]["recent"], since)]
    for f in d["filings"].get("files", []):
        if f.get("filingTo", "9999") < since:
            continue                      # an older page that ends before SINCE holds nothing we keep
        st, page = get(f["name"])
        if st != 200 or page is None:
            return CikResult("failed", {**meta, "http": st, "page": f["name"]})
        blocks.append(_block(page, since))
    every = pd.concat(blocks, ignore_index=True).drop_duplicates("accession")   # a page boundary can repeat one
    counts = (every.assign(year=every.filing_date.str[:4].astype(int)).groupby(["year", "form"]).size()
              .rename("n").reset_index())
    counts.insert(0, "cik", cik)
    rows = _keep(every)
    rows.insert(0, "cik", cik)
    rows["entity"] = meta["entity"]
    return CikResult("ok", meta, rows[ROW_COLUMNS], counts[COUNT_COLUMNS])


def _atomic(path: Path, write: Callable[[Path], None]) -> None:
    tmp = path.with_name(path.name + ".tmp")
    write(tmp)
    os.replace(tmp, path)


def _checkpoints(parts: Path) -> list[Path]:
    return sorted(parts.glob("chunk-*.json"))


def _cp_forms(cp: dict[str, Any]) -> frozenset[str]:
    return frozenset(cp["forms"]) if "forms" in cp else LEGACY_FORMS


def done_ciks(parts: Path = PARTS) -> set[int]:
    """Every CIK whose latest checkpoint fetched it ("ok" or "missing") with every form in FORMS kept; "failed" ones,
    and ones fetched by a build that kept fewer forms, are fetched again."""
    latest: dict[int, bool] = {}
    for p in _checkpoints(parts):
        cp = json.loads(p.read_text())
        current = FORMS <= _cp_forms(cp)
        for m in cp["meta"]:
            latest[int(m["cik"])] = m["status"] != "failed" and current
    return {c for c, ok in latest.items() if ok}


def _concat(frames: list[pd.DataFrame], columns: list[str]) -> pd.DataFrame:
    frames = [f for f in frames if len(f)]
    return pd.concat(frames, ignore_index=True)[columns] if frames else pd.DataFrame(columns=columns)


def _write_chunk(parts: Path, results: list[CikResult]) -> None:
    stem = f"chunk-{len(_checkpoints(parts)):05d}-{results[0].meta['cik']}"
    rows = _concat([r.rows for r in results if r.rows is not None], ROW_COLUMNS)
    counts = _concat([r.counts for r in results if r.counts is not None], COUNT_COLUMNS)
    _atomic(parts / f"{stem}.rows.parquet", lambda t: rows.to_parquet(t, index=False))
    _atomic(parts / f"{stem}.counts.parquet", lambda t: counts.to_parquet(t, index=False))
    meta = [{**r.meta, "status": r.status} for r in results]
    text = json.dumps({"meta": meta, "rows": len(rows), "forms": sorted(FORMS)})
    _atomic(parts / f"{stem}.json", lambda t: t.write_text(text))


def assemble(ticker_map: pd.DataFrame, parts: Path = PARTS, out: Path = OUT) -> pd.DataFrame:
    """Join every checkpointed chunk to its tickers and write events, cik_meta and cik_form_years atomically.

    A CIK fetched twice (failed then retried, or re-fetched after FORMS grew) keeps its latest checkpoint only, rows
    and counts included; the manifest lists the forms every checkpoint in use kept."""
    cps = _checkpoints(parts)
    docs = [json.loads(p.read_text()) for p in cps]
    owner: dict[int, int] = {}                           # cik -> index of its latest checkpoint
    for i, d in enumerate(docs):
        for m in d["meta"]:
            owner[int(m["cik"])] = i
    meta = pd.DataFrame([m for i, d in enumerate(docs) for m in d["meta"] if owner[int(m["cik"])] == i])
    if meta.empty:
        meta = pd.DataFrame(columns=["cik", "status", "entity", "sec_tickers", "former_names"])
    good = set(meta.loc[meta.status == "ok", "cik"].astype(int))
    used = sorted(set(owner.values()))
    forms = frozenset.intersection(*(_cp_forms(docs[i]) for i in used)) if used else frozenset()
    stems = [p.with_suffix("") for p in cps]

    def mine(df: pd.DataFrame, i: int) -> pd.DataFrame:
        return df[df.cik.astype(int).map(owner).eq(i)]

    rows = _concat([mine(pd.read_parquet(f"{stems[i]}.rows.parquet"), i) for i in used], ROW_COLUMNS)
    counts = _concat([mine(pd.read_parquet(f"{stems[i]}.counts.parquet"), i) for i in used], COUNT_COLUMNS)
    rows = rows[rows.cik.astype(int).isin(good)].astype({"cik": "int64"}).drop_duplicates(["cik", "accession"])
    rows = rows[rows.form.isin(forms)]
    counts = counts[counts.cik.astype(int).isin(good)].astype({"cik": "int64", "year": "int64", "n": "int64"})
    counts = counts.drop_duplicates(["cik", "year", "form"], keep="last")
    tick = (ticker_map[["ticker", "cik"]].drop_duplicates().astype({"cik": "int64"}).groupby("cik").ticker
            .agg(lambda t: ",".join(sorted(t))).reset_index())
    ev = rows.merge(tick, on="cik", how="inner")[COLUMNS]
    ev = ev.sort_values(["accepted_at_et", "cik", "accession"], kind="stable").reset_index(drop=True)
    out.parent.mkdir(parents=True, exist_ok=True)
    _atomic(out.with_name("cik_meta.parquet"),
            lambda t: meta.astype({"cik": "int64"}).reset_index(drop=True).to_parquet(t, index=False))
    _atomic(out.with_name("cik_form_years.parquet"), lambda t: counts.reset_index(drop=True).to_parquet(t, index=False))
    _atomic(out, lambda t: ev.to_parquet(t, index=False))
    meta_text = json.dumps({"forms": sorted(forms), "since": SINCE, "rows": len(ev)}, indent=1) + "\n"
    _atomic(out.with_name("events_meta.json"), lambda t: t.write_text(meta_text))
    return ev


def built_forms(out: Path = OUT) -> frozenset[str]:
    """The forms the build at `out` kept (empty for a build that predates events_meta.json)."""
    p = out.with_name("events_meta.json")
    return frozenset(json.loads(p.read_text())["forms"]) if p.exists() else frozenset()


def build(get: Getter | None = None, ticker_map: pd.DataFrame | None = None, parts: Path = PARTS, out: Path = OUT,
          chunk: int = 50, limit: int | None = None, since: str = SINCE,
          log: Callable[[str], None] = print) -> pd.DataFrame | None:
    """Fetch every mapped CIK not yet checkpointed, then assemble. `limit` stops after that many CIKs (no assemble),
    for a trial run."""
    tm = ticker_map if ticker_map is not None else pd.read_parquet(MAP)
    get = get or Fetcher()
    parts.mkdir(parents=True, exist_ok=True)
    done = done_ciks(parts)
    todo = [int(c) for c in sorted(tm.cik.unique()) if int(c) not in done]
    if limit is not None:
        todo = todo[:limit]
    log(f"edgar events: {len(done)} CIKs done, {len(todo)} to fetch")
    batch: list[CikResult] = []
    failed = 0
    for i, cik in enumerate(todo, 1):
        res = cik_events(cik, get, since)
        failed += res.status == "failed"
        batch.append(res)
        if len(batch) >= chunk or i == len(todo):
            _write_chunk(parts, batch)
            batch = []
            log(f"  {len(done) + i}/{len(done) + len(todo)} CIKs ({failed} failed this run)")
    if limit is not None:
        return None
    if failed:
        log(f"  {failed} CIKs had a failed older page; rerun to retry them")
    return assemble(tm, parts, out)
