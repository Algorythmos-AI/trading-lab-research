"""Pre-market routine (RTN-01..07): no broker code, stage times, ticket construction from a read-only account."""
import math
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
import premarket_routine as pr  # noqa: E402

from wt.specs.loader import load_spec  # noqa: E402


def test_routine_never_loads_broker_code():
    """Checked in a fresh interpreter: importing the routine must not pull in any broker/OMS/order code."""
    import subprocess
    root = Path(__file__).resolve().parents[2]
    code = ("import sys; sys.path[:0]=['src','scripts']; import premarket_routine; "
            "print([m for m in sys.modules if m.startswith(('wt.brokers','wt.oms','alpaca.trading'))])")
    out = subprocess.run([sys.executable, "-c", code], cwd=root, capture_output=True, text=True, timeout=120)
    assert out.returncode == 0, out.stderr
    assert out.stdout.strip() == "[]", out.stdout


def test_stage_times_and_snapshot_windows():
    assert [s for s, _ in pr.STAGES] == ["08:00", "08:30", "09:00", "09:15"]
    assert pr.minus("08:00", 25) == "07:35" and pr.minus("09:15", 25) == "08:50"


def test_no_candidates_means_no_tickets_not_a_crash():
    """2026-10-01: an empty pool has no `symbol` column, and the tickets stage died three times on set_index."""
    empty = {"tier1": [], "tier2": [], "primary": None, "dropped": []}
    assert pr.tickets(pd.DataFrame(), empty, load_spec("SPEC-0001")) == []
    assert pr.tickets(pd.DataFrame([{"symbol": "AAA", "pm_high": 5.0}]), empty, load_spec("SPEC-0001")) == []


def test_tickets_use_lowest_level_and_cap(tmp_path, monkeypatch):
    monkeypatch.setattr(pr, "VA_PATH", tmp_path / "missing.json")          # default US$600 account, never written
    pool = pd.DataFrame([{"symbol": "AAA", "pm_pattern_trigger": 5.10, "pm_pattern_stop": 5.02, "pm_high": 5.40},
                         {"symbol": "BBB", "pm_pattern_trigger": math.nan, "pm_pattern_stop": math.nan, "pm_high": 3.00}])
    f = {"tier2": [{"symbol": "AAA", "primary": True}, {"symbol": "BBB", "primary": False}]}
    t = {x["symbol"]: x for x in pr.tickets(pool, f, load_spec("SPEC-0001"))}
    assert t["AAA"]["trigger"] == 5.11 and t["AAA"]["stop"] == 5.01 and t["AAA"]["target_2R"] == 5.31
    assert t["BBB"]["trigger"] == 3.01 and t["BBB"]["stop"] == 2.81                        # no pattern: PMH, 20c cap
    assert t["AAA"]["qty"] == 60 and t["AAA"]["risk_usd"] <= 6.0 + 1e-9                     # 1% of US$600
    assert not (tmp_path / "missing.json").exists()


def pool_row(sym, **kw):
    base = dict(symbol=sym, price_0925=5.0, gap_pct=25.0, pm_volume=300_000.0, rvol_pm=6.0, float_shares=8e6,
                catalyst_status="qualifying", catalyst_category="fda_approval", catalyst_score=1.0, former_runner=False,
                chart_ok=True, pm_pattern=None, trend_ok=True, window_ok=True, pm_consolidation=True, suspect_split=False,
                hist_bars=260)
    return {**base, **kw}


def test_a_stage_records_why_each_kept_name_went_no_further():
    spec = load_spec("SPEC-0001")
    pool = pd.DataFrame([pool_row("OK", pm_pattern="flag"), pool_row("THIN", rvol_pm=1.0),
                         pool_row("NEW", chart_ok=False, trend_ok=False, hist_bars=30),
                         pool_row("BUY", catalyst_status="excluded", catalyst_category="buyout_offer")])
    counts, rows = pr.funnel_record(pool, spec)
    assert {k: counts[k] for k in ("n_kept", "n_passed", "n_tier1", "n_chart_ok", "n_tier2", "n_primary")} == {
        "n_kept": 4, "n_passed": 2, "n_tier1": 2, "n_chart_ok": 1, "n_tier2": 1, "n_primary": 1}
    assert counts["drop_rvol"] == counts["sole_rvol"] == 1 and counts["drop_catalyst_excluded"] == 1
    assert counts["chart_history"] == 1 and counts["band2_20_kept"] == 4
    assert all(type(v) is int for v in counts.values()) and not any("buyout" in k for k in counts)
    assert {r["symbol"]: (r["reached"], r["reasons"]) for r in rows} == {
        "OK": ("primary", []), "THIN": ("kept", ["rvol"]), "NEW": ("tier1", ["chart:history"]),
        "BUY": ("kept", ["catalyst_excluded:buyout_offer"])}
    f = pr.funnel(pr.spec_cands(pool), spec)                                  # the record describes the same funnel run
    assert [x["symbol"] for x in f["tier2"]] == ["OK"] and f["primary"] == "OK"


def test_the_record_never_costs_a_stage(monkeypatch):
    assert pr.funnel_record(pd.DataFrame(), load_spec("SPEC-0001")) == ({}, [])
    monkeypatch.setattr(pr, "explain", lambda *a, **k: 1 / 0)
    assert pr.funnel_record(pd.DataFrame([pool_row("OK")]), load_spec("SPEC-0001")) == ({"explain_error": 1}, [])
