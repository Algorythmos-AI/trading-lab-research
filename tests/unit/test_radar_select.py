"""Radar → Options selection (DEC-0070, PROPOSED): the candidate record, the universe gate, and a whole run end to end
with a fake broker. No network: tmp_path and fixtures only."""
from __future__ import annotations

import copy
import datetime as dt
import json
from pathlib import Path
from typing import Any

import pytest

from wt.options import chain as ch
from wt.options import levels as lv
from wt.options import radar_candidates as rc
from wt.options import radar_select as rs
from wt.options import select as sel
from wt.options import select_fetch as sf
from wt.options import universe as un

ROOT = Path(__file__).resolve().parents[2]
S = "2026-11-23"                     # a Monday: the session being selected for
D = "2026-11-20"                     # the Friday before: the finished session Stage 1 scores
RUN_AT = dt.datetime(2026, 11, 23, 11, 45, tzinfo=dt.UTC)        # 06:45 New York
DESK = ["SPY", "QQQ", "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "PLTR", "AVGO", "AMD"]
P, PSHA = sel.load_params()
REF = "rs-test"

CFG_RAW: dict[str, Any] = {
    "version": 1,
    "radar": {"lists_in_scope": ["DAILY RADAR", "MEGA CAP OPTIONS", "BREAKOUT WATCH"], "max_candidates_in": 60,
              "prices_max_age_minutes": 240, "aliases": {"GOOG": "GOOGL"}},
    "gate": {"max_additions": 8, "price_min": 10.0, "median_dollar_volume_min": 50_000_000.0,
             "chain_expiry_max_days": 7, "chain_ntm_strikes_min": 4, "chain_ntm_pct": 0.05,
             "chain_volume_min": 1000.0, "chain_spread_max_pct": 0.15},
    "list_priority": ["DAILY RADAR", "MEGA CAP OPTIONS", "BREAKOUT WATCH"],
}
CFG = rc.config_from_mapping(CFG_RAW)


def cfg_with(**gate: Any) -> rc.Config:
    raw = copy.deepcopy(CFG_RAW)
    raw["gate"].update(gate)
    return rc.config_from_mapping(raw)


def edition(**over: Any) -> dict[str, Any]:
    doc: dict[str, Any] = {
        "schema": "stocksdelta/radar", "run_id": "r-1", "as_of": "2026-11-23T10:51:00Z", "edition_date": S,
        "prices_as_of": "2026-11-23T10:45:00Z",
        "lists": [
            {"name": "DAILY RADAR", "symbols": ["XYZ", "nvda", "TINY"]},
            {"name": "MEGA CAP OPTIONS", "symbols": ["GOOG", "MSFT", "ABC"]},
            {"name": "BREAKOUT WATCH", "symbols": ["NEWCO", "brk-b", "XYZ"]},
            {"name": "SMALL CAP MOMENTUM", "symbols": ["SMOL"]},
            {"name": "SUPPORT PLAYS", "symbols": ["XYZ", "SUPP"]},
            {"name": "DAILY  RADAR v2", "symbols": ["RENAMED"]},
        ],
        "tickers": [
            {"symbol": "XYZ", "evidence_grade": 3, "chart_grade": 2, "why": "secret prose", "tag": "new"},
            {"symbol": "ABC", "evidence_grade": 2},
        ],
        "calendar": [{"date": S, "label": "ABC earnings before the open", "kind": "earnings"},
                     {"date": S, "label": "CPI", "kind": "macro"}],
    }
    doc.update(over)
    return doc


# ---------------------------------------------------------------- candidates

def test_candidates_take_in_scope_lists_only_normalised_and_without_prose():
    rec = rc.extract(edition(), S, RUN_AT, DESK, CFG)
    assert rec["status"] == "ok"
    syms = [c["symbol"] for c in rec["candidates"]]
    assert syms == sorted(syms)
    assert set(syms) == {"XYZ", "NVDA", "TINY", "GOOGL", "MSFT", "ABC", "NEWCO", "BRK.B"}
    assert "SMOL" not in syms and "SUPP" not in syms and "RENAMED" not in syms
    assert rec["counts"]["unknown_lists"] == 3            # two stock lists and a renamed one: counted, never passed
    xyz = next(c for c in rec["candidates"] if c["symbol"] == "XYZ")
    assert xyz["lists"] == ["DAILY RADAR", "BREAKOUT WATCH"] and xyz["evidence_grade"] == 3 and not xyz["core"]
    assert next(c for c in rec["candidates"] if c["symbol"] == "GOOGL")["core"]
    assert next(c for c in rec["candidates"] if c["symbol"] == "ABC")["calendar_earnings"] == [S]
    text = json.dumps(rec)
    for prose in ("secret prose", "before the open", "CPI"):
        assert prose not in text
    assert rec["provenance"]["edition_sha256"] == rc.edition_sha(edition())


@pytest.mark.parametrize("over, status", [
    ({"edition_date": "2026-11-20"}, "radar_stale"),
    ({"as_of": "2026-11-20T20:00:00Z"}, "radar_stale"),            # before Friday's close
    ({"as_of": "2026-11-23T12:00:00Z"}, "radar_stale"),            # after the run
    ({"as_of": None}, "radar_stale"),
    ({"prices_as_of": "2026-11-23T05:00:00Z"}, "radar_stale"),     # older than 240 minutes
    ({"prices_as_of": None}, "radar_stale"),
    ({"schema": "stocksdelta/options"}, "radar_invalid"),
    ({"lists": "nope"}, "radar_invalid"),
    ({"lists": [{"name": "DAILY RADAR", "symbols": [f"A{chr(65 + i // 26)}{chr(65 + i % 26)}" for i in range(61)]}]},
     "radar_invalid"),
])
def test_a_stale_or_invalid_edition_gives_no_candidates(over, status):
    rec = rc.extract(edition(**over), S, RUN_AT, DESK, CFG)
    assert rec["status"] == status and rec["candidates"] == [] and rec["detail"]


def test_a_missing_edition_is_said_so():
    rec = rc.extract(None, S, RUN_AT, DESK, CFG)
    assert rec["status"] == "radar_missing" and rec["candidates"] == []


def test_malformed_symbols_are_counted_not_passed():
    ed = edition(lists=[{"name": "DAILY RADAR", "symbols": ["XYZ", "TOOLONG", "1ABC", 5, ""]}])
    rec = rc.extract(ed, S, RUN_AT, DESK, CFG)
    assert [c["symbol"] for c in rec["candidates"]] == ["XYZ"]
    assert rec["counts"]["rejected"] == {"malformed_symbol": 4}


@pytest.mark.parametrize("raw, want", [("brk-b", "BRK.B"), ("BRK/B", "BRK.B"), (" goog ", "GOOGL"), ("A", "A"),
                                       ("ABCDEF", None), ("BRK.BB", None), (None, None)])
def test_normalise(raw, want):
    assert rc.normalise(raw, {"GOOG": "GOOGL"}) == want


def test_the_config_refuses_what_it_does_not_implement():
    for bad in ({**CFG_RAW, "extra": 1},
                {**CFG_RAW, "list_priority": ["DAILY RADAR"]},
                {**CFG_RAW, "radar": {**CFG_RAW["radar"], "aliases": {"GOOG": "GOOGL", "GOOGL": "X"}}},
                {**CFG_RAW, "gate": {**CFG_RAW["gate"], "chain_ntm_pct": 5}}):
        with pytest.raises(rc.ConfigError):
            rc.config_from_mapping(bad)


def test_the_repo_config_loads_with_every_threshold_unset():
    cfg = rc.load_config()
    assert set(cfg.unset()) == set(rc.GATE_THRESHOLDS)
    with pytest.raises(rc.ConfigError):
        cfg.require_thresholds()


# ---------------------------------------------------------------- the gate

def sessions(end: str, n: int) -> list[str]:
    out: list[str] = []
    d = end
    while len(out) < n:
        if lv.is_session(d):
            out.append(d)
        d = (dt.date.fromisoformat(d) - dt.timedelta(days=1)).isoformat()
    return out[::-1]


def bars(close: float = 100.0, vol: float = 1_000_000.0, n: int = 260, end: str = D,
         drift: float = 0.0) -> list[dict[str, Any]]:
    out = []
    for i, d in enumerate(sessions(end, n)):
        c = round(close * (1 + drift * (i - n + 1) / n), 4)
        out.append({"d": d, "o": c, "h": c + 1.0, "l": c - 1.0, "c": c, "v": vol})
    return out


def quote(strike: float, side: str = "C", expiry: str = "261127", bid: float = 1.0, ask: float = 1.1,
          vol: float = 500.0, root: str = "XYZ") -> ch.Quote:
    c = ch.parse_occ(f"{root}{expiry}{side}{int(strike * 1000):08d}")
    assert c is not None
    return ch.Quote(c, bid, ask, None, None, None, vol)


GOOD_CHAIN = [quote(k, s) for k in (48.0, 49.0, 50.0, 51.0, 52.0) for s in "CP"]


def er(sym: str, date: str, when: str = "amc") -> dict[str, str]:
    return {"symbol": sym, "date": date, "when": when, "source": "synthetic", "quality": "confirmed"}


def cand(symbol: str, lists: list[str] | None = None, grade: int | None = None,
         reports: list[str] | None = None) -> dict[str, Any]:
    return {"symbol": symbol, "lists": lists or ["DAILY RADAR"], "evidence_grade": grade, "chart_grade": None,
            "risk_tag": False, "avoid": False, "core": symbol in DESK, "calendar_earnings": reports or []}


def cands(*cs: dict[str, Any], status: str = "ok") -> dict[str, Any]:
    return {"session": S, "status": status, "candidates": list(cs)}


def facts(**kw: Any) -> un.ChainFacts:
    base = {"expiry": "2026-11-27", "ntm_contracts": 10, "ntm_volume": 5000.0, "ntm_spread_pct": 0.09}
    base.update(kw)
    return un.ChainFacts(**base)


def gate1(c: dict[str, Any], b: Any = None, f: Any = "good", rows: list[Any] | None = None,
          cfg: rc.Config = CFG) -> dict[str, Any]:
    chains = {} if f is None else {c["symbol"]: facts() if f == "good" else f}
    if f == "none":
        chains = {c["symbol"]: None}
    return un.gate(cands(c), DESK, {c["symbol"]: bars(50.0, 5_000_000.0) if b is None else b}, chains,
                   rows if rows is not None else [er(c["symbol"], "2027-01-28")], P, cfg)


def verdict(rec: dict[str, Any], sym: str) -> str | None:
    return next(v["reject"] for v in rec["verdicts"] if v["symbol"] == sym)


def test_a_good_radar_name_joins_the_twelve():
    rec = gate1(cand("XYZ"))
    assert rec["names"] == DESK + ["XYZ"] and rec["origin"]["XYZ"] == "radar" and verdict(rec, "XYZ") is None


@pytest.mark.parametrize("b, f, rows, code", [
    (bars(50.0, 5e6, n=100), "good", None, "bars_short_history"),
    (bars(50.0, 5e6, end="2026-11-19"), "good", None, "bars_stale_bar"),
    ([], "good", None, "bars_stale_bar"),
    (bars(5.0, 5e8), "good", None, "price_low"),
    (bars(50.0, 100_000.0), "good", None, "dollar_volume_low"),
    (None, "none", None, "chain_unavailable"),
    (None, facts(expiry=None, ntm_contracts=0, ntm_volume=0.0, ntm_spread_pct=None), None, "chain_no_expiry"),
    (None, facts(ntm_contracts=2), None, "chain_thin"),
    (None, facts(ntm_volume=10.0), None, "chain_volume_low"),
    (None, facts(ntm_spread_pct=0.4), None, "chain_spread_wide"),
    (None, facts(ntm_spread_pct=None), None, "chain_spread_wide"),
    (None, "good", [], "earnings_unknown"),                         # no row at all: fail closed
    (None, "good", [er("XYZ", "2026-05-01")], "earnings_unknown"),  # last report long ago, next not known
])
def test_each_gate_check_fails_closed(b, f, rows, code):
    rec = gate1(cand("XYZ"), b=b, f=f, rows=rows)
    assert verdict(rec, "XYZ") == code and rec["names"] == DESK


def test_a_missing_chain_entry_is_unavailable_too():
    rec = gate1(cand("XYZ"), f=None)
    assert verdict(rec, "XYZ") == "chain_unavailable"


def test_a_recent_report_admits_and_a_radar_calendar_report_rejects():
    assert verdict(gate1(cand("XYZ"), rows=[er("XYZ", "2026-11-04")]), "XYZ") is None
    assert verdict(gate1(cand("XYZ", reports=[S])), "XYZ") == "earnings_in_radar_calendar"
    assert verdict(gate1(cand("XYZ", reports=["2026-12-10"])), "XYZ") is None


def test_only_the_frozen_index_names_skip_the_earnings_check():
    # options_select.yaml index_names is SPY and QQQ (both on the desk). Any other fund the Radar names has no row and
    # is rejected: fail closed, until a dated amendment says otherwise.
    assert P.index_names == ("SPY", "QQQ")
    assert verdict(gate1(cand("IWM"), rows=[]), "IWM") == "earnings_unknown"


def test_desk_names_never_pass_through_the_gate():
    rec = un.gate(cands(cand("NVDA"), cand("MSFT")), DESK, {}, {}, [], P, CFG)
    assert rec["names"] == DESK and rec["verdicts"] == [] and rec["radar_on_desk"] == ["MSFT", "NVDA"]


def test_the_cap_keeps_list_priority_then_grade_then_symbol():
    names = [f"N{chr(65 + i)}" for i in range(6)]
    cs = [cand("NA", ["BREAKOUT WATCH"], 3), cand("NB", ["DAILY RADAR"], 1), cand("NC", ["DAILY RADAR"], 2),
          cand("ND", ["MEGA CAP OPTIONS"], 3), cand("NE", ["DAILY RADAR"], 2), cand("NF", ["MEGA CAP OPTIONS"])]
    b = {n: bars(50.0, 5e6) for n in names}
    rows = [er(n, "2027-01-28") for n in names]
    rec = un.gate(cands(*cs), DESK, b, {n: facts() for n in names}, rows, P, cfg_with(max_additions=3))
    assert rec["names"][12:] == ["NC", "NE", "NB"]
    assert {verdict(rec, n) for n in ("NA", "ND", "NF")} == {"over_cap"}


def test_an_unset_gate_admits_nothing_and_says_so():
    rec = gate1(cand("XYZ"), cfg=cfg_with(price_min=None))
    assert verdict(rec, "XYZ") == "gate_unset" and rec["names"] == DESK and rec["gate_unset"] == ["price_min"]


def test_a_radar_failure_gives_the_twelve():
    rec = un.gate(cands(cand("XYZ"), status="radar_stale"), DESK, {}, {}, [], P, CFG)
    assert rec["names"] == DESK and rec["radar_status"] == "radar_stale" and rec["verdicts"] == []


def test_chain_facts_from_snapshots():
    f = un.chain_facts(GOOD_CHAIN + [quote(60.0), quote(50.0, expiry="261204")], 50.0, S, CFG)
    assert f.expiry == "2026-11-27" and f.ntm_contracts == 10 and f.ntm_volume == 5000.0
    assert f.ntm_spread_pct == pytest.approx(0.1 / 1.05)
    assert un.chain_facts([], 50.0, S, CFG).expiry is None
    assert un.chain_facts([quote(50.0, expiry="261231")], 50.0, S, CFG).expiry is None     # past the 7 days


# ---------------------------------------------------------------- a whole run with a fake broker

class Resp:
    def __init__(self, body: Any) -> None:
        self.status_code, self.headers, self._body = 200, {"X-RateLimit-Limit": "10000"}, body

    def json(self) -> Any:
        return self._body


class Broker:
    """Answers the Stage 1 bars request from `daily`; counts requests."""

    def __init__(self, daily: dict[str, list[dict[str, Any]]]) -> None:
        self.daily, self.calls = daily, []

    def get_response(self, url: str, params: dict[str, Any] | None = None, **_: Any) -> Resp:
        self.calls.append((url, dict(params or {})))
        assert url.endswith("/v2/stocks/bars") and params and params["feed"] == "sip"
        out = {}
        for s in params["symbols"].split(","):
            if s in self.daily:
                out[s] = [{"t": f"{r['d']}T05:00:00Z", **{k: r[k] for k in "ohlcv"}} for r in self.daily[s]]
        return Resp({"bars": out, "next_page_token": None})


def world() -> tuple[Broker, dict[str, Any]]:
    daily = {n: bars(100.0 + i, 2e6, drift=0.02 * (i % 5)) for i, n in enumerate(DESK)}
    daily["XYZ"] = bars(50.0, 5e6, drift=0.3)          # a strong mover the desk list does not hold
    daily["TINY"] = bars(2.0, 5e6)
    daily["NEWCO"] = bars(40.0, 5e6, n=80)
    daily["ABC"] = bars(80.0, 5e6)
    return Broker(daily), daily


def chain_reader(sym: str, close: float, session: str) -> list[ch.Quote] | None:
    if sym in ("XYZ", "ABC"):
        return [quote(round(close * k, 2), s, root=sym) for k in (0.97, 0.99, 1.0, 1.01, 1.03) for s in "CP"]
    if sym == "BRK.B":
        return None
    return []


def do_run(read: Any = lambda: edition(), cfg: rc.Config = CFG, rows: list[Any] | None = None,
           at: dt.datetime = RUN_AT) -> dict[str, dict[str, Any]]:
    broker, _ = world()
    return rs.run(S, now=at, read_radar=read, client=broker, desk=DESK, cfg=cfg, params=P, params_sha=PSHA,
                  picker_ref=REF, earnings_rows=rows if rows is not None else [er("XYZ", "2027-01-28"),
                                                                               er("ABC", "2027-01-28")],
                  macro_rows=[], chain_reader=chain_reader, clock=lambda: at, sleep=lambda s: None)


def test_a_radar_name_reaches_stage1_and_is_ranked_by_the_frozen_rules():
    rec = do_run()
    uni, out, run = rec["universe.json"], rec["stage1.json"], rec["run.json"]
    assert uni["names"] == DESK + ["XYZ"]
    assert {v["symbol"]: v["reject"] for v in uni["verdicts"]} == {
        "XYZ": None, "TINY": "price_low", "NEWCO": "bars_short_history", "ABC": "earnings_in_radar_calendar",
        "BRK.B": "bars_stale_bar"}
    assert out["session"] == D and out["next_session"] == S and out["params_sha"] == PSHA
    xyz = next(r for r in out["names"] if r["symbol"] == "XYZ")
    assert xyz["data_valid"] and xyz["final_rank"] is not None          # scored and ranked beside the 12
    assert out["counts"]["names"] == 13
    assert run["mode"] == "shadow" and run["radar_status"] == "ok" and not run["late"]
    assert [p["symbol"] for p in run["picks"]] == out["picks"]
    assert all(p["origin"] in ("core", "radar") for p in run["picks"])
    assert run["hashes"]["stage1.json"] == rs.sha_of(out)


def test_stage1_scores_exactly_what_select_scores_on_the_same_bundle():
    rec = do_run()
    again = sel.run_bundle(rec["stage1-bundle.json"], P, sha=PSHA, ref=REF)
    assert rs.sha_of(again) == rs.sha_of(rec["stage1.json"])


@pytest.mark.parametrize("read, status", [(lambda: None, "radar_missing"),
                                          (lambda: edition(edition_date="2026-11-20"), "radar_stale"),
                                          (lambda: {"schema": "x"}, "radar_invalid")])
def test_a_radar_failure_falls_back_to_the_twelve_and_says_so(read, status):
    rec = do_run(read=read)
    assert rec["universe.json"]["names"] == DESK and rec["run.json"]["radar_status"] == status
    assert rec["stage1.json"]["counts"]["names"] == 12


def test_a_reader_that_raises_is_the_radar_missing():
    def boom() -> Any:
        raise TimeoutError
    rec = do_run(read=boom)
    assert rec["run.json"]["radar_status"] == "radar_missing" and "TimeoutError" in rec["run.json"]["radar_detail"]


def test_the_repo_config_shadow_run_admits_no_radar_name():
    rec = do_run(cfg=rc.load_config())
    assert rec["universe.json"]["names"] == DESK and rec["run.json"]["gate_unset"]
    assert {v["reject"] for v in rec["universe.json"]["verdicts"]} == {"gate_unset"}


def test_a_late_run_is_marked_late():
    rec = do_run(at=dt.datetime(2026, 11, 23, 13, 41, tzinfo=dt.UTC))   # 08:41 New York
    # the edition's as_of is before the run, so it is still read; the run is past 08:40
    assert rec["run.json"]["late"]


def test_too_early_before_the_finished_sessions_close():
    with pytest.raises(sf.TooEarly):
        do_run(at=dt.datetime(2026, 11, 20, 20, 0, tzinfo=dt.UTC), read=lambda: None)


def test_written_whole_once_and_replayed(tmp_path):
    rec = do_run()
    folder = rs.write_run(tmp_path, S, rec)
    assert sorted(p.name for p in folder.iterdir()) == sorted(rec)
    assert not [p for p in tmp_path.iterdir() if p.name.startswith(".")]
    with pytest.raises(FileExistsError):
        rs.write_run(tmp_path, S, rec)
    assert rs.replay(folder, DESK, CFG, P, PSHA, REF) == []
    assert rs.replay(folder, DESK, cfg_with(price_min=1.0), P, PSHA, REF) != []      # a changed gate shows
    assert rs.replay(folder, DESK, CFG, P, PSHA, "other-ref") != []                  # changed code shows
    doc = json.loads((folder / "universe.json").read_text())
    doc["names"].append("ZZZ")
    (folder / "universe.json").write_text(json.dumps(doc))
    assert "universe.json: sha256 differs from run.json" in rs.replay(folder, DESK, CFG, P, PSHA, REF)


def test_a_failed_write_leaves_nothing_behind(tmp_path, monkeypatch):
    rec = do_run()
    calls = {"n": 0}
    real = rs.s2.write_new

    def flaky(path: Path, text: str) -> None:
        calls["n"] += 1
        if calls["n"] == 3:
            raise OSError("disk full")
        real(path, text)
    monkeypatch.setattr(rs.s2, "write_new", flaky)
    with pytest.raises(OSError):
        rs.write_run(tmp_path, S, rec)
    assert list(tmp_path.iterdir()) == []


def test_records_carry_no_radar_prose():
    text = json.dumps(do_run())
    assert "secret prose" not in text and "before the open" not in text


def test_the_cli_runs_once_and_replays(tmp_path, monkeypatch, capsys):
    broker, _ = world()
    monkeypatch.setattr(rc, "load_config", lambda path=rc.CONFIG_PATH: CFG)
    monkeypatch.setattr(rs, "read_earnings", lambda: [er("XYZ", "2027-01-28"), er("ABC", "2027-01-28")])
    monkeypatch.setattr(rs, "alpaca_chain_reader", lambda *a, **k: chain_reader)
    kw = dict(client=lambda: broker, read_radar=lambda: edition(), clock=lambda: RUN_AT, sleep=lambda s: None)
    assert rs.main(["run", "--session", S, "--root", str(tmp_path)], **kw) == rs.EXIT_OK
    assert "XYZ" in json.loads((tmp_path / S / "universe.json").read_text())["names"]
    assert rs.main(["run", "--session", S, "--root", str(tmp_path)], **kw) == rs.EXIT_EXISTS
    assert rs.main(["replay", "--session", S, "--root", str(tmp_path)], **kw) == rs.EXIT_OK
    assert rs.main(["run", "--session", "2026-11-22", "--root", str(tmp_path)], **kw) == rs.EXIT_USAGE
    out = capsys.readouterr().out
    assert "admitted" in out and "reproduces" in out


def test_monday_and_after_a_holiday_score_the_right_finished_session():
    assert lv.prev_session("2026-11-23") == "2026-11-20"
    assert lv.prev_session("2026-11-27") == "2026-11-25"                   # Thanksgiving Thursday is closed
    assert rc.close_utc("2026-11-27") == dt.datetime(2026, 11, 27, 18, 0, tzinfo=dt.UTC)   # half day, 13:00 EST


def test_the_radars_own_avoid_and_risk_flags_reject():
    ed = edition(avoid=[{"symbols": "XYZ, QRS", "why": "secret avoid prose"}],
                 tickers=[{"symbol": "XYZ", "evidence_grade": 3}, {"symbol": "ABC", "tag": "risk"}])
    rec = rc.extract(ed, S, RUN_AT, DESK, CFG)
    by = {c["symbol"]: c for c in rec["candidates"]}
    assert by["XYZ"]["avoid"] and by["ABC"]["risk_tag"] and "secret avoid prose" not in json.dumps(rec)
    assert verdict(gate1(by["XYZ"]), "XYZ") == "radar_avoid"
    assert verdict(gate1(by["ABC"]), "ABC") == "radar_risk"
    legacy = {k: v for k, v in cand("XYZ").items() if k != "avoid"}      # a record without the field: fail closed
    assert verdict(gate1(legacy), "XYZ") == "radar_avoid"


def test_a_far_future_junk_earnings_row_is_not_a_known_report():
    assert verdict(gate1(cand("XYZ"), rows=[er("XYZ", "2099-01-01")]), "XYZ") == "earnings_unknown"


@pytest.mark.parametrize("over", [{"edition_date": "NVDA beats; secret text"}, {"edition_date": "20261123"},
                                  {"edition_date": 5}])
def test_a_malformed_edition_date_is_invalid_and_never_echoed(over):
    rec = rc.extract(edition(**over), S, RUN_AT, DESK, CFG)
    assert rec["status"] == "radar_invalid" and "secret" not in json.dumps(rec)


def test_run_id_is_kept_only_when_it_is_an_id():
    assert rc.extract(edition(run_id="r-1"), S, RUN_AT, DESK, CFG)["provenance"]["run_id"] == "r-1"
    assert rc.extract(edition(run_id="free text here"), S, RUN_AT, DESK, CFG)["provenance"]["run_id"] is None


def test_calendar_rows_without_kind_and_class_tickers_reject():
    ed = edition(calendar=[{"date": S, "label": "BRK.B reports"}, {"date": S, "label": "XYZ results", "kind": "macro"}])
    rep = rc.calendar_earnings(ed, CFG)
    assert rep["BRK.B"] == {S} and "XYZ" not in rep


def test_a_session_must_be_written_with_dashes():
    with pytest.raises(ValueError):
        rc.extract(edition(), "20261123", RUN_AT, DESK, CFG)


def test_the_cli_refuses_a_malformed_session(tmp_path):
    for bad in ("20261123", "2026-13-01", "nope"):
        assert rs.main(["run", "--session", bad, "--root", str(tmp_path)]) == rs.EXIT_USAGE
    assert list(tmp_path.iterdir()) == []


def test_chain_facts_count_only_the_names_own_root():
    other = [quote(k, s, root="ABC") for k in (48.0, 49.0, 50.0, 51.0, 52.0) for s in "CP"]
    assert un.chain_facts(other, 50.0, S, CFG, root="XYZ").expiry is None
    assert un.chain_facts(other + GOOD_CHAIN, 50.0, S, CFG, root="XYZ").ntm_contracts == 10


def test_one_names_crash_in_the_gate_rejects_only_that_name(monkeypatch):
    real = un._check

    def boom(c, *a, **k):
        if c["symbol"] == "BAD":
            raise ZeroDivisionError
        return real(c, *a, **k)
    monkeypatch.setattr(un, "_check", boom)
    rec = un.gate(cands(cand("BAD"), cand("XYZ")), DESK, {"BAD": bars(50.0, 5e6), "XYZ": bars(50.0, 5e6)},
                  {"BAD": facts(), "XYZ": facts()}, [er("BAD", "2027-01-28"), er("XYZ", "2027-01-28")], P, CFG)
    assert verdict(rec, "BAD") == "internal_error" and verdict(rec, "XYZ") is None


class RefusingBroker(Broker):
    """Refuses any bars request that names a non-desk symbol (as a 400 for an unknown symbol would)."""

    def get_response(self, url: str, params: dict[str, Any] | None = None, **kw: Any) -> Any:
        if params and set(params["symbols"].split(",")) - set(DESK):
            r = Resp({"message": "invalid symbol"})
            r.status_code = 400
            return r
        return super().get_response(url, params, **kw)


def test_a_refused_radar_symbol_never_costs_the_desk_its_stage1():
    _, daily = world()
    out = rs.run(S, now=RUN_AT, read_radar=lambda: edition(), client=RefusingBroker(daily), desk=DESK, cfg=CFG,
                 params=P, params_sha=PSHA, picker_ref=REF, earnings_rows=[er("XYZ", "2027-01-28")], macro_rows=[],
                 chain_reader=chain_reader, clock=lambda: RUN_AT, sleep=lambda s: None)
    assert out["universe.json"]["names"] == DESK and out["stage1.json"]["counts"]["names"] == 12
    assert out["run.json"]["radar_bars_fetch"] == "http_error"
    assert {v["reject"] for v in out["universe.json"]["verdicts"]} <= {"bars_stale_bar", "radar_avoid", "radar_risk"}


def test_replay_recomputes_and_catches_an_edited_input_with_consistent_hashes(tmp_path):
    rec = do_run()
    folder = rs.write_run(tmp_path, S, rec)
    fetch = json.loads((folder / "fetch.json").read_text())
    fetch["bars"]["XYZ"][-1]["c"] = 1.0                     # XYZ now fails the price floor
    (folder / "fetch.json").write_text(sel.dumps(fetch))
    run = json.loads((folder / "run.json").read_text())
    run["hashes"]["fetch.json"] = rs.sha_of(fetch)          # a careful hand edit: the stored hash agrees
    (folder / "run.json").write_text(sel.dumps(run))
    problems = rs.replay(folder, DESK, CFG, P, PSHA, REF)
    assert "universe.json does not reproduce" in problems


def test_replay_reads_the_saved_desk_and_names_a_desk_change(tmp_path):
    folder = rs.write_run(tmp_path, S, do_run())
    assert rs.replay(folder, DESK[:-1], CFG, P, PSHA, REF) == ["the desk's names changed since the run "
                                                                "(options_desk.yaml)"]


def test_an_unset_gate_admits_nothing_but_records_every_candidates_facts():
    """DEC-0070 section 3: the thresholds are set from status frequencies on saved data, so the shadow fetches and
    records each candidate's gate facts while they are unset; the universe and the picks stay the 12's."""
    unset = rc.load_config()
    rec = do_run(cfg=unset)
    uni = rec["universe.json"]
    assert uni["names"] == DESK and uni["version"] == un.VERSION == 2
    v = {x["symbol"]: x for x in uni["verdicts"]}
    assert {x["reject"] for x in v.values()} == {"gate_unset"}
    xyz = v["XYZ"]["facts"]
    assert xyz["validity"] == "ok" and xyz["close"] is not None and xyz["median_dollar_volume"] > 0
    assert xyz["chain"] is not None and xyz["chain"]["ntm_contracts"] > 0 and xyz["earnings_known"] is True
    assert v["NEWCO"]["facts"]["validity"] == "short_history" and v["NEWCO"]["facts"]["close"] is None
    assert v["ABC"]["facts"]["earnings_in_hold"] is True                 # the edition's calendar names its report on S
    set_rec = do_run(cfg=CFG)                                            # the same facts whether the gate is set or not
    assert {x["symbol"]: x["facts"] for x in set_rec["universe.json"]["verdicts"]} == {s: x["facts"] for s, x in v.items()}
    assert rec["run.json"]["picks"] == do_run(cfg=unset)["run.json"]["picks"]
    assert all(p["origin"] == "core" for p in rec["run.json"]["picks"])


def test_a_fact_that_cannot_be_read_is_recorded_missing_and_stops_nothing(monkeypatch):
    def broken(*a, **k):
        raise RuntimeError("boom")
    monkeypatch.setattr(un, "facts_of", broken)
    rec = do_run(cfg=rc.load_config())
    assert all(v["facts"] is None for v in rec["universe.json"]["verdicts"])
    assert rec["universe.json"]["names"] == DESK
