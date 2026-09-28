"""Render research/specs/SPEC-NNNN-*/requirements.md from traceability.csv (the single structured source).
Usage: PYTHONPATH=src .venv/bin/python scripts/spec_docs.py SPEC-0001 [--check]"""
from __future__ import annotations

import csv
import sys
from collections import Counter, OrderedDict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from wt.specs.loader import load_spec, spec_dir, spec_sha256  # noqa: E402

AREAS = OrderedDict([("pool", "Candidate pool"), ("scanner", "Scanners"), ("catalyst", "Catalyst classification"),
                     ("funnel", "Selection funnel"), ("chart", "Daily and pre-market chart filters"),
                     ("pattern", "Patterns"), ("entry", "Entries"), ("execution", "Execution musts"),
                     ("exit", "Exits"), ("risk", "Risk"), ("tape", "Tape and Level 1 (descriptive)"),
                     ("routine", "Pre-market routine (forward dry run)"), ("evaluation", "Evaluation")])


def rows(spec_id: str) -> list[dict]:
    with open(spec_dir(spec_id) / "traceability.csv", newline="") as f:
        return list(csv.DictReader(f))


def render(spec_id: str) -> str:
    spec, rs = load_spec(spec_id), rows(spec_id)
    lv, st = Counter(r["level"] for r in rs), Counter(r["status"] for r in rs)
    out = [f"# {spec_id} — Requirements", "",
           f"_Generated from `traceability.csv` for spec v{spec['version']} ({spec['status']}); "
           f"spec.yaml sha256 `{spec_sha256(spec_id)[:16]}`. Do not edit by hand: run `scripts/spec_docs.py {spec_id}`._", "",
           f"**{len(rs)} requirements:** " + ", ".join(f"{k} {v}" for k, v in sorted(lv.items())) +
           ". **Status:** " + ", ".join(f"{k} {v}" for k, v in sorted(st.items())) + ".", "",
           "Levels:",
           "- **MUST:** a hard rule, enforced by code and tested",
           "- **SHOULD:** used for scoring or ordering",
           "- **INFO:** recorded, or out of scope", "",
           "Statuses:",
           "- `planned`: not built yet",
           "- `implemented`: code plus test",
           "- `proxy`: implemented through an approximation",
           "- `needs_data` and `n_a`: see `not_implementable` in spec.yaml", ""]
    for area, title in AREAS.items():
        sub = [r for r in rs if r["area"] == area]
        if not sub:
            continue
        out += [f"## {title}", "", "| ID | Level | Requirement | Operational definition | Source | Status |", "|---|---|---|---|---|---|"]
        for r in sub:
            cells = [f"`{r['req_id']}`", r["level"], r["statement"], r["operational_definition"], r["source"], r["status"]]
            out.append("| " + " | ".join(c.replace("|", "\\|") for c in cells) + " |")
        out.append("")
    return "\n".join(out)


if __name__ == "__main__":
    sid = next((a for a in sys.argv[1:] if not a.startswith("--")), "SPEC-0001")
    target = spec_dir(sid) / "requirements.md"
    text = render(sid)
    if "--check" in sys.argv:
        ok = target.exists() and target.read_text() == text
        print("OK: requirements.md up to date" if ok else "DRIFT: requirements.md is stale")
        sys.exit(0 if ok else 1)
    target.write_text(text)
    print("wrote", target)
