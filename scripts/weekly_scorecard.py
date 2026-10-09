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
from wt.analytics import funnel_agreement, g2  # noqa: E402
from wt.core.clock import ET  # noqa: E402
from wt.core.config import DATA_DIR, FORWARD_LEDGER, ROOT, ROUTINE_DIR, SCORECARD_DIR  # noqa: E402

FWD = FORWARD_LEDGER
JOURNAL = DATA_DIR / "live/journal.jsonl"
EXPECT = {  # frozen backtest distributions (development span; walk-forward where applicable)
    "B_qqq_qqqm": ("EXP-0005b-g1-etf-dev-realcost", "B|QQQ|noise|M3"),
    "watchlist_bull_flag_atr_M1": ("EXP-0013-r2-atr-stops", "s1_bull_flag_5m_atr|M1|W3"),
    "hod_bull_flag_atr_M1": ("EXP-0014-r2-intraday-hod", "HOD_bull_flag|M1"),
}
BIASED = ("watchlist_bull_flag_atr_M1", "hod_bull_flag_atr_M1")   # DEC-0011 H-LA; restarted as *_v2


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


STAGE_ORDER = ("tickets", "tier2", "charts", "tier1")      # the dry run's latest stage file that holds the funnel


def seen_rows(day_dir: Path) -> list[dict] | None:
    """The dry run's funnel rows for one session, from its latest stage file, or None when it left none."""
    for name in STAGE_ORDER:
        try:
            rows = json.loads((day_dir / f"{name}.json").read_text()).get("reached")
        except (OSError, ValueError):
            continue
        if rows:
            return rows
    return None


def record_rows(day: str) -> list[dict] | None:
    """The forward test's funnel rows for one session, from the after-close pool the trials read, or None."""
    import pandas as pd

    from wt.scanner.explain import explain, from_pool, pool_musts
    from wt.scanner.pool import POOL_DIR
    from wt.specs.loader import load_spec
    path = POOL_DIR / f"{day}.parquet"
    if not path.exists():
        return None
    pool = pd.read_parquet(path)
    if not len(pool):
        return []
    return [{"symbol": r.symbol, "reached": r.reached}
            for r in explain(from_pool(pool), load_spec("SPEC-0001"), pool_musts(pool)).rows]


def agreement() -> list[str]:
    """Section 4: the dry run's funnel against the forward test's, in counts (DEC-0023, section 2). A description:
    any failure here costs the scorecard this section and nothing else."""
    try:
        days = []
        for d in sorted(p for p in ROUTINE_DIR.glob("*") if p.is_dir()):
            a, b = seen_rows(d), record_rows(d.name)
            if a is not None and b is not None:
                days.append(funnel_agreement.compare(a, b))
        t = funnel_agreement.total(days)
    except Exception as e:  # noqa: BLE001
        return ["", "## 4. The dry run against the record", "", f"- Not available this week ({e.__class__.__name__})."]
    L = ["", "## 4. The dry run against the record", "",
         f"Sessions with both a dry run and a forward pool: **{t['sessions']}**. Counts only; the two records are "
         "never merged (DEC-0023)."]
    if t["sessions"]:
        fp = t["first_pick"]
        L += ["", "| Tier | Dry run | Of record | In both |", "|---|---|---|---|",
              f"| Tier 1 names | {t['tier1_seen']} | {t['tier1_record']} | {t['tier1_both']} |",
              f"| Tier 2 names | {t['tier2_seen']} | {t['tier2_record']} | {t['tier2_both']} |", "",
              f"- First pick: same {fp['same']} · different {fp['different']} · on one side only {fp['one_side']} · "
              f"none on either {fp['neither']}"]
    return L


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
    closed = g2.trades(j)                              # once per trade id; adopted orphans never count
    fwd_b_days = {str(x.get("session")) for x in fwd if x.get("strategy") == "B_qqq_qqqm"}
    g = g2.summary(j, {str(d) for d in sessions}, fwd_b_days)
    agree, n_both = g["agreement_agree"] or 0, g["agreement_days"] or 0
    inc = {k: sum(1 for x in j if x["event"] == k) for k in ("loop_error", "END_OF_DAY_NOT_FLAT", "reconcile", "refuse_to_arm")}
    latched = [x for x in j if x["event"] == "trade_closed" and x.get("virtual", {}).get("latched")]
    ps = stats([x["R"] for x in closed if x.get("R") is not None])
    last_va = next((x["virtual"] for x in reversed(j) if "virtual" in x), None)
    L += ["", "## 2. Paper trading — strategy B (Alpaca paper, virtual account)", "",
          f"- Sessions armed: **{g['armed_sessions']}** · clean (count for G2): **{g['sessions']}** · "
          f"trades closed: **{ps['n']}**"
          + (f" · E[R] {ps['E']:+.3f} · win {ps['win']:.0%} · cum {ps['cum']:+.2f}R" if ps["n"] else ""),
          f"- Signal agreement with forward-test B (clean sessions both ran; day-level, provisional until the "
          f"replay harness): **{agree}/{n_both}**" + (f" = {agree / n_both:.0%} (G2 needs ≥90%)" if n_both else " (no overlap yet)"),
          f"- Incidents: loop errors {inc['loop_error']} · not flat at close {inc['END_OF_DAY_NOT_FLAT']} · "
          f"reconcile fixes {inc['reconcile']} · refused to arm {inc['refuse_to_arm']} · latch events {len(latched)}",
          f"- Virtual account: {'equity US$%.2f, settled cash US$%.2f, latched=%s' % (last_va['equity'], last_va['settled_cash'], last_va['latched']) if last_va else '—'}",
          "", "## 3. G2 progress", "",
          f"- Paper trades {ps['n']}/{g2.G2_MIN_TRADES} · clean sessions {g['sessions']}/{g2.G2_MIN_SESSIONS} · "
          f"incident-free streak {g['incident_free_streak']}/{g2.G2_MIN_INCIDENT_FREE} "
          "(a KILL-on, refused or incident session does not count)",
          *agreement(),
          "", "_Rules are frozen; any change requires a new decision record (research/decisions)._"]
    md = "\n".join(L) + "\n"
    out = SCORECARD_DIR / f"scorecard_{today}.md"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(md)
    print(md)
    return md


if __name__ == "__main__":
    main()
