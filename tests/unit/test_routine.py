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
