"""K0.8 — surface candidate contradictions: same concept (or same setup slot) with
differing parameter values, or competing concepts filling the same slot for a setup.

Output: knowledge/_work/param_variants.json — raw material for contradictions.md,
which is then written by hand with sources (each conflict -> a G1 test variant).
"""
from __future__ import annotations

import json
from collections import defaultdict
from pathlib import Path

NUMERIC_KEYS_HINT = ("min", "max", "pct", "rr", "ratio", "rvol", "price", "float", "candles", "window",
                     "stop", "target", "risk", "loss", "size", "timeframe", "time")


def norm(v) -> str:
    return json.dumps(v, sort_keys=True, ensure_ascii=False) if isinstance(v, (dict, list)) else str(v).strip().lower()


def main() -> None:
    comps = [json.loads(l) for l in Path("knowledge/components.jsonl").read_text().splitlines() if l.strip()]
    comps = [c for c in comps if not c.get("options_only")]
    # 1) parameter disagreements within a concept
    variants = defaultdict(lambda: defaultdict(list))
    for c in comps:
        for k, v in (c.get("params") or {}).items():
            if any(h in k.lower() for h in NUMERIC_KEYS_HINT):
                variants[(c["type"], c["concept"], k)][norm(v)].append(
                    {"id": c["component_id"], "doc": c["doc_id"], "family": c.get("family"),
                     "chunk": c["evidence_chunk_id"]})
    param_conf = []
    for (typ, concept, key), vals in variants.items():
        if len(vals) >= 2:
            param_conf.append({"type": typ, "concept": concept, "param": key,
                               "values": {v: {"n": len(ev), "families": sorted({e['family'] for e in ev}),
                                              "evidence": ev[:4]} for v, ev in vals.items()}})
    param_conf.sort(key=lambda x: -sum(v["n"] for v in x["values"].values()))
    # 2) competing concepts for the same slot of the same setup (e.g. bull_flag stop rules)
    slots = defaultdict(lambda: defaultdict(list))
    for c in comps:
        if c["type"] in ("stop", "target", "exit", "entry.trigger", "management"):
            for s in c.get("setups") or ["(any)"]:
                slots[(s, c["type"])][c["concept"]].append(
                    {"id": c["component_id"], "doc": c["doc_id"], "family": c.get("family"),
                     "statement": c["statement"]})
    slot_conf = [{"setup": s, "slot": t, "competing": {k: {"n": len(v), "examples": v[:3]} for k, v in cs.items()}}
                 for (s, t), cs in slots.items() if len(cs) >= 2]
    slot_conf.sort(key=lambda x: -sum(v["n"] for v in x["competing"].values()))
    Path("knowledge/_work/param_variants.json").write_text(json.dumps(
        {"param_conflicts": param_conf, "slot_conflicts": slot_conf}, indent=1, ensure_ascii=False))
    print(f"{len(param_conf)} param conflicts, {len(slot_conf)} slot conflicts")


if __name__ == "__main__":
    main()
