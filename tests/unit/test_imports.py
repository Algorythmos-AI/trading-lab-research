"""Modules under src/wt import as the `wt` package (every entry point sets PYTHONPATH=src; tests via conftest), so
none of them may edit sys.path: a module that does can shadow the package with whatever sits next to it."""
import importlib
import re
from pathlib import Path

import pytest

SRC = Path(__file__).resolve().parents[2] / "src" / "wt"


def test_no_module_under_src_edits_sys_path():
    bad = [str(p.relative_to(SRC)) for p in SRC.rglob("*.py") if re.search(r"sys\.path\.(insert|append)", p.read_text())]
    assert bad == []


@pytest.mark.parametrize("module", ["wt.data.universe", "wt.data.edgar", "wt.data.etf_minutes", "wt.knowledge.merge",
                                    "wt.knowledge.digest", "wt.knowledge.mine", "wt.knowledge.aggregate",
                                    "wt.knowledge.funnel_reports", "wt.knowledge.inventory", "wt.knowledge.batches"])
def test_former_sys_path_modules_import(module):
    importlib.import_module(module)
