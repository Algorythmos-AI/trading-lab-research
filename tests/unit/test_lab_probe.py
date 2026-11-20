"""The lab's tier rules, focus reader and one-off probe (DEC-0060, EXP-0041). Synthetic answers only; no network."""
from __future__ import annotations

import datetime as dt
import json
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import pytest
import yaml

from wt.data.feeds import FeedNotNamed, require_feed
from wt.lab import focus, probe, tiers

ROOT = Path(__file__).resolve().parents[2]
CAL = ("2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20", "2026-11-23", "2026-11-24",
       "2026-11-25", "2026-11-27", "2026-11-30")
TODAY = dt.date(2026, 11, 18)
DESK = {"SPY", "QQQ", "NVDA", "AMD", "AAA", "BBB"}


# ---------------------------------------------------------------- tiers
def test_the_tier_rules_are_the_ones_exp_0041_froze() -> None:
    cfg = yaml.safe_load((ROOT / "research/experiments/EXP-0052-lab-execution-truth-v2/config.yaml").read_text())   # DEC-0067 replaced EXP-0041
    t1, t2 = cfg["recording"]["tier1"], cfg["recording"]["tier2"]
    r = tiers.RULES
    assert (r.t1_max_sessions, r.t1_strike_pct, r.t1_max_ask, r.t1_max_per_name) == (
        t1["max_sessions_to_expiry"], t1["strike_within_pct_of_stock_mid"], t1["max_ask"], t1["max_contracts_per_name"])
    assert (r.t2_max_days, r.t2_strike_pct) == (t2["max_calendar_days_to_expiry"], t2["strike_within_pct_of_stock_mid"])
    assert probe.PASS == dict(cfg["probe"]["pass"])


def test_sessions_to_expiry_counts_regular_sessions_with_today_zero() -> None:
    assert tiers.sessions_to_expiry(TODAY, TODAY, CAL) == 0
    assert tiers.sessions_to_expiry(TODAY, dt.date(2026, 11, 25), CAL) == 5
    assert tiers.sessions_to_expiry(TODAY, dt.date(2026, 11, 27), CAL) == 6          # Thanksgiving is not counted
    assert tiers.sessions_to_expiry(TODAY, dt.date(2026, 11, 26), CAL) is None       # not a session
    assert tiers.sessions_to_expiry(TODAY, dt.date(2026, 11, 17), CAL) is None       # in the past


@pytest.mark.parametrize(("symbol", "ask", "want"), [
    ("SPY261118C00680000", 1.20, 1),     # same day, at the money, cheap
    ("SPY261125P00660000", 2.90, 1),     # 5 sessions, 2.9% away
    ("SPY261125P00655000", 0.80, 2),     # 3.7% away: tier 2
    ("SPY261127C00680000", 1.00, 2),     # 6 sessions out: tier 2
    ("SPY261118C00680000", 3.05, 2),     # ask over $3.00: tier 2
    ("SPY261118C00680000", None, 2),     # no ask: tier 2
    ("SPY261118C00680000", 0.0, 2),      # zero ask: tier 2
    ("SPY261203C00680000", 1.00, None),  # 15 calendar days: not recorded
    ("SPY261118C00740000", 0.05, None),  # 8.8% away: not recorded
    ("SPY261117C00680000", 1.00, None),  # expired
    ("SPY1261118C00680000", 1.00, None), # adjusted root: never recorded
])
def test_a_contract_falls_in_one_tier_by_the_frozen_rules(symbol: str, ask: float | None, want: int | None) -> None:
    assert tiers.tier(symbol, ask, 680.0, TODAY, cal=CAL) == want


def test_tier_one_is_capped_at_the_nearest_strikes() -> None:
    cands = [(f"SPY261118C00{k:03d}000", float(k)) for k in range(400, 1000)]
    kept = tiers.cap_tier1(cands, 680.4)
    assert len(kept) == 300 == tiers.RULES.t1_max_per_name                     # DEC-0067 point 4
    assert kept[0] == "SPY261118C00680000" and "SPY261118C00400000" not in kept and "SPY261118C00999000" not in kept


