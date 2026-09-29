"""K0.5 — deterministic lexicon frequency over ALL in-scope docs.

Counts distinct documents, media types and source families per concept, so a
concept repeated in 40 screenshots of one lesson cannot outweigh 3 independent
sources. Output: knowledge/pattern_frequency.csv (lexicon layer).
"""
from __future__ import annotations

import csv
import sqlite3
from collections import defaultdict
from pathlib import Path

from wt.knowledge.taxonomy import LEXICON, tag
from wt.knowledge.dedup import load as load_groups

WORK = Path("knowledge/_work")
MEDIA = {"image": "screenshot"}


def main() -> None:
    inv = {r["doc_id"]: r for r in csv.DictReader(open("knowledge/knowledge_inventory.csv"))
           if r["in_scope"] == "1"}
    grp = load_groups()
    con = sqlite3.connect(WORK / "kb.sqlite")
    doc_hits: dict[str, set[str]] = defaultdict(set)
    for did, txt in con.execute("select doc_id, text from chunks"):
        if did in inv:
            doc_hits[grp.get(did, did)] |= tag(txt)
    agg = {k: {"docs": set(), "media": defaultdict(int), "families": defaultdict(int)} for k in LEXICON}
    for did, hits in doc_hits.items():
        r = inv.get(did) or next(v for k, v in inv.items() if grp.get(k) == did)
        media = MEDIA.get(r["type"], r["type"])
        for k in hits:
            agg[k]["docs"].add(did)
            agg[k]["media"][media] += 1
            agg[k]["families"][r["source_family"]] += 1
    rows = []
    for k, a in agg.items():
        rows.append({
            "layer": "lexicon", "concept": k, "component_type": LEXICON[k][0],
            "n_docs": len(a["docs"]), "n_media_types": len(a["media"]), "n_families": len(a["families"]),
            "screenshots": a["media"].get("screenshot", 0), "pdfs": a["media"].get("pdf", 0),
            "videos": a["media"].get("video", 0),
            "other_media": sum(v for m, v in a["media"].items() if m not in ("screenshot", "pdf", "video")),
            "families": ";".join(f"{f}:{n}" for f, n in sorted(a["families"].items(), key=lambda x: -x[1])),
        })
    rows.sort(key=lambda r: (-r["n_families"], -r["n_docs"]))
    with open(WORK / "lexicon_frequency.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)
    print(f"lexicon frequency: {len(rows)} concepts over {len(doc_hits)} docs")


if __name__ == "__main__":
    main()
