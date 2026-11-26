"""EXP-0057 step 4: the EDGAR proxy table, the role lookup, the annotator and the phase-1 report (fixtures only)."""
from __future__ import annotations

import datetime as dt
import hashlib
import importlib.util
import json
from pathlib import Path
from typing import Any

import pandas as pd
import pytest

from wt.data import edgar_events as ee
from wt.data.edgar_roles import RoleCache, index_url, parse_roles
from wt.research import exp0057
from wt.scanner import edgar_catalyst as ec

ROOT = Path(__file__).resolve().parents[2]
CIK, OTHER = 815094, 200406
MON, FRI = dt.date(2026, 11, 23), dt.date(2026, 11, 20)

# The two company blocks of a real index page (0001193125-22-275080, J&J's tender offer for Abiomed), trimmed.
INDEX_HTML = """
<div id="filerDiv">
  <span class="companyName">JOHNSON &amp; JOHNSON (Filed by)
 <acronym title="Central Index Key">CIK</acronym>: <a href="/cgi-bin/browse-edgar?CIK=0000200406&amp;action=getcompany">0000200406 (see all company filings)</a></span>
</div>
<div id="filerDiv">
  <span class="companyName">ABIOMED INC (Subject)
 <acronym title="Central Index Key">CIK</acronym>: <a href="/cgi-bin/browse-edgar?CIK=0000815094&amp;action=getcompany">0000815094 (see all company filings)</a></span>
</div>
"""


def et(day: dt.date, hhmm: str) -> pd.Timestamp:
    return pd.Timestamp(f"{day} {hhmm}", tz="America/New_York")


def filings(*rows: tuple[str, str, pd.Timestamp, str]) -> pd.DataFrame:
    return pd.DataFrame([{"form": f, "items": i, "accepted_at_et": t, "accession": a} for f, i, t, a in rows],
                        columns=["form", "items", "accepted_at_et", "accession"])


def no_role(acc: str, cik: int) -> bool | None:
    raise AssertionError("role asked for a form that needs none")


# ---- the window ---------------------------------------------------------------------------------------------------
def test_window_runs_from_the_previous_session_16_00_to_the_09_25_cut() -> None:
    start, end = ec.window(MON, FRI)
    assert start == et(FRI, "16:00") and end == et(MON, "09:25")
    rows = filings(("8-K", "2.02", et(FRI, "15:59"), "a"), ("8-K", "2.02", et(FRI, "16:00"), "b"),
                   ("8-K", "2.02", et(MON, "09:24"), "c"), ("8-K", "2.02", et(MON, "09:25"), "d"))
    assert ec.in_window(rows, start, end).accession.tolist() == ["b", "c"]


def test_window_across_the_november_clock_change_keeps_new_york_wall_time() -> None:
    start, end = ec.window(dt.date(2026, 11, 2), dt.date(2026, 10, 30))
    assert start.utcoffset() == dt.timedelta(hours=-4) and end.utcoffset() == dt.timedelta(hours=-5)
    with pytest.raises(ValueError):
        ec.window(FRI, MON)


# ---- the table ----------------------------------------------------------------------------------------------------
def test_a_target_only_deal_form_is_a_buyout_and_beats_earnings() -> None:
    r = ec.classify(filings(("8-K", "2.02", et(MON, "07:00"), "e"), ("SC14D9C", "", et(MON, "08:00"), "t")),
                    CIK, no_role)
    assert r.category == "buyout" and r.accessions == ("t",) and r.first_at == et(MON, "08:00")


def test_a_shared_deal_form_is_a_buyout_only_for_the_subject() -> None:
    rows = filings(("SC TO-C", "", et(MON, "07:00"), "acc1"), ("8-K", "2.02,9.01", et(MON, "07:30"), "e"))
    assert ec.classify(rows, CIK, lambda a, c: True).category == "buyout"
    acquirer = ec.classify(rows, OTHER, lambda a, c: False)
    assert acquirer.category == "earnings" and acquirer.accessions == ("e",)


def test_an_unreadable_role_is_unknown_unless_another_filing_makes_it_a_buyout() -> None:
    shared = ("425", "", et(MON, "07:00"), "x")
    assert ec.classify(filings(shared), CIK, lambda a, c: None) == ec.Reading("unknown", "role_unreadable")
    both = filings(shared, ("DEFM14A", "", et(MON, "08:00"), "p"))
    assert ec.classify(both, CIK, lambda a, c: None).category == "buyout"


