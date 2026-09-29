"""K0.11 — Stock-selection funnel evidence reports (price, time-of-day, low float, RVOL, gap/%-up,
catalyst types, scanners). Deterministic: regex over in-scope chunk text + validated component params.

Counts are DISTINCT DOCUMENTS (identical-text copies merged). A 'hit' requires the numeric pattern to
appear near a topic keyword, to avoid counting unrelated numbers.
"""
from __future__ import annotations

import csv
import json
import re
import sqlite3
from collections import Counter, defaultdict
from pathlib import Path

from wt.knowledge.dedup import load as load_groups

WORK = Path("knowledge/_work")
CORE = {"families": 2, "media": 2, "docs": 10}


def status(fam: int, media: int, docs: int) -> str:
    if fam >= CORE["families"] and media >= CORE["media"] and docs >= CORE["docs"]:
        return "CORE"
    return "anecdotal" if docs <= 1 else "supporting"


PRICE_CTX = re.compile(r"(stock|share|price|priced|penny|small[\s-]*cap|trade|range)", re.I)
RANGE_RX = re.compile(r"\$\s?(\d{1,3}(?:\.\d{1,2})?)\s*(?:-|–|to|and)\s*\$?\s?(\d{1,3}(?:\.\d{1,2})?)(?!\s*%)(?!\s*(?:k|m|b|million|billion))", re.I)
UNDER_RX = re.compile(r"(?:under|below|less than|<)\s*\$\s?(\d{1,3})(?!\s*(?:k|m|b|million|billion))", re.I)
FLOAT_RX = re.compile(r"float[^.]{0,40}?(?:under|below|less than|<|of|around|~)?\s*(\d{1,3}(?:\.\d)?)\s*(?:m\b|mm\b|million)", re.I)
FLOAT_RX2 = re.compile(r"(\d{1,3}(?:\.\d)?)\s*(?:m\b|million)\s*(?:share[s]?\s*)?float", re.I)
RVOL_RX = re.compile(r"(?:(\d{1,2}(?:\.\d)?)\s*x\s*(?:the\s+)?(?:relative|average|avg|normal)?\s*volume|rvol[^.\d]{0,20}(\d{1,2}(?:\.\d)?)\s*x?|relative\s+volume[^.\d]{0,25}(\d{1,2}(?:\.\d)?)\s*x)", re.I)
TIME_WIN = {
    "first 5-15 min / opening bell": re.compile(r"first\s+(?:5|10|15)\s*(?:min|minutes)|opening\s+bell|right\s+at\s+the\s+open", re.I),
    "first 30 min": re.compile(r"first\s+(?:30|thirty)\s*(?:min|minutes)|first\s+half[\s-]hour|9:30\s*(?:-|–|to)\s*10(?::00)?\b", re.I),
    "first hour": re.compile(r"first\s+(?:hour|60\s*min)|9:30\s*(?:-|–|to)\s*10:30", re.I),
    "first 2 hours": re.compile(r"first\s+(?:2|two)\s+hours|9:30\s*(?:-|–|to)\s*11:30|until\s+11:30", re.I),
    "morning until noon": re.compile(r"9:30\s*(?:-|–|to)\s*12|until\s+(?:noon|12)|morning\s+session", re.I),
    "pre-market (4:00-9:30)": re.compile(r"pre[\s-]*market", re.I),
    "midday / lunch": re.compile(r"mid[\s-]*day|lunch\s*(?:time|hour)?|11:30\s*(?:-|–|to)\s*1(?::30)?\b", re.I),
    "power hour / close": re.compile(r"power\s+hour|last\s+(?:30\s*min|hour)|into\s+the\s+close", re.I),
}
GAP_RX = re.compile(r"gap(?:ping|ped|s)?\s*(?:up\s*)?(?:of\s*)?(?:at\s+least\s+|over\s+|more\s+than\s+|>\s*)?(\d{1,3})\s*%", re.I)
UP_RX = re.compile(r"up\s+(?:at\s+least\s+|over\s+|more\s+than\s+)?(\d{1,3})\s*%(?:\s+(?:on\s+the\s+day|today|or\s+more))?", re.I)
CATALYST_TYPES = {
    "earnings": r"earnings", "FDA / clinical": r"\bfda\b|pdufa|clinical|trial\s+(?:data|results)",
    "contract / partnership": r"contract|partnership|agreement|deal\b", "merger / buyout": r"merger|buyout|acquisition|takeover",
    "offering / dilution (negative)": r"offering|dilution|atm\b|shelf", "analyst upgrade": r"upgrade|price\s+target",
    "short squeeze / SI": r"short\s+squeeze|short\s+interest", "sector / hype (AI, crypto)": r"\bai\b|crypto|bitcoin|ev\b|meme",
    "reverse split": r"reverse\s+split", "PR / press release": r"press\s+release|\bpr\b",
}


