"""Weekly forward scorecard (plan G2 + DEC-0009).

Compares FORWARD evidence with what the frozen backtests predict, and checks paper-trading health.
  * Forward test (var/forward/forward_trades.jsonl): per candidate n, E[R], win rate, PF, cum R,
    and whether E[R] lies inside the backtest's 95% prediction band for that n (mu +/- 1.96*sd/sqrt(n)).
    A one-sided sequential flag trips if forward E[R] < mu - 2.33*sd/sqrt(n) (early-warning: edge not showing).
    Strategies without a frozen backtest (the round-3 trials `r3:*`, the re-specified `*_v2` flags) show
    "no baseline" instead of an invented one. The two legacy flags with look-ahead filters (DEC-0011 H-LA) are
    listed for the record and marked "biased — not evidence". Ledger rows repeated under the same `key` count once.
  * Paper B (data/live/journal.jsonl): trades, R, signal agreement with forward-test B (same sessions),
    incidents (loop errors, not-flat-at-close, reconcile fixes, latch), G2 progress (>=50 trades, >=30 sessions).
Writes var/scorecards/scorecard_<date>.md (and prints it), dated by the US/Eastern session date: the job fires on
Saturday morning in Sydney, which is still Friday's session in New York. Usage: python scripts/weekly_scorecard.py
"""
from __future__ import annotations

import datetime as dt
import json
import math
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from wt.core.clock import ET  # noqa: E402
from wt.core.config import DATA_DIR, FORWARD_LEDGER, ROOT, SCORECARD_DIR  # noqa: E402

FWD = FORWARD_LEDGER
JOURNAL = DATA_DIR / "live/journal.jsonl"
EXPECT = {  # frozen backtest distributions (development span; walk-forward where applicable)
    "B_qqq_qqqm": ("EXP-0005b-g1-etf-dev-realcost", "B|QQQ|noise|M3"),
    "watchlist_bull_flag_atr_M1": ("EXP-0013-r2-atr-stops", "s1_bull_flag_5m_atr|M1|W3"),
    "hod_bull_flag_atr_M1": ("EXP-0014-r2-intraday-hod", "HOD_bull_flag|M1"),
}
BIASED = ("watchlist_bull_flag_atr_M1", "hod_bull_flag_atr_M1")   # DEC-0011 H-LA; restarted as *_v2
G2_MIN_TRADES, G2_MIN_SESSIONS = 50, 30


def read_jsonl(p: Path) -> list[dict]:
    return [json.loads(x) for x in p.read_text().splitlines() if x.strip()] if p.exists() else []


def dedupe(rows: list[dict]) -> list[dict]:
    """First row per `key` (newer ledger rows carry one, and a retried append can repeat it). Rows without a key
    predate it and are all kept."""
    seen, out = set(), []
    for r in rows:
        if r.get("key") is not None:
            k = json.dumps(r["key"], sort_keys=True, default=str)
            if k in seen:
                continue
            seen.add(k)
        out.append(r)
    return out


def session_date(now: dt.datetime) -> dt.date:
    return now.astimezone(ET).date()


def strategies(fwd: list[dict]) -> list[str]:
    """The frozen-baseline candidates first, then every other strategy the ledger has traded or completed."""
    seen = {x["strategy"] for x in fwd if isinstance(x.get("strategy"), str) and "error" not in x
            and (x.get("strategy_marker") or "R" in x)}
    return list(EXPECT) + sorted(seen - set(EXPECT))


def backtest_dist(exp: str, name: str) -> tuple[float, float, int, float]:
    res = json.loads((ROOT / "research/experiments" / exp / "results.json").read_text())["results"][name]
    r = np.array([t["R"] for t in res["trades"]])
    days = len({t["date"] for t in res["trades"]})
    return float(r.mean()), float(r.std(ddof=1)), len(r), len(r) / max(days, 1)


def stats(r: list[float]) -> dict:
    a = np.array(r)
    if not len(a):
        return {"n": 0}
    w, l = a[a > 0], a[a <= 0]
    return {"n": len(a), "E": float(a.mean()), "win": float((a > 0).mean()), "cum": float(a.sum()),
            "pf": float(w.sum() / -l.sum()) if l.sum() < 0 else math.inf}


