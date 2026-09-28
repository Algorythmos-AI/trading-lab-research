"""K0.5 — aggregate validated components into concept-level evidence and promote themes.

Outputs:
  knowledge/pattern_frequency.csv  (component layer + lexicon layer)
  knowledge/themes.md              (ranked themes, promotion status, fixed thresholds)
  knowledge/_work/concepts.json    (per-concept evidence for catalog/playbook writing)
"""
from __future__ import annotations

import csv
import json
from collections import Counter, defaultdict
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from wt.knowledge.dedup import load as load_groups  # noqa: E402

WORK = Path("knowledge/_work")
# Promotion thresholds — fixed before mining (plan K0.5). Do not tune after seeing results.
CORE = {"families": 2, "media": 2, "docs": 10}

# Seed themes (from the owner's review) + concept membership. Scored by data, never auto-promoted.
THEMES: dict[str, dict] = {
    "momentum_stocks": {"seed": True, "concepts": {"percent_up_day", "gap_up", "scanner", "micro_pullback", "momentum", "top_gainers"}},
    "high_relative_volume": {"seed": True, "concepts": {"relative_volume"}},
    "catalyst_driven": {"seed": True, "concepts": {"catalyst_news", "earnings_catalyst", "fda_catalyst", "catalyst_freshness"}},
    "bull_flags": {"seed": True, "concepts": {"bull_flag"}},
    "breakouts": {"seed": True, "concepts": {"breakout", "flat_top_breakout", "break_prior_high", "premarket_high_break", "whole_dollar_break", "half_dollar_break", "first_candle_new_high"}},
    "partial_profit_taking": {"seed": True, "concepts": {"partials_scale_out", "sell_into_strength"}},
    "risk_reward_asymmetry": {"seed": True, "concepts": {"risk_reward_ratio", "profit_loss_ratio", "expectancy_model", "win_rate_assumption"}},
    "level2_confirmation": {"seed": True, "concepts": {"level2_reading", "tape_reading", "big_bid_ask", "hidden_orders"}},
    "first_hours_after_open": {"seed": True, "concepts": {"first_hours", "premarket_prep"}},
    "low_float_runners": {"seed": True, "concepts": {"low_float", "share_structure"}},
    # structural themes (not seeded by the owner) — still subject to the same rule
    "vwap_trading": {"seed": False, "concepts": {"vwap_pullback", "vwap_reclaim", "vwap_entry", "stop_vwap"}},
    "tight_candle_stops": {"seed": False, "concepts": {"stop_prior_candle_low", "stop_pullback_low", "stop_5m_candle_low"}},
    "hard_loss_limits": {"seed": False, "concepts": {"max_loss_per_trade", "daily_max_loss", "stop_max_loss", "cushion_rule", "share_size_ramp"}},
    "psychological_discipline": {"seed": False, "concepts": {"dont_chase", "respect_stop", "stop_after_losses", "overtrading", "patience", "fomo", "revenge_trading"}},
    "reversal_setups": {"seed": False, "concepts": {"reversal", "red_to_green"}},
    "gap_and_go": {"seed": False, "concepts": {"gap_and_go"}},
    "moving_average_context": {"seed": False, "concepts": {"above_key_ma"}},
    "halt_risk": {"seed": False, "concepts": {"halt_behaviour"}},
}


def status(fam: int, media: int, docs: int) -> str:
    if fam >= CORE["families"] and media >= CORE["media"] and docs >= CORE["docs"]:
        return "CORE"
    if docs <= 1:
        return "anecdotal"
    return "supporting"


