"""EXP-0015a step 2: score the classifier against the labels.

Reference labels, in order of precedence:
    owner verdicts (owner_review.csv) > owner blind labels (owner_blind_labels.csv) > Claude labels.
Reports:
  * headline-level accuracy (exact category)
  * decision-level accuracy, the level the scanner uses: qualifying / excluded / non-qualifying
  * a confusion matrix
  * Claude-vs-owner agreement on the owner's blind items, which measures how far Claude's labels can be
    trusted where the owner didn't review
Writes report.md and disagreements.csv (the owner review queue).
The classifier is run LIVE with the current config/catalysts_spec.yaml; outputs carry its version.
Usage: PYTHONPATH=src .venv/bin/python scripts/exp0015a_catalyst_score.py [--prefix sample2_]
"""
from __future__ import annotations

import csv
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from wt.core.config import ROOT  # noqa: E402
from wt.scanner.catalyst import EXCLUDED, QUALIFYING, _spec_cfg, classify_spec  # noqa: E402

EXP = ROOT / "research" / "experiments" / "EXP-0015a-catalyst-accuracy"
TARGET = 0.85


def decision(cat: str) -> str:
    return "qualifying" if cat in QUALIFYING else "excluded" if cat in EXCLUDED else "non_qualifying"


def read(name: str, key: str, val: str) -> dict[str, str]:
    p = EXP / name
    if not p.exists():
        return {}
    with open(p, newline="") as f:
        return {r[key]: r[val] for r in csv.DictReader(f) if r.get(val)}


def main(prefix: str = "") -> dict:
    ver = _spec_cfg()["version"]
    with open(EXP / f"{prefix}sample_blind.csv", newline="") as f:
        items = {r["item_id"]: r for r in csv.DictReader(f)}
    clf = {i: classify_spec(r["headline"]) for i, r in items.items()}
    with open(EXP / f"{prefix}sample_key_v{ver}.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["item_id", "classifier_category"])
        w.writerows(sorted(clf.items()))
    claude = read(f"{prefix}claude_labels.csv", "item_id", "claude_label")
    owner_blind = read(f"{prefix}owner_blind_labels.csv", "item_id", "owner_label")
    owner_review = read(f"{prefix}owner_review.csv", "item_id", "owner_verdict")
    ref, src = {}, {}
    for i in items:
        for name, d in (("owner_review", owner_review), ("owner_blind", owner_blind), ("claude", claude)):
            if i in d:
                ref[i], src[i] = d[i], name
                break
    n = len(ref)
    exact = sum(clf[i] == ref[i] for i in ref) / n
    dec = sum(decision(clf[i]) == decision(ref[i]) for i in ref) / n
    both = [i for i in owner_blind]
    claude_vs_owner = (sum(claude[i] == owner_blind[i] for i in both) / len(both)) if both else None
    conf = Counter((ref[i], clf[i]) for i in ref)
    cats = sorted({c for pair in conf for c in pair})
    dis = [i for i in sorted(items) if clf[i] != claude.get(i)]
    with open(EXP / f"{prefix}disagreements_v{ver}.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["item_id", "symbol", "headline", "classifier_category", "claude_label", "claude_note"])
        notes = read(f"{prefix}claude_labels.csv", "item_id", "note")
        for i in dis:
            w.writerow([i, items[i]["symbol"], items[i]["headline"], clf[i], claude[i], notes.get(i, "")])
    lines = [f"# EXP-0015a — Catalyst classifier accuracy: classifier v{ver} on {prefix.rstrip('_') or 'sample1'}", "",
             f"- **Sample:** {n} dev-span headlines (see `{prefix}manifest.json`).",
             f"- **Reference labels:** " + ", ".join(f"{k} {v}" for k, v in Counter(src.values()).items()) + ".",
             f"- **Headline-level exact accuracy:** **{exact:.0%}**.",
             f"- **Decision-level accuracy** (qualifying / excluded / non-qualifying, which is what the scanner uses): **{dec:.0%}**. Target ≥ {TARGET:.0%}: "
             f"**{'PASS' if dec >= TARGET else 'FAIL'}**.",
             f"- **Claude vs owner on the owner's blind items:** " + (f"{claude_vs_owner:.0%} ({len(both)} items)" if both else "pending (owner blind labels not yet in)") + ".",
             f"- **Classifier vs Claude disagreements:** {len(dis)} (the owner review queue: `{prefix}disagreements_v{ver}.csv`).", "",
             "## Confusion matrix (rows = reference label, columns = classifier)", "",
             "| reference \\ classifier | " + " | ".join(cats) + " |", "|---|" + "---|" * len(cats)]
    for r in cats:
        lines.append(f"| {r} | " + " | ".join(str(conf.get((r, c), "")) for c in cats) + " |")
    (EXP / f"{prefix}report_v{ver}.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines[:9]))
    return {"exact": exact, "decision": dec, "n_disagree": len(dis)}


if __name__ == "__main__":
    main(sys.argv[sys.argv.index("--prefix") + 1] if "--prefix" in sys.argv else "")
