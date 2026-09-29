"""K0.1 — build knowledge_inventory.csv from the prior KB index + delta report.

One row per logical source file (iWork packages count as one file).
"""
from __future__ import annotations

import csv
import json
import re
import sqlite3
from pathlib import Path

from wt.knowledge.scope import classify, source_family, top_of

WORK = Path("knowledge/_work")
DERIVED_TOP = {"VWAP Playbook (X post)"}  # generated from this KB earlier -> not independent evidence
PKG = (".pages/", ".key/", ".numbers/")

COLUMNS = ["filename", "path", "type", "date_modified", "size", "summary", "extracted_topics",
           "doc_id", "sha256", "dup_of", "status", "contains_pii", "third_party_copyright",
           "source_family", "in_scope", "scope_reason"]


def summarize(text: str | None, limit: int = 220) -> str:
    if not text:
        return ""
    m = re.search(r"## Description\s*\n(.+?)(?:\n#|\Z)", text, re.S)
    body = m.group(1) if m else re.sub(r"^---.*?---", "", text, flags=re.S)
    body = re.sub(r"\s+", " ", body).strip()
    cut = body[:limit]
    return cut + ("…" if len(body) > limit else "")


def main() -> None:
    con = sqlite3.connect(WORK / "kb.sqlite")
    delta = json.loads((WORK / "delta_report.json").read_text())
    missing = set(delta["missing"])
    rows = []
    q = """select f.path,f.type,f.mtime,f.bytes,f.topic_tags,f.doc_id,f.sha256,f.dup_of,f.status,
                  f.contains_pii,f.third_party_copyright,d.text
           from files f left join documents d on d.doc_id=f.doc_id order by f.path"""
    for (path, typ, mtime, size, tags, doc_id, sha, dup, status, pii, cr, text) in con.execute(q):
        in_scope, reason = classify(path, typ)
        if top_of(path) in DERIVED_TOP:
            in_scope, reason = False, "derived content (generated from this KB)"
        if status == "skipped":
            in_scope, reason = False, "prior-run _output (excluded by KB)"
        if dup:
            reason += f"; duplicate of {dup}"
        if path in missing:
            status = f"{status}; source removed since KB build (text retained)"
        rows.append({
            "filename": Path(path).name, "path": path, "type": typ, "date_modified": mtime or "",
            "size": size, "summary": summarize(text), "extracted_topics": tags or "",
            "doc_id": doc_id or "", "sha256": sha or "", "dup_of": dup or "", "status": status,
            "contains_pii": pii, "third_party_copyright": cr, "source_family": source_family(path),
            "in_scope": int(in_scope and not dup), "scope_reason": reason,
        })
    for path in delta["new"]:
        if any(s in path for s in PKG):
            continue
        in_scope, reason = classify(path, "new")
        if top_of(path) in DERIVED_TOP or path == "CLAUDE.md":
            in_scope, reason = False, "derived content / KB documentation"
        rows.append({c: "" for c in COLUMNS} | {
            "filename": Path(path).name, "path": path, "type": Path(path).suffix.lstrip(".").lower(),
            "status": "new since KB build", "source_family": source_family(path),
            "in_scope": int(in_scope), "scope_reason": reason})
    out = Path("knowledge/knowledge_inventory.csv")
    with open(out, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=COLUMNS)
        w.writeheader()
        w.writerows(rows)
    n_in = sum(r["in_scope"] for r in rows)
    print(f"wrote {out}: {len(rows)} rows, {n_in} in deep scope")


if __name__ == "__main__":
    main()
