"""K0.2 — select docs for LLM extraction and write resumable batch files.

Selection (deterministic, recorded in coverage):
  * all in-scope docs from warrior_trading / own_journal families
  * other in-scope docs with >=1 day-trading lexicon hit
  * henry_options docs only with >=1 hit in the stricter equity-trading set
    (their bid/ask/stop/breakeven vocabulary is mostly options-specific)
"""
from __future__ import annotations

import csv
import json
import sqlite3
from collections import defaultdict
from pathlib import Path

from wt.knowledge.taxonomy import tag

WORK = Path("knowledge/_work")
BATCH_CHARS = 150_000
DAYTRADE = {"bull_flag", "micro_pullback", "flat_top_breakout", "abcd", "gap_and_go", "vwap_setup",
            "opening_range", "red_to_green", "first_candle_new_high", "break_prior_high",
            "whole_half_dollar", "premarket_high_break", "stop_candle_low", "partials_scale_out",
            "add_to_winner", "breakeven_stop", "trailing_stop", "sell_into_strength", "relative_volume",
            "low_float", "catalyst_news", "gap_up", "level2_tape", "halts", "risk_reward", "max_loss",
            "position_sizing", "dont_chase", "mistake", "exit_failed", "percent_up_day", "scanner",
            "first_hours"}
HENRY_STRICT = {"bull_flag", "micro_pullback", "flat_top_breakout", "abcd", "gap_and_go", "vwap_setup",
                "opening_range", "partials_scale_out", "trailing_stop", "position_sizing", "max_loss",
                "risk_reward", "dont_chase", "discipline", "mistake"}
PRIORITY = {"warrior_trading": 0, "own_journal": 1, "own_notes": 2, "book": 3, "blog_x": 4, "henry_options": 5}
MEDIA = {"image": "screenshot", "pdf": "pdf", "video": "video", "iwork": "iwork",
         "spreadsheet": "spreadsheet"}


def main() -> None:
    inv = {r["doc_id"]: r for r in csv.DictReader(open("knowledge/knowledge_inventory.csv"))
           if r["in_scope"] == "1"}
    con = sqlite3.connect(WORK / "kb.sqlite")
    chunks: dict[str, list[tuple[str, str, str]]] = defaultdict(list)
    hits: dict[str, set[str]] = defaultdict(set)
    for cid, did, page, txt in con.execute("select chunk_id,doc_id,page,text from chunks order by chunk_id"):
        if did in inv:
            chunks[did].append((cid, str(page or ""), txt))
            hits[did] |= tag(txt)
    selected, skipped = [], []
    for did, r in inv.items():
        fam = r["source_family"]
        h = hits[did]
        if fam in ("warrior_trading", "own_journal"):
            ok = True
        elif fam == "henry_options":
            ok = bool(h & HENRY_STRICT)
        else:
            ok = bool(h & DAYTRADE)
        (selected if ok and chunks[did] else skipped).append(did)
    selected.sort(key=lambda d: (PRIORITY.get(inv[d]["source_family"], 9), inv[d]["path"]))
    bdir = WORK / "batches"
    bdir.mkdir(parents=True, exist_ok=True)
    batches, cur, size = [], [], 0
    for did in selected:
        n = sum(len(t) for _, _, t in chunks[did])
        if cur and size + n > BATCH_CHARS:
            batches.append(cur)
            cur, size = [], 0
        cur.append(did)
        size += n
    if cur:
        batches.append(cur)
    index = []
    for i, docs in enumerate(batches, 1):
        name = f"batch_{i:03d}"
        with open(bdir / f"{name}.txt", "w") as f:
            for did in docs:
                r = inv[did]
                f.write(f"\n===== DOC {did} | media={MEDIA.get(r['type'], r['type'])} | family={r['source_family']}"
                        f" | pii={r['contains_pii']} | path={r['path']}\n")
                for cid, page, txt in chunks[did]:
                    f.write(f"[{cid}] (page {page})\n{txt.strip()}\n")
        index.append({"batch": name, "docs": docs,
                      "families": sorted({inv[d]['source_family'] for d in docs})})
    (WORK / "batch_index.json").write_text(json.dumps(index, indent=1))
    (WORK / "selection.json").write_text(json.dumps(
        {"selected": selected, "not_selected_no_daytrading_signal": skipped}, indent=1))
    print(f"{len(selected)} docs selected, {len(skipped)} not selected, {len(batches)} batches")


if __name__ == "__main__":
    main()
