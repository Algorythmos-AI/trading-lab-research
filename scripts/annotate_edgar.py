"""EXP-0057: write the EDGAR-proxy reading beside each pool day (wt.scanner.edgar_catalyst). Data only.

For each pool `data/candidates/DATE.parquet` in the range it writes `data/candidates_edgar/DATE.parquet`, one row per
pool name (it prints only how many name-days it wrote and why names are unknown: no category tally, which is
EXP-0057's to report): the proxy category (buyout, offering, earnings, other, none, unknown), why a name is unknown, the first
acceptance time, the accessions, and the same reading in the pool's catalyst columns (prefixed `edgar_`). The pools
are only read: their sha256 sums are taken before and after, and the run fails if one changed. Nothing is counted,
and no price, entry, exit or result is read.

Needs data/edgar/events.parquet built with every form DEC-0081 names (events_meta.json), cik_form_years.parquet,
cik_meta.parquet, ticker_cik.parquet, data/daily/assets.parquet, and the session calendar (Alpaca /v2/calendar, cached
in data/edgar/sessions.json). Shared deal filings' roles come from their EDGAR index pages, cached in
data/edgar/roles.json.

Usage: PYTHONPATH=src .venv/bin/python scripts/annotate_edgar.py 2026-04-30 2026-11-25 [--data DIR]
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from wt.core.config import DATA_DIR  # noqa: E402
from wt.data import edgar_events as ee  # noqa: E402
from wt.data.edgar_roles import RoleCache  # noqa: E402
from wt.scanner import edgar_catalyst as ec  # noqa: E402
from wt.scanner.catalyst import spec_score  # noqa: E402


def sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def sessions(data: Path, start: dt.date, end: dt.date) -> list[dt.date]:
    """Regular sessions from 30 days before `start` to `end`, from Alpaca's calendar, cached."""
    cache = data / "edgar" / "sessions.json"
    have = json.loads(cache.read_text()) if cache.exists() else []
    lo, hi = (start - dt.timedelta(days=30)).isoformat(), end.isoformat()
    if not have or have[0] > lo or have[-1] < hi:
        from wt.data.alpaca import AlpacaREST
        cal = AlpacaREST(per_minute=60, shared=True).calendar(min(lo, have[0] if have else lo),
                                                              max(hi, have[-1] if have else hi))
        have = sorted({d.isoformat() for d in cal["date"]} | set(have))
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps(have))
    return [dt.date.fromisoformat(d) for d in have]


def context(data: Path) -> ec.Context:
    edgar = data / "edgar"
    missing = ec.NEEDED_FORMS - ee.built_forms(edgar / "events.parquet")
    if missing:
        raise SystemExit(f"events.parquet was built without {sorted(missing)}: rebuild it "
                         "(scripts/build_edgar_events.py --parts events_parts_v2)")
    ev = pd.read_parquet(edgar / "events.parquet", columns=["cik", "form", "items", "accepted_at_et", "accession"])
    ev = ev[ev.form.isin(ec.NEEDED_FORMS)]
    by_cik = {int(c): g.reset_index(drop=True) for c, g in ev.groupby("cik")}
    tm = pd.read_parquet(edgar / "ticker_cik.parquet")
    dup = tm.ticker[tm.ticker.duplicated(keep=False)]
    tm = tm[~tm.ticker.isin(set(dup))]           # a ticker mapped to two CIKs is not a map: it reads as unmapped
    years = pd.read_parquet(edgar / "cik_form_years.parquet")
    filed = {int(c): frozenset(int(y) for y in g.year) for c, g in years.groupby("cik")}
    meta = pd.read_parquet(edgar / "cik_meta.parquet")
    names: dict[int, tuple[str, ...]] = {}
    for r in meta.itertuples():
        former = json.loads(r.former_names) if isinstance(r.former_names, str) and r.former_names else []
        names[int(r.cik)] = (str(r.entity or ""), *(str(f.get("name") or "") for f in former))
    assets = pd.read_parquet(data / "daily" / "assets.parquet", columns=["symbol", "name"])
    return ec.Context(by_cik, dict(zip(tm.ticker.astype(str), tm.cik.astype(int), strict=True)), filed,
                      dict(zip(assets.symbol.astype(str), assets.name.fillna("").astype(str), strict=True)), names,
                      spec_score("earnings_release"))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("start", type=dt.date.fromisoformat)
    ap.add_argument("end", type=dt.date.fromisoformat)
    ap.add_argument("--data", type=Path, default=DATA_DIR)
    a = ap.parse_args(argv)
    pools = sorted(p for p in (a.data / "candidates").glob("*.parquet")
                   if a.start.isoformat() <= p.stem <= a.end.isoformat())
    if not pools:
        print("annotate: no pool in the range")
        return 0
    cal = sessions(a.data, a.start, a.end)
    ctx = context(a.data)
    roles = RoleCache(a.data / "edgar" / "roles.json")
    out_dir = a.data / "candidates_edgar"
    out_dir.mkdir(parents=True, exist_ok=True)
    before = {p: sha(p) for p in pools}
    tally: dict[str, int] = {}
    for p in pools:
        d = dt.date.fromisoformat(p.stem)
        earlier = [s for s in cal if s < d]
        if d not in cal or not earlier:
            print(f"{d}: not a session in the calendar, or no session before it; skipped")
            continue
        pool = pd.read_parquet(p, columns=["symbol"])
        side = ec.annotate(pool.symbol, d, earlier[-1], ctx, roles.is_subject)
        tmp = out_dir / f".{p.name}.tmp{os.getpid()}"
        side.to_parquet(tmp, index=False)
        os.replace(tmp, out_dir / p.name)
        tally["name_days"] = tally.get("name_days", 0) + len(side)
        for why in side.edgar_reason[side.edgar_category == "unknown"]:
            tally[f"unknown_{why}"] = tally.get(f"unknown_{why}", 0) + 1
    roles.save()
    changed = [p.name for p in pools if sha(p) != before[p]]
    if changed:
        print(f"annotate: POOL FILES CHANGED: {changed}")
        return 1
    print(f"annotate: {len(pools)} pool days, {dict(sorted(tally.items()))}, "
          f"index pages fetched {roles.fetched}, unreadable {roles.unreadable}; pools unchanged")
    return 0


if __name__ == "__main__":
    sys.exit(main())