def main(now: dt.datetime | None = None) -> str:
    today = session_date(now or dt.datetime.now(ET))
    fwd = dedupe(read_jsonl(FWD))
    sessions = sorted({x["session"] for x in fwd if x.get("session_marker")})
    errors = [x for x in fwd if "error" in x]
    L = [f"# Forward scorecard — {today}", "",
         f"Forward-test sessions logged: **{len(sessions)}** "
         f"({sessions[0] if sessions else '—'} → {sessions[-1] if sessions else '—'}); forward-test errors: {len(errors)}", "",
         "## 1. Forward test vs. frozen backtest", "",
         "| Candidate | Fwd n | Fwd E[R] | Win | PF | Cum R | Backtest μ (sd) | 95% band for this n | Status |",
         "|---|---|---|---|---|---|---|---|---|"]
    for strat in strategies(fwd):
        s = stats([x["R"] for x in fwd if x.get("strategy") == strat and x.get("R") is not None])
        base = backtest_dist(*EXPECT[strat]) if strat in EXPECT else None
        bt = f"{base[0]:+.3f} ({base[1]:.2f})" if base else "no baseline"   # no frozen backtest: nothing to compare
        cells = f"{s['n']} | {s['E']:+.3f} | {s['win']:.0%} | {s['pf']:.2f} | {s['cum']:+.2f}" if s["n"] else "0 | — | — | — | —"
        band, status = "—", ("forward record only" if s["n"] else "waiting for trades")
        if strat in BIASED:
            status = "biased — not evidence (DEC-0011)"
        elif s["n"] and base:
            mu, sd = base[:2]
            half = 1.96 * sd / math.sqrt(s["n"])
            lo, hi = mu - half, mu + half
            warn = s["E"] < mu - 2.33 * sd / math.sqrt(s["n"])
            status = "⚠️ BELOW expectation (edge not showing)" if warn else ("✅ inside band" if lo <= s["E"] <= hi else "ℹ️ above band")
            if s["n"] < 20:
                status += " — n<20, too early"
            band = f"[{lo:+.3f}, {hi:+.3f}]"
        L.append(f"| {strat} | {cells} | {bt} | {band} | {status} |")
    j = read_jsonl(JOURNAL)
    closed = [x for x in j if x["event"] == "trade_closed"]
    armed_days = sorted({str(x["day"]) for x in j if x["event"] == "armed"})
    paper_days = {str(x.get("day")) for x in closed}
    fwd_b_days = {x.get("session") for x in fwd if x.get("strategy") == "B_qqq_qqqm"}
    both = set(armed_days) & set(sessions)
    agree = sum(1 for d in both if (d in paper_days) == (d in fwd_b_days))
    inc = {k: sum(1 for x in j if x["event"] == k) for k in ("loop_error", "END_OF_DAY_NOT_FLAT", "reconcile", "refuse_to_arm")}
    latched = [x for x in j if x["event"] == "trade_closed" and x.get("virtual", {}).get("latched")]
    ps = stats([x["R"] for x in closed if x.get("R") is not None])
    last_va = next((x["virtual"] for x in reversed(j) if "virtual" in x), None)
    L += ["", "## 2. Paper trading — strategy B (Alpaca paper, virtual account)", "",
          f"- Sessions armed: **{len(armed_days)}** · trades closed: **{ps['n']}**"
          + (f" · E[R] {ps['E']:+.3f} · win {ps['win']:.0%} · cum {ps['cum']:+.2f}R" if ps["n"] else ""),
          f"- Signal agreement with forward-test B (sessions both ran): "
          f"**{agree}/{len(both)}**" + (f" = {agree / len(both):.0%} (G2 needs ≥90%)" if both else " (no overlap yet)"),
          f"- Incidents: loop errors {inc['loop_error']} · not flat at close {inc['END_OF_DAY_NOT_FLAT']} · "
          f"reconcile fixes {inc['reconcile']} · refused to arm {inc['refuse_to_arm']} · latch events {len(latched)}",
          f"- Virtual account: {'equity US$%.2f, settled cash US$%.2f, latched=%s' % (last_va['equity'], last_va['settled_cash'], last_va['latched']) if last_va else '—'}",
          "", "## 3. G2 progress", "",
          f"- Paper trades {ps['n']}/{G2_MIN_TRADES} · sessions {len(armed_days)}/{G2_MIN_SESSIONS} · "
          f"zero-incident requirement: {'met so far' if inc['loop_error'] == 0 and inc['END_OF_DAY_NOT_FLAT'] == 0 else 'NOT met — review incidents'}",
          "", "_Rules are frozen; any change requires a new decision record (research/decisions)._"]
    md = "\n".join(L) + "\n"
    out = SCORECARD_DIR / f"scorecard_{today}.md"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(md)
    print(md)
    return md


if __name__ == "__main__":
    main()