@pytest.mark.parametrize("rows,category", [
    ([("424B5", "", "o"), ("8-K", "2.02", "e")], "offering"),
    ([("424B2", "", "n"), ("8-K", "7.01", "x")], "other"),            # 424B2 is not an offering here
    ([("424B3", "", "n")], "none"),
    ([("8-K", "5.02", "n")], "none"),
    ([("8-K/A", "8.01", "x")], "other"),
    ([("8-K", "2.02", "e"), ("8-K", "8.01", "x")], "earnings"),
    ([], "none"),
])
def test_the_order_of_the_table(rows: list[tuple[str, str, str]], category: str) -> None:
    df = filings(*((f, i, et(MON, "07:00"), a) for f, i, a in rows))
    assert ec.classify(df, CIK, no_role).category == category


def test_pool_columns_never_turn_unknown_into_no_headline() -> None:
    assert ec.as_pool_columns(ec.Reading("buyout"), 0.9) == {
        "catalyst_status": "excluded", "catalyst_category": "buyout_offer", "catalyst_score": -1.0, "headlines_n": 1}
    assert ec.as_pool_columns(ec.Reading("earnings"), 0.9)["catalyst_score"] == 0.9
    assert ec.as_pool_columns(ec.Reading("other"), 0.9)["headlines_n"] == 1
    assert ec.as_pool_columns(ec.Reading("none"), 0.9)["headlines_n"] == 0
    assert ec.as_pool_columns(ec.Reading("unknown", "unmapped"), 0.9)["catalyst_status"] == "unknown"


# ---- the map check ------------------------------------------------------------------------------------------------
def test_names_agree_by_subset_or_jaccard_and_ignore_suffixes() -> None:
    assert ec.names_agree("Apple Inc. Common Stock", ["Apple Inc."])
    assert ec.names_agree("Lowe's Companies, Inc.", ["LOWES COMPANIES INC"])
    assert ec.names_agree("Ares Acquisition Corp", ["Some Other Name", "ARES ACQUISITION CORP"])   # a former name
    assert not ec.names_agree("Aktis Oncology Inc", ["AAC Holdings Inc"])
    assert ec.names_agree("", ["Anything"])


def ctx(**kw: Any) -> dict[str, Any]:
    base: dict[str, Any] = dict(events_by_cik={CIK: filings(("8-K", "2.02", et(MON, "07:00"), "e"))},
                                ticker_cik={"ABMD": CIK}, filed_years={CIK: frozenset({2026})},
                                asset_names={"ABMD": "Abiomed Inc"}, edgar_names={CIK: ("ABIOMED INC",)})
    base.update(kw)
    return base


def read(**kw: Any) -> ec.Reading:
    c = ctx(**kw)
    start, end = ec.window(MON, FRI)
    return ec.read_name("ABMD", 2026, c["events_by_cik"], c["ticker_cik"], c["filed_years"], c["asset_names"],
                        c["edgar_names"], start, end, no_role)


def test_read_name_maps_checks_and_classifies() -> None:
    assert read().category == "earnings"
    assert read(ticker_cik={}) == ec.Reading("unknown", "unmapped")
    assert read(filed_years={CIK: frozenset({2019})}) == ec.Reading("unknown", "map_suspect")
    assert read(asset_names={"ABMD": "Totally Different Holdings"}) == ec.Reading("unknown", "map_suspect")
    assert read(events_by_cik={}).category == "none"


def test_annotate_gives_one_row_per_pool_name_in_order() -> None:
    c = ec.Context(**ctx(), earnings_score=0.9)
    side = ec.annotate(["ABMD", "ZZZZ"], MON, FRI, c, no_role)
    assert side.columns.tolist() == ec.SIDECAR_COLUMNS
    assert side.symbol.tolist() == ["ABMD", "ZZZZ"]
    assert side.edgar_category.tolist() == ["earnings", "unknown"] and side.edgar_reason.tolist() == ["", "unmapped"]
    assert side.edgar_first_at[0] == et(MON, "07:00").isoformat() and side.edgar_first_at[1] == ""