def main() -> None:
    comps = [json.loads(l) for l in Path("knowledge/components.jsonl").read_text().splitlines() if l.strip()]
    grp = load_groups()
    for r in comps:  # identical-text copies count once
        r["doc_id"] = grp.get(r["doc_id"], r["doc_id"])
    by = defaultdict(lambda: {"docs": set(), "media": Counter(), "families": Counter(), "ev": Counter(),
                              "test": Counter(), "params": [], "statements": [], "ids": [], "setups": Counter(),
                              "strategies": Counter(), "options_only": 0})
    for r in comps:
        key = (r["type"], r["concept"])
        a = by[key]
        a["docs"].add(r["doc_id"])
        a["media"][r.get("media", "?")] += 1
        a["families"][r.get("family", "?")] += 1
        a["ev"][r.get("evidence_type", "?")] += 1
        a["test"][r.get("testability", "?")] += 1
        a["options_only"] += bool(r.get("options_only"))
        if r.get("params"):
            a["params"].append(r["params"])
        a["statements"].append(r["statement"])
        a["ids"].append(r["component_id"])
        for s in r.get("setups") or []:
            a["setups"][s] += 1
        if r.get("strategy"):
            a["strategies"][r["strategy"]] += 1
    rows, concepts = [], {}
    for (typ, concept), a in by.items():
        fam, med, nd = len(a["families"]), len(a["media"]), len(a["docs"])
        row = {"layer": "component", "component_type": typ, "concept": concept, "n_records": len(a["ids"]),
               "n_docs": nd, "n_media_types": med, "n_families": fam,
               "screenshots": a["media"].get("screenshot", 0), "pdfs": a["media"].get("pdf", 0),
               "videos": a["media"].get("video", 0),
               "families": ";".join(f"{k}:{v}" for k, v in a["families"].most_common()),
               "own_lessons": a["ev"].get("own_lesson", 0),
               "testability": a["test"].most_common(1)[0][0],
               "options_only_share": round(a["options_only"] / len(a["ids"]), 2),
               "status": status(fam, med, nd)}
        rows.append(row)
        concepts[f"{typ}|{concept}"] = row | {"statements": a["statements"][:12], "params": a["params"][:25],
                                               "component_ids": a["ids"], "setups": dict(a["setups"].most_common(8)),
                                               "strategies": dict(a["strategies"].most_common(8))}
    rows.sort(key=lambda r: (r["status"] != "CORE", -r["n_families"], -r["n_docs"]))
    lex = list(csv.DictReader(open(WORK / "lexicon_frequency.csv")))
    fields = list(rows[0].keys())
    with open("knowledge/pattern_frequency.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields + [k for k in lex[0] if k not in fields], extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)
        w.writerows(lex)
    (WORK / "concepts.json").write_text(json.dumps(concepts, indent=1, ensure_ascii=False))

    # themes: union of docs over member concepts (equity-relevant records only)
    theme_rows = []
    mapped = set()
    for name, t in THEMES.items():
        docs, media, fams, recs = set(), Counter(), Counter(), 0
        for r in comps:
            if r["concept"] in t["concepts"] and not r.get("options_only"):
                docs.add(r["doc_id"]); media[r.get("media")] += 1; fams[r.get("family")] += 1; recs += 1
        mapped |= t["concepts"]
        theme_rows.append((name, t["seed"], len(docs), len(media), len(fams), recs, media, fams,
                           status(len(fams), len(media), len(docs))))
    theme_rows.sort(key=lambda x: (x[8] != "CORE", -x[2]))
    emergent = sorted((r for r in rows if r["concept"] not in mapped and r["options_only_share"] < 0.5
                       and r["status"] == "CORE"), key=lambda r: -r["n_docs"])
    out = ["# Themes — ranked by evidence (K0.5)", "",
           f"Promotion rule (fixed before mining): **CORE** = ≥{CORE['families']} source families AND "
           f"≥{CORE['media']} media types AND ≥{CORE['docs']} distinct documents; **anecdotal** = 1 document; "
           "otherwise **supporting**. Options-only records are excluded from equity themes. "
           "Seed themes come from the owner's review but are scored exactly like the rest.", "",
           "| Theme | Seeded? | Status | Docs | Media types | Families | Records | Media mix | Family mix |",
           "|---|---|---|---|---|---|---|---|---|"]
    for (name, seed, nd, nm, nf, recs, media, fams, st) in theme_rows:
        out.append(f"| {name} | {'yes' if seed else 'no'} | **{st}** | {nd} | {nm} | {nf} | {recs} | "
                   f"{', '.join(f'{k}:{v}' for k, v in media.most_common())} | "
                   f"{', '.join(f'{k}:{v}' for k, v in fams.most_common())} |")
    out += ["", "## Emergent CORE concepts not covered by any theme above", "",
            "| Type | Concept | Docs | Families | Media |", "|---|---|---|---|---|"]
    for r in emergent[:40]:
        out.append(f"| {r['component_type']} | {r['concept']} | {r['n_docs']} | {r['families']} | "
                   f"s:{r['screenshots']} p:{r['pdfs']} v:{r['videos']} |")
    Path("knowledge/themes.md").write_text("\n".join(out) + "\n")
    print(f"{len(comps)} components -> {len(rows)} concepts; "
          f"{sum(1 for r in rows if r['status']=='CORE')} CORE concepts; themes written")


if __name__ == "__main__":
    main()
