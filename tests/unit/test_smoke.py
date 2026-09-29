"""Smoke checks `make deploy` runs against the live venv after a pull. Fast, offline, no data files."""
from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest

pytestmark = pytest.mark.smoke

SCRIPTS = Path(__file__).resolve().parents[2] / "scripts"


@pytest.mark.parametrize("module", ["wt.live.runner_b", "wt.oms.manager", "wt.brokers.alpaca_paper", "wt.ops.jobs",
                                    "wt.ops.deploy", "wt.ops.status", "wt.risk.virtual_account"])
def test_trading_and_ops_modules_import(module):
    importlib.import_module(module)


@pytest.mark.parametrize("script", ["forward_test", "premarket_routine", "weekly_scorecard"])
def test_nightly_scripts_import(script):
    sys.path.insert(0, str(SCRIPTS))
    try:
        importlib.import_module(script)
    finally:
        sys.path.remove(str(SCRIPTS))


def test_every_job_has_a_known_command():
    from wt.ops.schedule import JOBS
    for job in JOBS.values():
        cmd = job.command
        assert cmd[0] == "-c" or (SCRIPTS.parent / cmd[0]).exists(), job.name