# ---- the role lookup ----------------------------------------------------------------------------------------------
def test_parse_roles_reads_the_real_index_page_layout() -> None:
    assert parse_roles(INDEX_HTML) == [(OTHER, "Filed by"), (CIK, "Subject")]
    assert index_url(OTHER, "0001193125-22-275080") == (
        "https://www.sec.gov/Archives/edgar/data/200406/000119312522275080/0001193125-22-275080-index.html")
    assert index_url(OTHER, "0001193125-22-275080", "htm").endswith("-index.htm")


def test_role_cache_fetches_once_and_never_caches_an_unreadable_page(tmp_path: Path) -> None:
    calls: list[str] = []
    answers = {"good": (200, INDEX_HTML), "bad": (503, "")}

    def fetch(url: str) -> tuple[int, str]:
        calls.append(url)
        return answers["good" if "0001193125-22-275080" in url else "bad"]

    rc = RoleCache(tmp_path / "roles.json", fetch)
    assert rc.is_subject("0001193125-22-275080", CIK) is True
    assert rc.is_subject("0001193125-22-275080", OTHER) is False
    assert rc.is_subject("0000000000-00-000001", CIK) is None
    assert rc.is_subject("0000000000-00-000001", CIK) is None
    assert len(calls) == 5 and rc.unreadable == 2          # one good page; the bad one tries .html and .htm, twice
    rc.save()
    again = RoleCache(tmp_path / "roles.json", fetch)
    assert again.is_subject("0001193125-22-275080", CIK) is True and len(calls) == 5


def test_role_cache_falls_back_to_the_htm_index_name(tmp_path: Path) -> None:
    def fetch(url: str) -> tuple[int, str]:
        return (200, INDEX_HTML) if url.endswith(".htm") else (404, "")

    assert RoleCache(tmp_path / "roles.json", fetch).is_subject("0001193125-22-275080", CIK) is True


# ---- the store manifest -------------------------------------------------------------------------------------------
def test_the_store_records_its_forms_and_includes_the_announcement_forms(tmp_path: Path) -> None:
    assert {"SC TO-C", "SC14D9C"} <= ee.FORMS and ec.NEEDED_FORMS <= ee.FORMS
    assert ee.built_forms(tmp_path / "events.parquet") == frozenset()
    (tmp_path / "events_meta.json").write_text(json.dumps({"forms": sorted(ee.FORMS)}))
    assert ee.built_forms(tmp_path / "events.parquet") == ee.FORMS


# ---- the phase-1 report -------------------------------------------------------------------------------------------
def test_wilson_interval_matches_the_textbook_value() -> None:
    lo, hi = exp0057.Share(16, 20).wilson() or (0.0, 0.0)
    assert round(lo, 4) == 0.5840 and round(hi, 4) == 0.9193
    assert exp0057.Share(0, 0).wilson() is None and exp0057.Share(0, 0).value is None


@pytest.mark.parametrize("b,e,verdict", [((16, 20), (20, 25), "pass"), ((15, 20), (20, 25), "fail"),
                                         ((16, 19), (20, 25), "not_decidable"), ((19, 19), (5, 5), "not_decidable")])
def test_verdict(b: tuple[int, int], e: tuple[int, int], verdict: str) -> None:
    assert exp0057.verdict(exp0057.Share(*b), exp0057.Share(*e)) == verdict


def pool_day(rows: list[tuple[str, str, str, int, str | None]]) -> pd.DataFrame:
    return pd.DataFrame(rows, columns=["symbol", "catalyst_status", "catalyst_category", "headlines_n",
                                       "first_catalyst_at"])


def side_day(rows: list[tuple[str, str, str]]) -> pd.DataFrame:
    return pd.DataFrame(rows, columns=["symbol", "edgar_category", "edgar_first_at"])


