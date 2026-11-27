"""EXP-0058 step 2: the owner review queue, then the verdict, once (DEC-0082 points 4 to 6 and 8).

Order of work, which this script enforces:
  1. The agent labeller fills `agent_labels.csv` for all 100 items from `sample_blind.csv` alone, and the owner fills
     `owner_label` in `owner_blind.csv` for the 30, without seeing any other label.
  2. A first run, once both files are complete and valid, locks them (a digest of each file's sorted (item_id, label)
     pairs goes into `labels_lock.json`; a later change to a label is refused, a re-saved file is not) and writes `owner_review.csv`: every item where v3 and the best label so far
     (owner blind, else agent) disagree at the decision level, with both readings and an empty owner_verdict.
  3. The owner fills every owner_verdict.
  4. `--final` writes `report.json` and `report.md` to the public folder, once. It refuses while a ruling is missing.

Every run checks that the sample files match the sha256 sums in the public manifest and that v3, re-run on each
headline, still gives the key's category. Prints counts only.

Usage: PYTHONPATH=src .venv/bin/python scripts/exp0058_score.py [--final] [--publish]
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from wt.core.config import CONFIG_DIR, ROOT  # noqa: E402
from wt.data import news_archive as na  # noqa: E402
from wt.research import exp0058 as x  # noqa: E402
from wt.scanner.catalyst import classify_spec  # noqa: E402

PUBLIC = ROOT / "research" / "experiments" / "EXP-0058-v3-on-fiscal"
PRIVATE_IN_REPO = "experiments/EXP-0058"
PRIVATE = na.CLONE / PRIVATE_IN_REPO
CLASSIFIER = CONFIG_DIR / "catalysts_spec.yaml"      # the file classify_spec loads
LOCKED = ("agent_labels.csv", "owner_blind.csv")


def _read(path: Path) -> list[dict[str, str]]:
    if not path.exists():
        return []
    with open(path, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def _labels(rows: list[dict[str, str]], col: str) -> dict[str, str]:
    return {r["item_id"]: r[col].strip() for r in rows if (r.get(col) or "").strip()}


def _pct(s: dict[str, Any]) -> str:
    if not s["n"]:
        return "n/a (0 items)"
    lo, hi = s["wilson95"]
    return f"{s['share']:.1%} ({s['hits']}/{s['n']}; Wilson 95% {lo:.1%} to {hi:.1%})"


def markdown(rep: dict[str, Any]) -> str:
    who = rep["owner_slots_filled_by"]
    lines = [
        "# EXP-0058 report: classifier v3 on fiscal.ai headlines", "",
        f"- **Verdict:** **{rep['verdict']}** (DEC-0082 point 6: pass at >= {x.TARGET:.0%} on >= {x.MIN_LABELLED} "
        f"labelled items, with the labeller check >= {x.LABELLER_MIN:.0%}).",
        f"- **Decision-level agreement (the figure):** {_pct(rep['decision_level'])}.",
        f"- **Owner slots (blind labels and rulings) filled by:** {who}.",
        f"- **Labeller check (agent vs {who}, the {x.OWNER_BLIND} owner-blind items):** {_pct(rep['labeller_check'])}.",
        f"- **v3 vs {who} alone (the same items):** {_pct(rep['v3_vs_owner_slot'])}.",
        "- **Reference labels:** " + ", ".join(f"{k} {v}" for k, v in sorted(rep["reference_sources"].items())) + ".",
        "", "Reported only:", "",
        f"- exact-category agreement: {_pct(rep['exact_category'])};",
        "- population-weighted decision-level agreement: "
        + (f"{rep['population_weighted_decision_level']:.1%}" if rep["population_weighted_decision_level"] is not None
           else "n/a") + ";",
        "- confusion counts (reference label, v3 category, n):", "",
        "| reference | v3 | n |", "|---|---|---|",
        *[f"| {c['reference']} | {c['v3']} | {c['n']} |" for c in rep["confusion"]],
        "", "Benzinga reference: EXP-0015a, 84% at the decision level (CAT-01 target 85%).",
    ]
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--private", type=Path, default=PRIVATE)
    ap.add_argument("--public", type=Path, default=PUBLIC)
    ap.add_argument("--final", action="store_true", help="write the public report, once")
    ap.add_argument("--publish", action="store_true", help="commit the private folder to the private repository")
    a = ap.parse_args(argv)

    try:
        x.check_classifier(CLASSIFIER)
    except x.Refused as e:
        print(f"EXP-0058: {e}")
        return 2
    mpath = a.public / "sample_manifest.json"
    if not mpath.exists():
        print("EXP-0058: no sample manifest; draw the sample first")
        return 2
    manifest = json.loads(mpath.read_text())
    for f in ("sample_blind.csv", "sample_key.csv"):
        if x.sha256(a.private / f) != manifest["private_sha256"][f]:
            print(f"EXP-0058: {f} does not match the manifest's sha256; the sample was changed")
            return 2
    blind = {r["item_id"]: r for r in _read(a.private / "sample_blind.csv")}
    key = {r["item_id"]: r["v3_category"] for r in _read(a.private / "sample_key.csv")}
    drift = [i for i, r in blind.items() if classify_spec(r["headline"]) != key.get(i)]
    if drift or set(blind) != set(key):
        print(f"EXP-0058: v3 no longer gives the key's category on {len(drift)} items; refused")
        return 2

    slots = a.private / "owner_slots.json"      # who filled the owner's slots (DEC-0082 owner note 2026-11-27)
    filled_by = str(json.loads(slots.read_text()).get("filled_by", "")).strip() if slots.exists() else ""
    if not filled_by:
        print('EXP-0058: owner_slots.json must say who filled the owner slots ({"filled_by": "owner"} if he did); '
              "nothing scored")
        return 2
    agent = _labels(_read(a.private / "agent_labels.csv"), "agent_label")
    owner_ids = list(manifest["owner_blind_ids"])
    owner_blind = _labels(_read(a.private / "owner_blind.csv"), "owner_label")
    if len(agent) < len(blind) or len(owner_blind) < len(owner_ids):
        print(f"EXP-0058: labels not complete (agent {len(agent)}/{len(blind)}, "
              f"owner blind {len(owner_blind)}/{len(owner_ids)}); nothing is scored before both are in")
        return 2
    review_path = a.private / "owner_review.csv"
    review_rows = _read(review_path)
    review = _labels(review_rows, "owner_verdict")
    try:                                      # a bad label is refused before anything is locked or written
        x.validate(key, agent, owner_ids, owner_blind, review)
    except ValueError as e:
        print(f"EXP-0058: {e}; nothing written")
        return 2
    lock_path = a.private / "labels_lock.json"
    sums = {"agent_labels.csv": x.label_digest(agent), "owner_blind.csv": x.label_digest(owner_blind)}
    if lock_path.exists():
        lock = json.loads(lock_path.read_text())
        changed = [f for f in LOCKED if lock.get(f) != sums[f]]
        if changed:
            print(f"EXP-0058: {', '.join(changed)} changed after the labels were locked; refused")
            return 2
    else:
        lock_path.write_text(json.dumps(sums, indent=1) + "\n")

    queue = x.review_queue(key, agent, owner_blind, review)
    have = {r["item_id"] for r in review_rows}
    best = {**agent, **owner_blind}
    for i in queue:
        if i not in have:
            r = blind[i]
            review_rows.append({"item_id": i, "session": r["session"], "symbol": r["symbol"], "headline": r["headline"],
                                "v3_category": key[i], "best_label": best[i],
                                "best_source": "owner_blind" if i in owner_blind else "agent_blind",
                                "owner_verdict": ""})
    cols = ["item_id", "session", "symbol", "headline", "v3_category", "best_label", "best_source", "owner_verdict"]
    tmp = review_path.with_suffix(".tmp")
    with open(tmp, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=cols, lineterminator="\n")
        w.writeheader()
        w.writerows(sorted(review_rows, key=lambda r: r["item_id"]))
    tmp.replace(review_path)

    population = manifest["frame_by_category"]
    rep = x.score(key, population, agent, owner_ids, owner_blind, review)
    # The JSON names the slots by role, not by person, and says who filled them (Codex on #692).
    rep["owner_slots_filled_by"] = filled_by
    rep["v3_vs_owner_slot"] = rep.pop("owner_only")
    rep["labeller_check_compares"] = f"agent_blind vs owner slot ({filled_by})"
    rep["reference_sources"] = {(f"owner_slot_{k[len('owner_'):]}" if k.startswith("owner_") else k): v
                                for k, v in rep["reference_sources"].items()}
    print(json.dumps({"complete": rep["complete"], "missing": rep["missing"], "labelled_n": rep["labelled_n"]}))
    if a.publish:
        na.publish(na.CLONE, "EXP-0058: labels and owner review", folder=PRIVATE_IN_REPO)
    if not a.final:
        return 0
    if not rep["complete"]:
        print("EXP-0058: rulings are missing; the report is not written")
        return 2
    done = [f for f in ("report.json", "report.md") if (a.public / f).exists()]
    if done:
        print(f"EXP-0058: the report was written once ({', '.join(done)} exist); a re-run needs a new EXP id")
        return 2
    # A list of {file, sha256}: a "<name>_key.csv": "<hex>" pair reads as a secret to gitleaks.
    rep["private_files"] = [{"file": f, "sha256": x.sha256(a.private / f)} for f in
                            ("sample_blind.csv", "sample_key.csv", *LOCKED, "owner_review.csv")]
    x.check_public(rep)
    (a.public / "report.json").write_text(json.dumps(rep, indent=1) + "\n")
    (a.public / "report.md").write_text(markdown(rep))
    print(f"EXP-0058: verdict {rep['verdict']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
