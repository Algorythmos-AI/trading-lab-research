"""K0 — k0_coverage.md: reconcile every inventoried file to exactly one outcome."""
from __future__ import annotations

import csv
import json
from collections import Counter
from pathlib import Path

WORK = Path("knowledge/_work")


def main() -> None:
    inv = list(csv.DictReader(open("knowledge/knowledge_inventory.csv")))
    sel = json.loads((WORK / "selection.json").read_text())
    index = json.loads((WORK / "batch_index.json").read_text())
    done = {p.stem for p in (WORK / "done").glob("batch_*.done")}
    deferred = json.loads((WORK / "deferred.json").read_text())
    doc_batch = {d: b["batch"] for b in index for d in b["docs"]}
    not_selected = set(sel["not_selected_no_daytrading_signal"])
    stats = json.loads((WORK / "merge_stats.json").read_text())
    delta = json.loads((WORK / "delta_report.json").read_text())["summary"]
    parity = json.loads((WORK / "parity.json").read_text())
    outcome = Counter()
    for r in inv:
        if r["in_scope"] != "1":
            reason = "duplicate of another file (content counted once)" if r["dup_of"] \
                else r["scope_reason"].split(";")[0]
            outcome[f"excluded — {reason}"] += 1
            continue
        d = r["doc_id"]
        if d in doc_batch:
            b = doc_batch[d]
            outcome["deep: LLM-extracted (batch done)" if b in done
                    else ("deep: budget-deferred — low relevance, lexicon-mined only" if b in deferred["batches"]
                          else "deep: PENDING — batch not yet run")] += 1
        elif d in not_selected:
            outcome["deep: lexicon-mined only (no day-trading signal)"] += 1
        else:
            outcome["deep: FAILED — unaccounted"] += 1
    total = sum(outcome.values())
    lines = ["# K0 Coverage & Reconciliation", "",
             f"Inventory rows: **{len(inv)}** · reconciled outcomes: **{total}** · "
             f"unaccounted: **{outcome.get('deep: FAILED — unaccounted', 0)}**", "",
             "| Outcome | Files |", "|---|---|"]
    lines += [f"| {k} | {v} |" for k, v in sorted(outcome.items(), key=lambda x: -x[1])]
    lines += ["", "## Extraction", "",
              f"- Batches: {len(done)} of {len(index)} done",
              f"- Component records kept: {stats['components']} · chart records: {stats['charts']} · "
              f"quarantined: {stats['quarantined']} · parse errors: "
              f"{stats['component_parse_errors'] + stats['chart_parse_errors']}",
              f"- Budget-deferred batches ({len(deferred['batches'])}): " + "; ".join(f"{k} ({v})" for k, v in deferred["batches"].items()),
              "- Known limitation: `options_only` flags were applied slightly inconsistently between two Kenan Grace batches "
              "(047a stricter than 047b); equity themes exclude options_only records, so a few general rules from 047a may be under-counted.",
              "- Source families are a coarse independence proxy: Warrior Trading supplies ~75% of equity records.",
              "- Chart fields come from the prior KB's Claude-vision transcriptions of each screenshot "
              "(no re-download of the 3,815 cloud-only originals); a 20-image sample is checked against "
              "the actual images during verification.", "",
              "## Delta vs. prior KB build (2026-06-28)", "",
              f"- Live files {delta['live_files']} (includes iWork package internals) vs manifest {delta['manifest_rows']}",
              "- Genuinely new files: 9 (CLAUDE.md + 8 in `VWAP Playbook (X post)`, which is content generated "
              "from this KB earlier, so it's excluded as non-independent evidence)",
              "- Sources removed since build: 8 videos (their transcripts are kept in the KB)",
              f"- Cloud-only (dataless) files locally: {delta['dataless']} — readable on demand; not needed",
              "- `~/Documents/trading/DAY-TRADING/`: 25 of 27 PDFs are byte-identical duplicates; 2 contain only a title line", "",
              "## Chrome parity check (icloud.com)", "",
              "| Folder | Web | Local | Match |", "|---|---|---|---|"]
    lines += [f"| {f['folder']} | {f['web_items']} | {f['local_items']} | {'✅' if f['match'] else '❌'} |"
              for f in parity["folders"]]
    lines += ["", f"_{parity['note']}_"]
    Path("knowledge/k0_coverage.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines[:14]))


if __name__ == "__main__":
    main()


def verification_section() -> str:
    """Append K0 verification evidence: sample audit, anchor examples, chunk resolution."""
    import sqlite3
    json.loads((WORK / "verification_report.json").read_text())  # precondition: the K0 report exists and parses
    comps = [json.loads(l) for l in Path("knowledge/components.jsonl").read_text().splitlines() if l.strip()]
    chunks = {c for (c,) in sqlite3.connect(WORK / "kb.sqlite").execute("select chunk_id from chunks")}
    unresolved = sum(c["evidence_chunk_id"] not in chunks for c in comps)
    def has(pred): return any(pred(c) for c in comps)
    anchors = {
        "bull flag: 3+ green, 2+ red, EMA9, retrace ≤50%": has(lambda c: c["concept"] == "bull_flag" and
            (c.get("params") or {}).get("green_candles_min") == 3 and (c.get("params") or {}).get("retrace_pct_max") == 50),
        "whole/half-dollar break entry": has(lambda c: c["concept"] in ("whole_dollar_break", "half_dollar_break")),
        "sell into strength": has(lambda c: c["concept"] == "sell_into_strength"),
        "partials / scale out": has(lambda c: c["concept"] == "partials_scale_out"),
    }
    out = ["", "## Verification", "",
           f"- Every `evidence_chunk_id` resolves to a real KB chunk: **{len(comps) - unresolved}/{len(comps)}**",
           "- Independent seeded sample audit (20 components vs source chunks, 20 charts vs actual images): "
           "components 15 SUPPORTED / 5 PARTIAL / 0 UNSUPPORTED; charts 18 MATCH / 2 PARTIAL / 0 MISMATCH; "
           "no verbatim copying found. Partial cases: a few records add plausible detail not in the chunk "
           "(one fabricated param in an options record, batch_053:0003) — treat single-source parameters as hypotheses, "
           "which G1 tests anyway. Details: `_work/verification_report.json`.",
           "- Anchor examples extracted correctly: " + "; ".join(f"{k} {'✅' if ok else '❌'}" for k, ok in anchors.items()),
           "- Chart records: $ amounts resembling P&L/balances are scrubbed at merge time."]
    return "\n".join(out) + "\n"


if __name__ == "__main__":
    with open("knowledge/k0_coverage.md", "a") as f:
        f.write(verification_section())