def test_measure_counts_recall_precision_presence_and_lag_and_drops_unknown() -> None:
    pool = pool_day([("A", "excluded", "buyout_offer", 2, None), ("B", "qualifying", "earnings_release", 1,
                     "2026-11-23T12:00:00Z"), ("C", "qualifying", "earnings_release", 1, "2026-11-23T12:00:00Z"),
                     ("D", "non_qualifying", "none", 0, None), ("E", "excluded", "buyout_offer", 1, None)])
    side = side_day([("A", "buyout", ""), ("B", "earnings", "2026-11-23T07:10:00-05:00"), ("C", "none", ""),
                     ("D", "other", ""), ("E", "unknown", "")])
    rep = exp0057.measure([exp0057.pair(pool, side)])
    assert rep["name_days"] == 5 and rep["unknown_name_days"] == 1 and rep["compared_name_days"] == 4
    assert (rep["buyout_recall"]["hits"], rep["buyout_recall"]["n"]) == (1, 1)
    assert (rep["earnings_recall"]["hits"], rep["earnings_recall"]["n"]) == (1, 2)
    assert rep["presence_agreement"]["hits"] == 2                    # A and B agree; C and D do not
    assert rep["median_lag_minutes"] == 10.0 and rep["lag_n"] == 1
    assert rep["verdict"] == "not_decidable"


def test_a_pool_name_without_a_sidecar_row_is_an_error() -> None:
    with pytest.raises(ValueError):
        exp0057.pair(pool_day([("A", "none", "none", 0, None)]), side_day([]))


@pytest.mark.parametrize("key", ["r", "mean_r", "pnl", "entry_price", "exit", "return", "equity_curve"])
def test_a_result_like_field_is_refused(key: str) -> None:
    with pytest.raises(ValueError):
        exp0057.check_schema({"ok": {"nested": [{key: 1}]}})


def test_the_real_report_schema_is_counts_only() -> None:
    exp0057.check_schema(exp0057.measure([]))


@pytest.mark.parametrize("text,ok", [
    ("- **Status: PROPOSED on 2026-11-26.** It is ACCEPTED by a later merge.", False),
    ("- **Status: ACCEPTED on 2026-11-27.** The owner merged it.", True),
    ("- **Status: NOT ACCEPTED on 2026-11-27.**", False),
    ("- **Status: UNACCEPTED**", False),
    ("- **Status: ACCEPTED-PENDING**", False),
    ("no status line, ACCEPTED", False),
])
def test_accepted_compares_the_status_value_exactly(text: str, ok: bool) -> None:
    assert exp0057.accepted(text) is ok


def _script(name: str) -> Any:
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / f"{name}.py")
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_the_overlap_script_counts_nothing_while_dec_0081_is_proposed(tmp_path: Path) -> None:
    mod = _script("exp0057_overlap")
    dec = tmp_path / "dec.md"
    dec.write_text("- **Status: PROPOSED on 2026-11-26.** It is ACCEPTED by a later merge.\n")
    assert mod.main(["2026-04-30", "2026-11-25", "--data", str(tmp_path), "--out", str(tmp_path / "o"),
                     "--decision", str(dec)]) == 2
    assert not (tmp_path / "o").exists()


def test_the_overlap_script_keeps_to_the_frozen_span(tmp_path: Path) -> None:
    dec = tmp_path / "dec.md"
    dec.write_text("- **Status: ACCEPTED on 2026-11-27.**\n")
    mod = _script("exp0057_overlap")
    assert mod.main(["2026-04-29", "2026-11-25", "--data", str(tmp_path), "--decision", str(dec)]) == 2


def test_the_overlap_script_runs_once_and_refuses_a_second_run(tmp_path: Path) -> None:
    dec, out = tmp_path / "dec.md", tmp_path / "o"
    dec.write_text("- **Status: ACCEPTED on 2026-11-27.**\n")
    (tmp_path / "candidates").mkdir()
    mod = _script("exp0057_overlap")
    args = ["2026-04-30", "2026-11-25", "--data", str(tmp_path), "--out", str(out), "--decision", str(dec)]
    assert mod.main(args) == 0 and (out / "phase1_report.json").exists()
    first = (out / "phase1_report.json").read_bytes()
    assert mod.main(args) == 2
    assert (out / "phase1_report.json").read_bytes() == first


