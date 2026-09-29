"""Compact evidence digest used to write the synthesis deliverables (catalog, graph,
contradictions, playbook). Equity-relevant (non-options-only) records only."""
from __future__ import annotations

import json
from collections import Counter, defaultdict
from pathlib import Path

from wt.knowledge.dedup import load as load_groups

OUT = Path("knowledge/_work/digest.md")


def main() -> None:
    grp = load_groups()
    comps = [json.loads(l) for l in Path("knowledge/components.jsonl").read_text().splitlines() if l.strip()]
    eq = [c for c in comps if not c.get("options_only")]
    for c in eq:
        c["doc_id"] = grp.get(c["doc_id"], c["doc_id"])
    lines = [f"# Digest — {len(eq)} equity records ({len(comps)-len(eq)} options-only excluded)\n"]
    # strategies named by sources
    strat = defaultdict(list)
    for c in eq:
        if c.get("strategy"):
            strat[c["strategy"].strip().lower()].append(c)
    lines.append("## Named strategies (by #docs)\n")
    for s, cs in sorted(strat.items(), key=lambda x: -len({c['doc_id'] for c in x[1]}))[:30]:
        fams = Counter(c["family"] for c in cs)
        types = Counter(c["type"] for c in cs)
        lines.append(f"- **{s}** — docs {len({c['doc_id'] for c in cs})}, recs {len(cs)}, fam {dict(fams)}, types {dict(types)}")
    by_tc = defaultdict(list)
    for c in eq:
        by_tc[(c["type"], c["concept"])].append(c)
    order = ["selection.universe", "selection.catalyst", "selection.rvol", "selection.momentum", "selection.time",
             "setup", "entry.trigger", "stop", "target", "management", "exit", "risk.sizing", "risk.expectancy",
             "microstructure", "psychology", "mistake", "win_behaviour"]
    for t in order:
        items = sorted(((k, v) for k, v in by_tc.items() if k[0] == t),
                       key=lambda kv: -len({c["doc_id"] for c in kv[1]}))
        lines.append(f"\n## {t}\n")
        top = 14 if t not in ("mistake", "win_behaviour", "psychology") else 18
        for (_tt, concept), cs in items[:top]:
            docs = {c["doc_id"] for c in cs}
            fams = Counter(c["family"] for c in cs)
            own = sum(c.get("evidence_type") == "own_lesson" for c in cs)
            test = Counter(c.get("testability") for c in cs).most_common(1)[0][0]
            lines.append(f"### {concept} — docs {len(docs)}, fam {dict(fams)}, own_lessons {own}, testability {test}")
            seen = set()
            for c in cs:
                s = c["statement"][:170]
                key = s[:60].lower()
                if key in seen:
                    continue
                seen.add(key)
                p = json.dumps(c.get("params") or {}, ensure_ascii=False)[:160]
                lines.append(f"  - [{c['family'][:10]}|{c.get('evidence_type','?')[:6]}|{c['component_id']}] {s} {p}")
                if len(seen) >= 5:
                    break
        rest = len(items) - top
        if rest > 0:
            lines.append(f"  _(+{rest} rarer concepts: " + ", ".join(f"{k[1]}({len({c['doc_id'] for c in v})})"
                                                                for k, v in items[top:top + 40]) + ")_")
    charts = json.loads(Path("knowledge/chart_examples.json").read_text())
    lines.append(f"\n## Charts ({len(charts)})\n")
    for f in ("setup", "timeframe", "outcome", "confidence"):
        lines.append(f"- {f}: {dict(Counter(str(c.get(f)).lower() for c in charts).most_common(12))}")
    ind = Counter(i.lower() for c in charts for i in (c.get("indicators") or []))
    lines.append(f"- indicators: {dict(ind.most_common(15))}")
    lines.append(f"- tickers: {dict(Counter(str(c.get('ticker')).upper() for c in charts).most_common(15))}")
    wl = [c for c in charts if str(c.get("outcome")).lower() in ("win", "loss")]
    lines.append(f"- charts with visible outcome: {len(wl)} — " + "; ".join(
        f"{c.get('ticker')} {c.get('setup')} {c.get('outcome')}" for c in wl[:30]))
    OUT.write_text("\n".join(lines) + "\n")
    print(f"digest: {OUT} ({OUT.stat().st_size//1000} KB)")


if __name__ == "__main__":
    main()