def price_bucket(lo: float, hi: float) -> str | None:
    if hi <= lo or hi > 500 or lo < 0.5:
        return None
    for name, (a, b) in {"$1-$5": (1, 5), "$2-$10": (2, 10), "$1-$10": (1, 10), "$2-$20": (2, 20),
                         "$1-$20": (1, 20), "$1.50-$20": (1.5, 20), "$5-$20": (5, 20), "$5-$30": (5, 30),
                         "$2-$30": (2, 30), "$10-$50": (10, 50), "$15-$250": (15, 250), "$20-$100": (20, 100)}.items():
        if abs(lo - a) < 0.01 and abs(hi - b) < 0.01:
            return name
    return f"${lo:g}-${hi:g}"


def main() -> None:
    grp = load_groups()
    inv = {r["doc_id"]: r for r in csv.DictReader(open("knowledge/knowledge_inventory.csv")) if r["in_scope"] == "1"}
    con = sqlite3.connect(WORK / "kb.sqlite")
    media = lambda t: "screenshot" if t == "image" else t
    hits: dict[str, dict[str, set]] = defaultdict(lambda: defaultdict(set))  # report -> key -> docs
    meta: dict[str, tuple[str, str]] = {}
    for did, txt in con.execute("select doc_id, text from chunks"):
        r = inv.get(did)
        if not r or not txt:
            continue
        g = grp.get(did, did)
        meta[g] = (r["source_family"], media(r["type"]))
        t = txt
        for m in RANGE_RX.finditer(t):
            win = t[max(0, m.start() - 60): m.end() + 60]
            if PRICE_CTX.search(win) and not re.search(r"strike|premium|contract|option|salary|fee|cost of", win, re.I):
                b = price_bucket(float(m.group(1)), float(m.group(2)))
                if b:
                    hits["price_range"][b].add(g)
        for m in UNDER_RX.finditer(t):
            win = t[max(0, m.start() - 60): m.end() + 40]
            if re.search(r"stock|share|price|penny|trade", win, re.I) and not re.search(r"option|premium|strike", win, re.I):
                v = int(m.group(1))
                if v in (1, 2, 5, 10, 20, 30, 50):
                    hits["price_under"][f"under ${v}"].add(g)
        if re.search(r"avoid\s+(?:expensive|high[\s-]priced)|higher[\s-]priced\s+stocks?\s+(?:only|require|need)|too\s+expensive", t, re.I):
            hits["price_under"]["avoid expensive / high-priced stocks"].add(g)
        for rx in (FLOAT_RX, FLOAT_RX2):
            for m in rx.finditer(t):
                v = float(m.group(1))
                if 0.5 <= v <= 500:
                    b = "≤5M" if v <= 5 else "≤10M" if v <= 10 else "≤20M" if v <= 20 else "≤50M" if v <= 50 else "≤100M" if v <= 100 else ">100M"
                    hits["float"][b].add(g)
        if re.search(r"low[\s-]*float", t, re.I):
            hits["float_topic"]["low-float mentioned"].add(g)
        if re.search(r"float\s+rotation|rotate[sd]?\s+(?:its|the)\s+float", t, re.I):
            hits["float_topic"]["float rotation"].add(g)
        if re.search(r"\bhalt(?:ed|s)?\b|\bluld\b|volatility\s+pause", t, re.I) and re.search(r"float|small[\s-]*cap|penny|squeeze|runner", t, re.I):
            hits["float_topic"]["halts in low-float/small-cap context"].add(g)
        if re.search(r"offering|dilution|shelf|atm\s+offering", t, re.I) and re.search(r"float|small[\s-]*cap|penny", t, re.I):
            hits["float_topic"]["dilution/offering risk"].add(g)
        for m in RVOL_RX.finditer(t):
            v = next(x for x in m.groups() if x)
            v = float(v)
            if 1 < v <= 50:
                b = "2x" if v < 3 else "3x" if v < 5 else "5x" if v < 10 else "10x+"
                hits["rvol"][b].add(g)
        if re.search(r"relative\s+volume|\brvol\b", t, re.I):
            if re.search(r"5[\s-]*min(?:ute)?|intraday|minute", t, re.I):
                hits["rvol_window"]["intraday / 5-min RVOL"].add(g)
            if re.search(r"daily|today|average\s+daily|50[\s-]day|30[\s-]day|14[\s-]day", t, re.I):
                hits["rvol_window"]["daily RVOL vs N-day average"].add(g)
        for name, rx in TIME_WIN.items():
            if rx.search(t):
                hits["time"][name].add(g)
        for m in GAP_RX.finditer(t):
            v = int(m.group(1))
            if 1 <= v <= 300:
                b = "≥4-5%" if v <= 5 else "≥10%" if v <= 10 else "≥20%" if v <= 20 else "≥30%+"
                hits["gap"][b].add(g)
        for m in UP_RX.finditer(t):
            win = t[max(0, m.start() - 50): m.end() + 30]
            if re.search(r"stock|day|today|gain|scan|momentum", win, re.I):
                v = int(m.group(1))
                if 2 <= v <= 500:
                    b = "up ≥4-5%" if v <= 5 else "up ≥10%" if v <= 10 else "up ≥20-30%" if v <= 30 else "up ≥50-100%+"
                    hits["pct_up"][b].add(g)
        if re.search(r"catalyst|news|headline", t, re.I):
            for name, rx in CATALYST_TYPES.items():
                if re.search(rx, t, re.I):
                    hits["catalyst"][name].add(g)
        for sc in ("top gainers", "gappers", "high of day", "relative volume", "halt", "reversal", "former runner",
                   "pre-market", "low float", "momentum"):
            if re.search(sc.replace(" ", r"[\s-]*") + r"[^.]{0,20}scan", t, re.I) or re.search(r"scan[^.]{0,20}" + sc.replace(" ", r"[\s-]*"), t, re.I):
                hits["scanner"][sc].add(g)

    def rows(report: str):
        out = []
        for k, docs in hits[report].items():
            fams = Counter(meta[d][0] for d in docs)
            meds = Counter(meta[d][1] for d in docs)
            out.append({"key": k, "docs": len(docs), "families": len(fams), "media": len(meds),
                        "fam": dict(fams.most_common()), "med": dict(meds.most_common()),
                        "status": status(len(fams), len(meds), len(docs))})
        return sorted(out, key=lambda r: -r["docs"])

    result = {rep: rows(rep) for rep in hits}
    (WORK / "funnel_evidence.json").write_text(json.dumps(result, indent=1, ensure_ascii=False))
    for rep, rs in result.items():
        print(f"\n## {rep}")
        for r in rs[:12]:
            print(f"  {r['key']:<42} docs={r['docs']:<4} fam={r['families']} med={r['media']} {r['status']:<10} {r['fam']}")


if __name__ == "__main__":
    main()
