"""K0.2/K0.4 — validate subagent outputs and merge into knowledge/components.jsonl
and knowledge/chart_examples.json. Invalid records are quarantined, never silently kept."""
from __future__ import annotations

import json
import re
import sqlite3
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from wt.knowledge.taxonomy import COMPONENT_TYPES  # noqa: E402
from wt.knowledge.scope import source_family  # noqa: E402

WORK = Path("knowledge/_work")
PNL_RX = re.compile(r"[+-]?\$?\s?\d{1,3}(,\d{3})+(\.\d+)?")
PII_RX = re.compile(r"\$\s?\d{1,3}(,\d{3})+(\.\d+)?|account\s*(no|number|#)\s*[:#]?\s*\d{4,}", re.I)


def load_jsonl(p: Path) -> tuple[list[dict], int]:
    recs, bad = [], 0
    if not p.exists():
        return recs, bad
    for line in p.read_text().splitlines():
        if not line.strip():
            continue
        try:
            recs.append(json.loads(line))
        except json.JSONDecodeError:
            bad += 1
    return recs, bad


def main() -> None:
    con = sqlite3.connect(WORK / "kb.sqlite")
    chunk_doc = dict(con.execute("select chunk_id, doc_id from chunks"))
    pii_docs = {d for (d,) in con.execute("select doc_id from documents where contains_pii=1")}
    doc_path = dict(con.execute("select doc_id, source_path from documents"))
    comps, charts, quarantine = [], [], []
    stats = Counter()
    done = sorted(p.stem for p in (WORK / "done").glob("batch_*.done"))
    for b in done:
        recs, bad = load_jsonl(WORK / "components" / f"{b}.jsonl")
        stats["component_parse_errors"] += bad
        for i, r in enumerate(recs):
            why = []
            if r.get("type") not in COMPONENT_TYPES:
                why.append("bad type")
            cid = r.get("evidence_chunk_id")
            if cid not in chunk_doc:
                why.append("unknown chunk")
            elif chunk_doc[cid] != r.get("doc_id"):
                r["doc_id"] = chunk_doc[cid]  # repair doc_id from authoritative chunk map
                stats["doc_id_repaired"] += 1
            if not r.get("concept") or not r.get("statement"):
                why.append("missing concept/statement")
            # $-amount check only on docs flagged as personal records (public rule values like the
            # $25,000 PDT threshold in course material are not PII)
            if r.get("doc_id") in pii_docs and PII_RX.search(json.dumps(r).replace("$25,000", "")):
                why.append("possible PII")
            if r.get("doc_id") in doc_path:  # family is derived from the path, not trusted from the agent
                r["family"] = source_family(doc_path[r["doc_id"]])
            r["batch"] = b
            r["component_id"] = f"{b}:{i:04d}"
            (quarantine if why else comps).append(r | ({"_why": why} if why else {}))
        crecs, cbad = load_jsonl(WORK / "charts" / f"{b}.jsonl")
        stats["chart_parse_errors"] += cbad
        for r in crecs:
            if r.get("chunk_id") in chunk_doc:
                r["doc_id"] = chunk_doc[r["chunk_id"]]
                for k in ("annotations", "entry", "stop", "target"):  # never carry $ P&L/balances
                    if isinstance(r.get(k), str) and PNL_RX.search(r[k]):
                        r[k] = PNL_RX.sub("[$ amount omitted]", r[k])
                        stats["chart_amounts_scrubbed"] += 1
                r["batch"] = b
                charts.append(r)
            else:
                quarantine.append(r | {"_why": ["chart unknown chunk"], "batch": b})
    Path("knowledge/components.jsonl").write_text(
        "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in comps))
    Path("knowledge/chart_examples.json").write_text(json.dumps(charts, indent=1, ensure_ascii=False))
    (WORK / "quarantine.jsonl").write_text(
        "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in quarantine))
    stats.update({"batches_done": len(done), "components": len(comps), "charts": len(charts),
                  "quarantined": len(quarantine)})
    (WORK / "merge_stats.json").write_text(json.dumps(stats, indent=1))
    print(json.dumps(stats))


if __name__ == "__main__":
    main()
