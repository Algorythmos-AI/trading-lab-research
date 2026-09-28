"""Specification-of-record loader (research/specs/SPEC-NNNN-*/spec.yaml).

The spec is the single source of truth for scanner, pattern, entry, exit and risk parameters. Runtime
configs under config/generated/ are GENERATED from it, so code never reads a hand-edited number:
    python -m wt.specs.loader SPEC-0001 --write   # regenerate configs
    python -m wt.specs.loader SPEC-0001 --check   # exit 1 if configs drifted from the spec
"""
from __future__ import annotations

import hashlib
import json
import sys
from functools import lru_cache
from pathlib import Path

import jsonschema
import yaml

from wt.core.config import CONFIG_DIR, ROOT

SPECS_DIR = ROOT / "research" / "specs"
GENERATED_DIR = CONFIG_DIR / "generated"

# generated config name -> spec sections it carries
GENERATED = {
    "ranking_warrior.yaml": ["candidate_pool", "funnel", "former_runner", "chart_filters", "patterns",
                             "entries", "execution", "exits", "risk"],
    "hod_scanner.yaml": ["scanners"],
    "reversal_scanner.yaml": ["scanners"],
}
_SCANNER_OF = {"ranking_warrior.yaml": "pre_market_gap", "hod_scanner.yaml": "high_of_day",
               "reversal_scanner.yaml": "reversal_hybrid"}


def spec_dir(spec_id: str) -> Path:
    hits = sorted(SPECS_DIR.glob(f"{spec_id}-*"))
    if len(hits) != 1:
        raise FileNotFoundError(f"expected exactly one directory for {spec_id} under {SPECS_DIR}, found {len(hits)}")
    return hits[0]


@lru_cache(maxsize=4)
def load_spec(spec_id: str = "SPEC-0001") -> dict:
    """Load and schema-validate a spec. Raises jsonschema.ValidationError on any violation."""
    d = spec_dir(spec_id)
    spec = yaml.safe_load((d / "spec.yaml").read_text())
    schema = json.loads((d / "schema.json").read_text())
    jsonschema.Draft7Validator(schema).validate(spec)
    w = spec["funnel"]["weights"]
    if abs(sum(w.values()) - 1.0) > 1e-9:
        raise ValueError(f"{spec_id}: funnel weights sum to {sum(w.values())}, expected 1.0")
    return spec


def spec_sha256(spec_id: str = "SPEC-0001") -> str:
    return hashlib.sha256((spec_dir(spec_id) / "spec.yaml").read_bytes()).hexdigest()


def get(spec: dict, dotted: str):
    """Resolve a dotted key (segments may contain '-', e.g. 'entries.MP-1.target'). KeyError if absent."""
    node = spec
    for part in dotted.split("."):
        if not isinstance(node, dict) or part not in node:
            raise KeyError(dotted)
        node = node[part]
    return node


def render_generated(spec_id: str = "SPEC-0001") -> dict[str, str]:
    spec = load_spec(spec_id)
    header = (f"# GENERATED from {spec_id} v{spec['version']} (spec.yaml sha256 {spec_sha256(spec_id)[:16]}).\n"
              f"# Do not edit. Change research/specs/{spec_dir(spec_id).name}/spec.yaml and run\n"
              f"#   PYTHONPATH=src .venv/bin/python -m wt.specs.loader {spec_id} --write\n")
    out = {}
    for name, sections in GENERATED.items():
        body = {"spec_id": spec_id, "spec_version": spec["version"]}
        for s in sections:
            body[s] = spec[s] if s != "scanners" else {_SCANNER_OF[name]: spec["scanners"][_SCANNER_OF[name]]}
        if name == "ranking_warrior.yaml":
            body["scanner"] = spec["scanners"]["pre_market_gap"]
        out[name] = header + yaml.safe_dump(body, sort_keys=True, width=120)
    return out


def write_generated(spec_id: str = "SPEC-0001") -> list[Path]:
    GENERATED_DIR.mkdir(parents=True, exist_ok=True)
    paths = []
    for name, text in render_generated(spec_id).items():
        p = GENERATED_DIR / name
        p.write_text(text)
        paths.append(p)
    return paths


def drift(spec_id: str = "SPEC-0001") -> list[str]:
    """Names of generated configs that are missing or differ from what the spec renders."""
    bad = []
    for name, text in render_generated(spec_id).items():
        p = GENERATED_DIR / name
        if not p.exists() or p.read_text() != text:
            bad.append(name)
    return bad


def load_generated(name: str) -> dict:
    return yaml.safe_load((GENERATED_DIR / name).read_text())


if __name__ == "__main__":
    sid = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("--") else "SPEC-0001"
    if "--write" in sys.argv:
        for p in write_generated(sid):
            print("wrote", p.relative_to(ROOT))
    elif "--check" in sys.argv:
        d = drift(sid)
        print("OK: generated configs match spec" if not d else f"DRIFT: {d}")
        sys.exit(1 if d else 0)
    else:
        s = load_spec(sid)
        print(f"{sid} v{s['version']} ({s['status']}) valid; sha256 {spec_sha256(sid)[:16]}")
