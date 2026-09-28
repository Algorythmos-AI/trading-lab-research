"""Text-level de-duplication: docs whose normalised text is identical (e.g. the same
Warrior article saved as 3 PDFs) count as ONE document in all frequency statistics."""
from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from pathlib import Path

WORK = Path("knowledge/_work")


def _norm(t: str) -> str:
    t = re.sub(r"^---.*?---", "", t or "", flags=re.S)       # front-matter differs per file
    t = re.sub(r"[^a-z0-9]+", " ", t.lower())
    return t.strip()


def build() -> dict[str, str]:
    con = sqlite3.connect(WORK / "kb.sqlite")
    groups: dict[str, str] = {}
    first: dict[str, str] = {}
    for did, text in con.execute("select doc_id, text from documents order by doc_id"):
        n = _norm(text)
        h = hashlib.sha1(n.encode()).hexdigest() if len(n) > 200 else f"short:{did}"
        groups[did] = first.setdefault(h, did)
    (WORK / "text_groups.json").write_text(json.dumps(groups))
    return groups


def load() -> dict[str, str]:
    p = WORK / "text_groups.json"
    return json.loads(p.read_text()) if p.exists() else build()


if __name__ == "__main__":
    g = build()
    print(f"{len(g)} docs -> {len(set(g.values()))} distinct texts")
