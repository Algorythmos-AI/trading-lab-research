"""Weekly forward scorecard (plan G2 + DEC-0009).

Compares FORWARD evidence with what the frozen backtests predict, and checks paper-trading health.
  * Forward test (var/forward/forward_trades.jsonl): per candidate n, E[R], win rate, PF, cum R,
    and whether E[R] lies inside the backtest's 95% prediction band for that n (mu +/- 1.96*sd/sqrt(n)).
    A one-sided sequential flag trips if forward E[R] < mu - 2.33*sd/sqrt(n) (early-warning: edge not showing).
    Strategies without a frozen backtest (the round-3 trials `r3:*`, the re-specified `*_v2` flags) show
    "no baseline" instead of an invented one. The two legacy flags with look-ahead filters (DEC-0011 H-LA) are
    listed for the record and marked "biased — not evidence". B's band is drawn from EXP-0005b, which DEC-0011 found
    biased (R-C1); its row says so until the re-run. Ledger rows repeated under the same `key` count once.
  * Paper B (data/live/journal.jsonl): trades, R, signal agreement with forward-test B (same sessions),
    incidents (loop errors, not-flat-at-close, reconcile fixes, latch), G2 progress (>=50 trades, >=30 sessions).
  * Sleeve S (data/live/smallcap_journal.jsonl) against the forward test's record of the same rule (EXP-0051,
    measures.agreement): trades on each side, the same name on the same session, and the difference in entry, exit
    class and R for those pairs. Counts and differences only; the trials are named by id.
  * The stock desk's stops (DEC-0066, DEC-0073) and Gap Hunter's paper R beside its cost haircut (DEC-0074): the
    trade count, mean paper R, H1 R and H2 R with session-resampled 95% intervals, and the haircut in US$ against
    the realised US$. Counts, R and US$ totals only.
Writes var/scorecards/scorecard_<date>.md (and prints it), dated by the US/Eastern session date: the job fires on
Saturday morning in Sydney, which is still Friday's session in New York. Usage: python scripts/weekly_scorecard.py
"""
from __future__ import annotations

import contextlib
import datetime as dt
import json
import math
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from wt.analytics import b_replay, funnel_agreement, g2, s_agreement  # noqa: E402
from wt.risk import cost_haircut, execution_stops, stop_rule  # noqa: E402
from wt.core.clock import ET  # noqa: E402
from wt.core.config import DATA_DIR, FORWARD_LEDGER, ROOT, ROUTINE_DIR, SCORECARD_DIR, STATE_DIR  # noqa: E402

FWD = FORWARD_LEDGER
JOURNAL = DATA_DIR / "live/journal.jsonl"
JOURNAL_S = DATA_DIR / "live/smallcap_journal.jsonl"        # sleeve S's own journal (wt.live.runner_s.JOURNAL)
VA_S = STATE_DIR / "smallcap" / "virtual_account.json"      # its virtual book (wt.live.runner_s.VA_PATH)
EXPECT = {  # frozen backtest distributions (development span; walk-forward where applicable)
    "B_qqq_qqqm": ("EXP-0005b-g1-etf-dev-realcost", "B|QQQ|noise|M3"),
    "watchlist_bull_flag_atr_M1": ("EXP-0013-r2-atr-stops", "s1_bull_flag_5m_atr|M1|W3"),
    "hod_bull_flag_atr_M1": ("EXP-0014-r2-intraday-hod", "HOD_bull_flag|M1"),
}
BIASED = ("watchlist_bull_flag_atr_M1", "hod_bull_flag_atr_M1")   # DEC-0011 H-LA; restarted as *_v2
# Baselines DEC-0011 found biased (R-C1, duplicated ETF bars) and whose re-run waits for the owner: the band is
# still drawn, because it is the only frozen expectation there is, and the row says it is provisional.
PROVISIONAL = {"B_qqq_qqqm": "baseline biased (DEC-0011 R-C1) until its re-run"}


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
        for path in sorted(day_dir.glob(f"*_{name}.json"), reverse=True):      # e.g. 0915_tickets.json
            try:
                rows = json.loads(path.read_text()).get("reached")
            except (OSError, ValueError, AttributeError):
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


def routine_days() -> list[Path]:
    return sorted(p for p in ROUTINE_DIR.glob("*") if p.is_dir())


def day_feed(day_dir: Path) -> str:
    """The stock feed a dry run read: "sip" when any stage file names it, else "hybrid" (the stages before
    DEC-0064 point 9 named hybrid, and the oldest named none)."""
    for path in sorted(day_dir.glob("*.json")):
        try:
            if json.loads(path.read_text()).get("feed") == "sip":
                return "sip"
        except (OSError, ValueError, AttributeError):
            continue
    return "hybrid"


