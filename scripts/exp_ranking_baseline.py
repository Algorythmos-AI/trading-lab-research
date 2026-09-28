"""EXP-0002: ranking-engine baseline on recent sessions.

For each session: build 09:25 candidates, rank Top-10, then (using data AFTER the scan, for scoring only)
measure how many of the day's eventual top-5 gainers in the $2-30 band (close vs prior close, day
volume >= 1M) were on the Top-10, versus a naive "top-10 gappers at 09:25" list. Also records the
prefilter candidate count and API cost. Usage: python scripts/exp_ranking_baseline.py N_SESSIONS
"""
from __future__ import annotations

import datetime as dt
import json
import sys
import time
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from wt.core.config import DATA_DIR, ROOT, load_yaml  # noqa: E402
from wt.data.alpaca import AlpacaREST  # noqa: E402
from wt.data.edgar import SharesOutstanding  # noqa: E402
from wt.data.universe import load_daily  # noqa: E402
from wt.scanner.features import PMCache, build_candidates  # noqa: E402
from wt.scanner.ranking import rank  # noqa: E402

EXP = ROOT / "research" / "experiments" / "EXP-0002-ranking-baseline"


def main(n: int) -> None:
    EXP.mkdir(parents=True, exist_ok=True)
    a = AlpacaREST()
    daily = load_daily()
    last = max(daily.date)
    cal = a.calendar((last - dt.timedelta(days=200)).isoformat(), last.isoformat())
    sessions = [d for d in cal.date if d <= last]
    test_days = sessions[-n:]
    cache, so, cfg = PMCache(), SharesOutstanding(), load_yaml("ranking.yaml")
    (EXP / "config.yaml").write_text(json.dumps({"ranking": cfg, "sessions": [str(d) for d in test_days]}, indent=1))
    done_f = EXP / "days.jsonl"
    rows = [json.loads(x) for x in done_f.read_text().splitlines()] if done_f.exists() else []
    done = {r["date"] for r in rows}
    for d in test_days:
        if str(d) in done:
            continue
        t0 = time.time()
        cands = build_candidates(d, daily, sessions, a, cache, so, with_quotes=True)
        cache.save()
        top, dropped = rank(cands, cfg)
        # naive baseline: top-10 by 09:25 gap among price 2-30
        naive = sorted([c for c in cands if 2 <= c.price <= 30], key=lambda c: -c.gap_pct)[:10]
        i = sessions.index(d)
        day = daily[daily.date == d].set_index("symbol")
        prev = daily[daily.date == sessions[i - 1]].set_index("symbol")
        j = day.join(prev[["c"]].rename(columns={"c": "pc"}), how="inner")
        j = j[(j.pc.between(2, 30)) & (j.v >= 1_000_000)]
        winners = list((j.c / j.pc - 1).sort_values(ascending=False).head(5).index)
        ts, ns = {t["symbol"] for t in top}, {c.symbol for c in naive}
        rows.append({"date": str(d), "n_candidates": len(cands), "n_top": len(top), "winners": winners,
                     "top10": [t["symbol"] for t in top], "hit_rank": len(ts & set(winners)),
                     "hit_naive": len(ns & set(winners)), "secs": round(time.time() - t0, 1)})
        print(rows[-1], flush=True)
        with open(done_f, "a") as fh:
            fh.write(json.dumps(rows[-1]) + "\n")
    res = pd.DataFrame(rows)
    summary = {"sessions": len(res), "avg_candidates": round(res.n_candidates.mean(), 1),
               "avg_top_size": round(res.n_top.mean(), 1),
               "winners_captured_rank": int(res.hit_rank.sum()), "winners_captured_naive": int(res.hit_naive.sum()),
               "winners_total": int(5 * len(res)),
               "days_with_>=1_winner_rank": int((res.hit_rank > 0).sum()),
               "days_with_>=1_winner_naive": int((res.hit_naive > 0).sum())}
    (EXP / "results.json").write_text(json.dumps({"summary": summary, "days": rows}, indent=1))
    print(summary)


if __name__ == "__main__":
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 60)
