import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent / "unit"))   # shared helpers (spec_bars.py)

import pytest  # noqa: E402


@pytest.fixture(autouse=True)
def _deterministic_host(monkeypatch):
    """Host-dependent code (wt.ops.host) must not change with the machine running the tests: default to the Mac's
    launchd unless a test sets WT_HOST itself. Health-check pings stay off unless a test configures them."""
    monkeypatch.setenv("WT_HOST", "launchd")
    monkeypatch.delenv("HC_PING_KEY", raising=False)
    monkeypatch.delenv("WT_ENV_FILE", raising=False)