def signal_days(dirs: list[Path] | None = None) -> list[dict]:
    """Per session with both records: how many Set F signals the dry run and the forward test each saw, and how
    many both did. The dry run's come from its 11:31 stage, the forward test's from var/forward/signals/."""
    days = []
    for d in routine_days() if dirs is None else dirs:
        try:
            seen = json.loads((d / "1131_signals.json").read_text())
            record = json.loads((FWD.parent / "signals" / f"{d.name}.json").read_text())
        except (OSError, ValueError):
            continue
        if not isinstance(seen, dict) or not isinstance(record, dict) or seen.get("scan_failed"):
            continue                      # a dry run whose scan had no data saw no signals; that is not a quiet day
        days.append(funnel_agreement.compare_signals(funnel_agreement.seen_pairs(seen.get("signals") or []),
                                                     funnel_agreement.record_pairs(record.get("signals") or {})))
    return days


def stop_line(rows: list[dict], today: dt.date) -> str:
    """Where B's pre-registered stop stands (DEC-0037), or that there is none."""
    rule = stop_rule.load()
    if rule is None:
        return "- Stop rule: **none in config/risk.yaml** (B.stop_rule); the runner does not arm without one"
    return stop_rule.state_line(rule, rows, today)


def replay_line() -> str:
    """B's rule replayed on recorded bars against the runner's journal, in sessions per status (a record: G2's own
    agreement measure above is unchanged)."""
    try:
        recs = []
        for f in sorted((FWD.parent / "replay").glob("*.json")):
            with contextlib.suppress(OSError, ValueError):
                d = json.loads(f.read_text())
                if isinstance(d, dict):
                    recs.append(d)
        a, b = b_replay.tally(recs, "replay_vs_journal"), b_replay.tally(recs, "forward_vs_replay")
        known = len(recs) - a["unknown"]
    except Exception as e:  # noqa: BLE001
        return f"- Replay of B on recorded bars: not available this week ({e.__class__.__name__})."
    return (f"- Replay of B on recorded bars against the runner's journal (sessions recorded {len(recs)}, comparable "
            f"{known}): same bar {a['same']} · no signal on either {a['neither']} · different bar {a['different']} · "
            f"replay only {a['only_first']} · journal only {a['only_second']}. Forward test against the replay: "
            f"same {b['same'] + b['neither']} · not the same {b['different'] + b['only_first'] + b['only_second']}")


def agreement() -> list[str]:
    """Section 4: the dry run's funnel against the forward test's, in counts (DEC-0023, section 2). A description:
    any failure here costs the scorecard this section and nothing else. Sessions the dry run read on SIP alone
    (DEC-0064 point 9) are reported in their own block and never pooled with the hybrid ones."""
    try:
        dirs = routine_days()
        sip = [d for d in dirs if day_feed(d) == "sip"]
        hybrid = [d for d in dirs if d not in sip]
    except Exception as e:  # noqa: BLE001
        return ["", "## 4. The dry run against the record", "", f"- Not available this week ({e.__class__.__name__})."]
    L = ["", "## 4. The dry run against the record", ""]
    L += _agreement_block(hybrid)
    if sip:
        L += ["", f"### From {sip[0].name}, the dry run on SIP only (DEC-0064 point 9; never pooled with the above)", ""]
        L += _agreement_block(sip)
    return L


def _agreement_block(dirs: list[Path]) -> list[str]:
    try:
        days = []
        for d in dirs:
            a, b = seen_rows(d), record_rows(d.name)
            if a is not None and b is not None:
                days.append(funnel_agreement.compare(a, b))
        t = funnel_agreement.total(days)
    except Exception as e:  # noqa: BLE001
        return [f"- Not available this week ({e.__class__.__name__})."]
    L = [f"Sessions with both a dry run and a forward pool: **{t['sessions']}**. Counts only; the two records are "
         "never merged (DEC-0023)."]
    if t["sessions"]:
        fp = t["first_pick"]
        L += ["", "| Tier | Dry run | Of record | In both |", "|---|---|---|---|",
              f"| Tier 1 names | {t['tier1_seen']} | {t['tier1_record']} | {t['tier1_both']} |",
              f"| Tier 2 names | {t['tier2_seen']} | {t['tier2_record']} | {t['tier2_both']} |", "",
              f"- First pick: same {fp['same']} · different {fp['different']} · on one side only {fp['one_side']} · "
              f"none on either {fp['neither']}"]
    try:
        g = funnel_agreement.total_signals(signal_days(dirs))
    except Exception as e:  # noqa: BLE001
        return [*L, f"- Signals: not available this week ({e.__class__.__name__})."]
    L += [f"- Signals (a rule firing on a name, the four Set F trials; sessions with both records: {g['sessions']}): "
          f"dry run {g['signals_seen']} · of record {g['signals_record']} · in both {g['signals_both']}"]
    return L