# ---------------------------------------------------------------- the focus reader
def test_the_lab_signs_the_focus_request_as_the_clone_does() -> None:
    from wt.options import clone_site
    assert focus.FOCUS_PATH == clone_site.FOCUS_PATH
    assert focus.signature("s3cret", 1_700_000_000) == clone_site.focus_signature("s3cret", 1_700_000_000)


class Resp:
    def __init__(self, body: Any, status: int = 200) -> None:
        self.body, self.status_code = body, status

    def json(self) -> Any:
        return self.body


FOCUS_ENV = {"DASHBOARD_INGEST_URL": "https://x.test/api/ingest", "DASHBOARD_INGEST_SECRET": "s"}


def test_the_focus_reader_keeps_symbols_only_and_hashes_the_answer() -> None:
    body = {"session": "2026-11-19", "items": [{"symbol": "NVDA", "rank": 1, "bias": "long"},
                                               {"symbol": "bad symbol"}, {"symbol": "NVDA"}, {"symbol": "AMD"}]}
    f = focus.read(FOCUS_ENV, get=lambda *a, **k: Resp(body), now=lambda: 1.0)
    assert f is not None and f.session == "2026-11-19" and f.names == ("NVDA", "AMD") and len(f.sha256) == 64
    assert focus.read({}, get=lambda *a, **k: Resp(body)) is None
    assert focus.read(FOCUS_ENV, get=lambda *a, **k: Resp(body, 401)) is None
    assert focus.read(FOCUS_ENV, get=lambda *a, **k: Resp({"session": "x", "items": []})) is None


# ---------------------------------------------------------------- which names may be probed
F = focus.Focus("2026-11-19", ("NVDA", "AMD", "ZZZZ"), "0" * 64)


def test_the_session_is_today_before_the_close_and_the_next_one_after() -> None:
    assert probe.probe_session(TODAY, False, CAL) == "2026-11-18"
    assert probe.probe_session(TODAY, True, CAL) == "2026-11-19"
    assert probe.probe_session(dt.date(2026, 11, 21), False, CAL) == "2026-11-23"       # a Saturday


def test_only_the_editions_desk_focus_names_are_probed_and_names_may_only_narrow_them() -> None:
    assert probe.choose_names(F, None, "2026-11-19", DESK) == (["NVDA", "AMD"], None)    # ZZZZ is not a desk name
    assert probe.choose_names(F, ["AMD"], "2026-11-19", DESK) == (["AMD"], None)
    assert probe.choose_names(F, ["SPY"], "2026-11-19", DESK)[1] == "--names may only narrow the focus list"
    assert probe.choose_names(None, None, "2026-11-19", DESK)[1] == "no focus list"
    assert probe.choose_names(F, None, "2026-11-18", DESK)[1] == "the focus list is not for the session being probed"
    assert probe.choose_names(focus.Focus("2026-11-19", ("ZZZZ",), "0" * 64), None, "2026-11-19", DESK)[1] is not None