# ---- the annotator end to end -------------------------------------------------------------------------------------
def _data(tmp_path: Path, forms: frozenset[str]) -> Path:
    d = tmp_path / "data"
    (d / "edgar").mkdir(parents=True)
    (d / "daily").mkdir()
    (d / "candidates").mkdir()
    ev = filings(("8-K", "2.02", et(MON, "07:00"), "e"), ("SC TO-C", "", et(MON, "08:00"), "0001193125-22-275080"))
    ev.insert(0, "cik", CIK)
    ev.to_parquet(d / "edgar" / "events.parquet", index=False)
    (d / "edgar" / "events_meta.json").write_text(json.dumps({"forms": sorted(forms)}))
    pd.DataFrame({"ticker": ["ABMD", "DUP", "DUP"], "cik": [CIK, 1, 2]}).to_parquet(d / "edgar" / "ticker_cik.parquet")
    pd.DataFrame({"cik": [CIK], "year": [2026], "form": ["8-K"], "n": [1]}).to_parquet(
        d / "edgar" / "cik_form_years.parquet")
    pd.DataFrame({"cik": [CIK], "status": ["ok"], "entity": ["ABIOMED INC"], "sec_tickers": ["ABMD"],
                  "former_names": ["[]"]}).to_parquet(d / "edgar" / "cik_meta.parquet")
    pd.DataFrame({"symbol": ["ABMD", "DUP"], "name": ["Abiomed Inc", "Dup Co"]}).to_parquet(
        d / "daily" / "assets.parquet")
    (d / "edgar" / "sessions.json").write_text(json.dumps(["2026-10-01", "2026-11-20", "2026-11-23", "2026-12-31"]))
    (d / "edgar" / "roles.json").write_text(json.dumps({"0001193125-22-275080": [[OTHER, "Filed by"],
                                                                                  [CIK, "Subject"]]}))
    pd.DataFrame({"symbol": ["ABMD", "DUP", "NOPE"], "gap_pct": [0.2, 0.3, 0.4]}).to_parquet(
        d / "candidates" / "2026-11-23.parquet")
    return d


def test_the_annotator_writes_a_sidecar_row_per_pool_name_and_leaves_pools_alone(tmp_path: Path) -> None:
    d = _data(tmp_path, ee.FORMS)
    pool = d / "candidates" / "2026-11-23.parquet"
    before = hashlib.sha256(pool.read_bytes()).hexdigest()
    mod = _script("annotate_edgar")
    assert mod.main(["2026-11-23", "2026-11-23", "--data", str(d)]) == 0
    side = pd.read_parquet(d / "candidates_edgar" / "2026-11-23.parquet")
    assert side.symbol.tolist() == ["ABMD", "DUP", "NOPE"]
    assert side.edgar_category.tolist() == ["buyout", "unknown", "unknown"]       # the cached role says Subject
    assert side.edgar_reason.tolist() == ["", "unmapped", "unmapped"]             # a ticker on two CIKs is no map
    assert hashlib.sha256(pool.read_bytes()).hexdigest() == before


def test_the_annotator_refuses_a_store_built_without_the_announcement_forms(tmp_path: Path) -> None:
    d = _data(tmp_path, ee.FORMS - {"SC TO-C", "SC14D9C"})
    with pytest.raises(SystemExit):
        _script("annotate_edgar").main(["2026-11-23", "2026-11-23", "--data", str(d)])


def test_the_secondary_reads_only_the_two_benzinga_months_once(tmp_path: Path) -> None:
    dec, out, data = tmp_path / "dec.md", tmp_path / "o", tmp_path / "d"
    dec.write_text("- **Status: ACCEPTED on 2026-11-27.**\n")
    for sub in ("candidates", "candidates_edgar"):
        (data / sub).mkdir(parents=True)
    for day in ("2018-12-19", "2025-09-25", "2025-09-26", "2026-05-01"):    # 09-26 is the holdout; 05-01 phase 1
        pool_day([("A", "qualifying", "earnings_release", 1, None)]).to_parquet(data / "candidates" / f"{day}.parquet")
        side_day([("A", "earnings", "")]).to_parquet(data / "candidates_edgar" / f"{day}.parquet")
    mod = _script("exp0057_overlap")
    args = ["--secondary", "--data", str(data), "--out", str(out), "--decision", str(dec)]
    assert mod.main(args) == 0
    rep = json.loads((out / "secondary_report.json").read_text())
    assert rep["sessions"] == 2 and rep["part_of_pass"] is False and not (out / "phase1_report.json").exists()
    assert mod.main(args) == 2
    assert mod.main(["2018-12-01", "2018-12-31", *args]) == 2