def s_stop_lines(today: dt.date) -> list[str]:
    """Where the stock desk's own stops stand: its stop rule (DEC-0066) and its execution stops (DEC-0073), on its
    own journal, since the last reset of an execution-stop latch. A failure costs these lines only."""
    try:
        rows = s_agreement.read_rows(JOURNAL_S)
        out = []
        rule = stop_rule.load("S")
        out.append(stop_rule.state_line(rule, rows, today) if rule is not None
                   else "- Stop rule: **none in config/risk.yaml** (S.stop_rule); the desk does not arm without one")
        xr = execution_stops.load("S")
        if xr is None:
            out.append("- Execution stops: **none in config/risk.yaml** (S.execution_stops); the desk does not arm "
                       "without them")
        else:
            history: list[dict] = []
            with contextlib.suppress(OSError, ValueError):
                raw = json.loads(VA_S.read_text())
                if isinstance(raw, dict) and isinstance(raw.get("latch_history"), list):
                    history = raw["latch_history"]
            out.append(execution_stops.state_line(xr, rows, execution_stops.last_reset(history, xr.decision)))
        return out
    except Exception as e:  # noqa: BLE001
        return [f"- The stock desk's stops: not available this week ({e.__class__.__name__})."]


def s_haircut_lines() -> list[str]:
    """Gap Hunter's paper R beside the cost haircut DEC-0074 fixed before its first trade, on the stock desk's own
    journal. A report that gates nothing; a failure costs these lines only."""
    try:
        return cost_haircut.lines(cost_haircut.summary(s_agreement.read_rows(JOURNAL_S)))
    except Exception as e:  # noqa: BLE001
        return [f"- Gap Hunter's cost haircut: not available this week ({e.__class__.__name__})."]