# ---------------------------------------------------------------- the probe itself
class Fake:
    """A synthetic Alpaca: records every request; answers from tables; never sees a real key."""

    def __init__(self, limit: str = "10000", chain_status: int = 200, stock_status: int = 200,
                 header_case: str = "X-RateLimit-Limit") -> None:
        self.calls: list[tuple[str, dict[str, str], str]] = []
        self.limit, self.chain_status, self.stock_status, self.case = limit, chain_status, stock_status, header_case

    def __call__(self, url: str, params: Mapping[str, str], headers: Mapping[str, str], timeout: float) -> probe.Answer:
        require_feed(url, params)
        self.calls.append((url, dict(params), headers.get("APCA-API-KEY-ID", "")))
        h = {self.case: self.limit, "x-ratelimit-remaining": "9990"}
        if url.endswith("/v2/stocks/snapshots"):
            if self.stock_status != 200:
                return probe.Answer(self.stock_status, h, {"message": "forbidden"}, 0.05)
            return probe.Answer(200, h, {s: {"latestQuote": {"bp": 99.9, "ap": 100.1}}
                                         for s in params["symbols"].split(",")}, 0.05)
        if "/v1beta1/options/snapshots/" in url:
            root = url.rsplit("/", 1)[1]
            if params.get("limit") == "1000" and "page_token" not in params:
                snaps = {f"{root}261119C00{k:03d}000": {"latestQuote": {"ap": 1.0, "bp": 0.9}} for k in range(95, 106)}
                return probe.Answer(self.chain_status, h, {"snapshots": snaps, "next_page_token": "p2"}, 0.2)
            if params.get("page_token") == "p2":
                snaps = {f"{root}261130P00{k:03d}000": {"latestQuote": {"ap": 0.5, "bp": 0.4}} for k in range(95, 101)}
                return probe.Answer(200, h, {"snapshots": snaps}, 0.2)
            return probe.Answer(200, h, {"snapshots": {}}, 0.1)
        if url.endswith("/v1beta1/options/snapshots"):
            return probe.Answer(200, h, {"snapshots": {s: {} for s in params["symbols"].split(",")}}, 0.3)
        return probe.Answer(404, {}, None, 0.0)


ENV = {"APCA_CLONE_KEY_ID": "kc", "APCA_CLONE_SECRET_KEY": "sc", "APCA_API_KEY_ID": "ka", "APCA_API_SECRET_KEY": "sa"}
NOW = dt.datetime(2026, 11, 18, 22, 0, tzinfo=dt.UTC)
DAY = dt.date(2026, 11, 19)


def run(fake: Fake, free: float = 23.0, day: dt.date = DAY, names: list[str] | None = None) -> dict[str, Any]:
    return probe.run(fake, ENV, ["AAA", "BBB"] if names is None else names, day, NOW, free, CAL)


def test_the_probe_counts_tiers_and_passes_on_a_good_answer() -> None:
    out = run(Fake())
    assert out["pair_used"] == "APCA_CLONE" and out["pairs"]["APCA_OPTIONS"] == {"present": False}
    assert out["pairs"]["APCA_CLONE"]["rate_limit"] == 10000
    n = out["per_name"]["name_1"]
    assert (n["chain_pages"], n["in_range"], n["tier1"], n["tier2"]) == (2, 17, 7, 10)   # 97-103 calls; the rest
    assert out["tier1_total"] == 14 and out["tier1_sweep"]["requests"] == 1 and out["tier1_sweep"]["failed"] == 0
    assert all(out["pass"].values()) and out["passed"] is True


def test_the_rate_limit_header_is_read_whatever_its_case() -> None:
    assert run(Fake(header_case="x-ratelimit-limit"))["pairs"]["APCA_CLONE"]["rate_limit"] == 10000
    assert run(Fake(header_case="X-Ratelimit-Limit"))["pairs"]["APCA_CLONE"]["rate_limit"] == 10000


def test_every_request_names_its_feed_and_the_chain_asks_for_a_range() -> None:
    fake = Fake()
    run(fake)
    for url, params, _ in fake.calls:
        assert params.get("feed") in ("opra", "sip"), url
    first = next(p for u, p, _ in fake.calls if u.endswith("/snapshots/AAA") and p.get("limit") == "1000")
    assert first["expiration_date_gte"] == "2026-11-19" and first["expiration_date_lte"] == "2026-12-03"
    assert first["strike_price_gte"] == "92.00" and first["strike_price_lte"] == "108.00"


def test_the_feed_guard_refuses_a_request_without_a_feed() -> None:
    with pytest.raises(FeedNotNamed):
        Fake()("https://data.alpaca.markets/v1beta1/options/snapshots/SPY", {"limit": "1"}, {}, 1.0)


