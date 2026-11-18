"""The Robot B page's evidence file (scripts/robot_b_evidence.py, DEC-0061 section 4): equal to a fresh build from
EXP-0042, and SAFE data only."""
from __future__ import annotations

import importlib.util
import json
import re
from pathlib import Path

ROOT = Path(__file__).parents[2]
FILE = ROOT / "dashboard/src/lib/robot-b-evidence.json"
DENY_KEYS = {"headlines", "review_url", "subject", "statement", "setup", "catalyst_headline", "catalyst_category"}


def _load():
    spec = importlib.util.spec_from_file_location("robot_b_evidence", ROOT / "scripts/robot_b_evidence.py")
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_committed_file_equals_a_fresh_build():
    mod = _load()
    assert FILE.read_text() == mod.dump(mod.build())


def _keys(o, out):
    if isinstance(o, dict):
        for k, v in o.items():
            out.add(k)
            _keys(v, out)
    elif isinstance(o, list):
        for v in o:
            _keys(v, out)
    return out


def test_numbers_and_ids_only():
    data = json.loads(FILE.read_text())
    assert not (_keys(data, set()) & DENY_KEYS)
    text = json.dumps(data)
    assert "|" not in text                                  # no configuration name such as B|QQQ|noise|M3
    for word in ("noise", "range_low", "atr10", "vwap", "band"):
        assert word not in text.lower()
    strings = re.findall(r'"([^"]*)"', text)
    assert max(len(s) for s in strings) <= 64               # ids, statuses, dates, hashes: never a sentence


def test_results_hash_points_at_the_committed_results():
    import hashlib
    data = json.loads(FILE.read_text())
    raw = (ROOT / "research/experiments/EXP-0042-b-audit-diagnostics/results.json").read_bytes()
    assert data["source"]["results_sha256"] == hashlib.sha256(raw).hexdigest()