def sleeve_s(fwd: list[dict]) -> list[str]:
    """Section 5: sleeve S against the forward test's record of the same rule (EXP-0051, measures.agreement).
    A description in counts and differences: any failure here costs the scorecard this section and nothing else."""
    head = ["", "## 5. Sleeve S against the forward test (EXP-0051)", ""]
    try:
        a = s_agreement.compare(s_agreement.read_rows(JOURNAL_S), fwd)
    except Exception as e:  # noqa: BLE001
        return [*head, f"- Not available this week ({e.__class__.__name__})."]
    t = a["total"]
    one_side = (f" Sessions only sleeve S ran: {t['s_only_sessions']} · only the forward test ran: "
                f"{t['fwd_only_sessions']} (neither is compared).")
    if not t["sessions"]:
        return [*head, f"No sessions yet: none that sleeve S ({t['s_trial']}) armed and the forward test "
                       f"({t['fwd_trial']}) completed.{one_side}"]
    L = [*head,
         f"Sessions both ran, sleeve S ({t['s_trial']}) and the forward test of the same rule ({t['fwd_trial']}): "
         f"**{t['sessions']}** ({t['first']} → {t['last']}).{one_side} Counts and differences only; a difference is "
         "sleeve S minus the forward test.", "",
         "| | Sleeve S | Forward test | Same name, same session |", "|---|---|---|---|",
         f"| Trades | {t['s_trades']} | {t['fwd_trades']} | {t['both']} |", ""]

    def diff(d: dict, unit: str, places: int) -> str:
        if not d["n"]:
            return "—"
        return (f"mean {d['mean']:+.{places}f}{unit} · mean absolute {d['mean_abs']:.{places}f}{unit} · "
                f"largest {d['max_abs']:.{places}f}{unit} (n={d['n']})")

    if t["both"]:
        L += [f"- Pairs: entry {diff(t['entry_diff_cents'], '¢', 1)}",
              f"- Pairs: exit class same {t['exit_same']} · different {t['exit_different']}"
              + (f" · not classified {t['exit_unclassified']}" if t["exit_unclassified"] else ""),
              f"- Pairs: R {diff(t['r_diff'], 'R', 2)}"]
    else:
        L += ["- No trade in the same name on the same session yet."]
    L += [f"- Sessions with a pair: {t['sessions_with_a_pair']} · sessions sleeve S armed with entries off: "
          f"{t['entries_off_sessions']}"]
    traded = [d for d in a["sessions"] if d["s_trades"] or d["fwd_trades"]]
    if traded:
        L += ["", "| Session (a trade on either side) | Sleeve S | Forward test | Same name, same session |",
              "|---|---|---|---|",
              *(f"| {d['day']} | {d['s_trades']} | {d['fwd_trades']} | {d['both']} |" for d in traded), ""]
    x = t["s_excluded"]
    if any(x.values()):
        L += [f"- Sleeve S closes left out of every count: exit price estimated {x['estimated_exit']} · not the "
              f"rule's own entry {x['not_entry_origin']} · other {x['other_trial'] + x['no_entry_price'] + x['no_r']}"]
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
        if strat in PROVISIONAL and base:
            status += f" — {PROVISIONAL[strat]}"
        L.append(f"| {strat} | {cells} | {bt} | {band} | {status} |")
    L += ["", "_\"no baseline\": the round-3 trials and the re-specified `*_v2` flags have no frozen backtest, by design "
          "(DEC-0010, DEC-0011); their forward record is the only evidence they get._"]
    j = read_jsonl(JOURNAL)
    closed = g2.trades(j)                              # once per trade id; adopted orphans never count
    fwd_b_days = {str(x.get("session")) for x in fwd if x.get("strategy") == "B_qqq_qqqm"}
    replay = b_replay.load_records(FWD.parent / "replay")
    g = g2.summary(j, {str(d) for d in sessions}, fwd_b_days, replay=replay)
    agree, n_both = g["agreement_agree"] or 0, g["agreement_days"] or 0
    harness_agree, harness_n = g["harness_agree"] or 0, g["harness_days"] or 0
    inc = {k: sum(1 for x in j if x["event"] == k) for k in ("loop_error", "END_OF_DAY_NOT_FLAT", "reconcile", "refuse_to_arm")}
    latched = [x for x in j if x["event"] == "trade_closed" and x.get("virtual", {}).get("latched")]
    ps = stats([x["R"] for x in closed if x.get("R") is not None])
    last_va = next((x["virtual"] for x in reversed(j) if "virtual" in x), None)
    L += ["", "## 2. Paper trading — strategy B (Alpaca paper, virtual account)", "",
          f"- Sessions armed: **{g['armed_sessions']}** · clean (count for G2): **{g['sessions']}** · "
          f"trades closed: **{ps['n']}**"
          + (f" · E[R] {ps['E']:+.3f} · win {ps['win']:.0%} · cum {ps['cum']:+.2f}R" if ps["n"] else ""),
          (f"- Agreement at the bar, the frozen rule on recorded bars against the runner (clean sessions with a "
           f"readable replay record, DEC-0037): **{agree}/{n_both}**"
           + (f" = {agree / n_both:.0%} (G2a needs ≥90%)" if n_both else " (no readable session yet)")
           + (f" · {g['agreement_unknown']} session(s) unreadable" if g.get("agreement_unknown") else "")
           + (f" · harness, forward test against replay: {harness_agree}/{harness_n} (a diagnostic, not pooled)"
              if harness_n else "")) if g["agreement_level"] == "bar" else
          (f"- Signal agreement with forward-test B (clean sessions both ran; day-level, provisional until replay "
           f"records exist, DEC-0037): **{agree}/{n_both}**"
           + (f" = {agree / n_both:.0%}" if n_both else " (no overlap yet)")),
          replay_line(),
          f"- Incidents: loop errors {inc['loop_error']} · not flat at close {inc['END_OF_DAY_NOT_FLAT']} · "
          f"reconcile fixes {inc['reconcile']} · refused to arm {inc['refuse_to_arm']} · latch events {len(latched)}",
          f"- Virtual account: {'equity US$%.2f, settled cash US$%.2f, latched=%s' % (last_va['equity'], last_va['settled_cash'], last_va['latched']) if last_va else '—'}",
          stop_line(j, today),
          "", "## 3. G2 progress", "",
          f"- Paper trades {ps['n']}/{g2.G2_MIN_TRADES} · clean sessions {g['sessions']}/{g2.G2_MIN_SESSIONS} · "
          f"incident-free streak {g['incident_free_streak']}/{g2.G2_MIN_INCIDENT_FREE} "
          "(a KILL-on, refused or incident session does not count)",
          *agreement(),
          *sleeve_s(fwd),
          *s_stop_lines(today),
          *s_haircut_lines(),
          "", "_Rules are frozen; any change requires a new decision record (research/decisions)._"]
    md = "\n".join(L) + "\n"
    out = SCORECARD_DIR / f"scorecard_{today}.md"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(md)
    print(md)
    return md


if __name__ == "__main__":
    main()