@pytest.mark.parametrize(("kw", "failed"), [
    ({"fake": Fake(limit="200")}, "rate_limit"),
    ({"fake": Fake(), "free": 12.0}, "free_disk"),
    ({"fake": Fake(chain_status=403)}, "every_name_measured"),
    ({"fake": Fake(stock_status=429)}, "every_name_measured"),
    ({"fake": Fake(), "day": dt.date(2026, 11, 21)}, "session_known"),
])
def test_a_probe_that_measured_too_little_or_found_too_little_fails(kw: dict[str, Any], failed: str) -> None:
    out = run(**kw)
    assert out["pass"][failed] is False and out["passed"] is False


def test_a_failed_stock_answer_is_recorded_not_raised() -> None:
    out = run(Fake(stock_status=403))
    assert out["stock_status"] == 403 and out["per_name"]["name_1"] == {"stock_quote": False}
    assert out["tier1_sweep"]["requests"] == 0 and out["pass"]["tier1_sweep"] is False


def test_no_key_and_no_name_reach_the_result() -> None:
    text = json.dumps(run(Fake()))
    for word in ('"kc"', '"sc"', '"ka"', '"sa"', "AAA", "BBB", "rank", "score"):
        assert word not in text


def test_no_pair_reaching_opra_or_no_name_writes_a_failed_result() -> None:
    out = probe.run(Fake(), {}, ["AAA"], DAY, NOW, 30.0, CAL)
    assert out["pair_used"] is None and out["passed"] is False and out["per_name"] == {}
    assert run(Fake(), names=[])["passed"] is False


def test_main_refuses_without_a_focus_list_and_writes_why(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tiers, "sessions", lambda path=None: CAL)
    monkeypatch.setattr(focus, "read", lambda env=None, get=None, now=None: None)
    out = tmp_path / "probe.json"
    assert probe.main(["--out", str(out)], get=Fake(), now=NOW) == 1
    assert json.loads(out.read_text())["refused"] == "no focus list"


def test_main_probes_the_focus_names_for_the_next_session_after_the_close(tmp_path: Path,
                                                                          monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tiers, "sessions", lambda path=None: CAL)
    monkeypatch.setattr(focus, "read", lambda env=None, get=None, now=None: focus.Focus("2026-11-19", ("NVDA",), "0" * 64))
    monkeypatch.setattr(probe, "desk_names", lambda path=None: DESK)
    monkeypatch.setattr("os.environ", {**ENV})
    monkeypatch.setattr(probe.shutil, "disk_usage", lambda path: type("U", (), {"free": 40e9})())
    out = tmp_path / "probe.json"
    assert probe.main(["--out", str(out)], get=Fake(), now=NOW) == 0          # 17:00 New York: the next session
    doc = json.loads(out.read_text())
    assert doc["session"] == "2026-11-19" and doc["names"] == 1 and doc["passed"] is True and "NVDA" not in out.read_text()


def test_exp0052_counting_rules_are_all_parsed_as_rules() -> None:
    """EXP-0041's YAML folded two counting conditions into another value's text; EXP-0052's are each a list item, and
    each names a manifest field the recorder writes."""
    cfg = yaml.safe_load((ROOT / "research/experiments/EXP-0052-lab-execution-truth-v2/config.yaml").read_text())
    rules = cfg["counting"]["session_counts_when"]
    assert len(rules) == 7 and all(isinstance(r, str) for r in rules)
    assert isinstance(cfg["counting"]["expected_samples"], str) and "\n-" not in cfg["counting"]["expected_samples"]
    for field in ("coverage_fresh_strict", "longest_stale_s", "clock_offset_ms", "clock_offset_ms_end",
                  "tier1_crossed_share", "ticks_down"):
        assert any(field in r for r in rules), field
    assert cfg["recording"]["tier1"]["max_contracts_per_name"] == 300 and cfg["replaces"] == "EXP-0041"
