"""SPEC-0001 governance: the spec validates, every requirement points at a real spec key, MUST rules are mapped
to code and tests, generated configs and requirements.md never drift from the spec.
Set WT_SPEC_STRICT=1 (final verification) to also fail on MUST rules still 'planned'."""
import csv
import importlib
import os
import sys
from pathlib import Path

import pytest
import yaml

from wt.core.config import ROOT
from wt.specs import loader

SPEC = "SPEC-0001"
LEVELS = {"MUST", "SHOULD", "INFO"}
STATUSES = {"planned", "implemented", "proxy", "needs_data", "n_a"}


def _rows():
    with open(loader.spec_dir(SPEC) / "traceability.csv", newline="") as f:
        return list(csv.DictReader(f))


def _resolve_function(dotted: str) -> bool:
    if dotted.startswith("scripts."):
        return (ROOT / "scripts" / (dotted.split(".", 1)[1] + ".py")).exists()
    parts = dotted.split(".")
    for i in range(len(parts), 0, -1):
        try:
            obj = importlib.import_module(".".join(parts[:i]))
        except ModuleNotFoundError:
            continue
        for attr in parts[i:]:
            if not hasattr(obj, attr):
                return False
            obj = getattr(obj, attr)
        return True
    return False


def test_spec_validates_and_weights_sum_to_one():
    spec = loader.load_spec(SPEC)
    assert spec["spec_id"] == SPEC
    assert abs(sum(spec["funnel"]["weights"].values()) - 1.0) < 1e-9


def test_rows_well_formed_and_unique():
    rs = _rows()
    ids = [r["req_id"] for r in rs]
    assert len(ids) == len(set(ids)), "duplicate requirement ids"
    for r in rs:
        assert None not in r and len(r) == 11, r["req_id"]
        assert r["level"] in LEVELS and r["status"] in STATUSES, r["req_id"]


def test_every_spec_key_resolves():
    spec = loader.load_spec(SPEC)
    missing = []
    for r in _rows():
        if r["spec_key"]:
            try:
                loader.get(spec, r["spec_key"])
            except KeyError:
                missing.append((r["req_id"], r["spec_key"]))
    assert not missing, missing


def test_must_rules_are_mapped():
    unmapped = [r["req_id"] for r in _rows()
                if r["level"] == "MUST" and r["status"] not in ("n_a", "needs_data") and not (r["function"] and r["test"])]
    assert not unmapped, unmapped


def test_implemented_rows_point_at_real_code_and_tests():
    sys.path.insert(0, str(ROOT / "src"))
    broken = []
    for r in _rows():
        if r["status"] in ("implemented", "proxy"):
            if not _resolve_function(r["function"]):
                broken.append((r["req_id"], "function", r["function"]))
            if not (ROOT / r["test"]).exists():
                broken.append((r["req_id"], "test", r["test"]))
    assert not broken, broken


@pytest.mark.skipif(os.environ.get("WT_SPEC_STRICT") != "1", reason="strict completeness only at final verification")
def test_strict_no_planned_musts():
    planned = [r["req_id"] for r in _rows() if r["level"] == "MUST" and r["status"] == "planned"]
    assert not planned, planned


def test_generated_configs_match_spec():
    assert loader.drift(SPEC) == []


def test_generated_configs_round_trip():
    spec = loader.load_spec(SPEC)
    for name, text in loader.render_generated(SPEC).items():
        body = yaml.safe_load(text)
        for section, value in body.items():
            if section in spec and section != "scanners":
                assert value == spec[section], (name, section)


def test_requirements_md_up_to_date():
    sys.path.insert(0, str(ROOT / "scripts"))
    import spec_docs
    target = loader.spec_dir(SPEC) / "requirements.md"
    assert target.read_text() == spec_docs.render(SPEC)
