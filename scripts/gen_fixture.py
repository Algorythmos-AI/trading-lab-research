"""Writes dashboard/test/fixtures/snapshot.v3.json: the v2 fixture plus every v3 section, built by the real view
functions from synthetic, seeded data (no real trades, symbols beyond B's allowlist, or owner text).

    python scripts/gen_fixture.py            # rewrite the fixture
    python scripts/gen_fixture.py --check    # exit 1 if the committed fixture is stale (CI)
The same data at full list sizes is the payload-budget worst case (tests/unit/test_contract_v3.py).
"""
from __future__ import annotations

import datetime as dt
import json
import random
import sys
import tempfile
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from wt.analytics import ops_view, performance, risk_view, today_view  # noqa: E402
from wt.ops import audit, publish, thresholds  # noqa: E402

V2 = ROOT / "dashboard" / "test" / "fixtures" / "snapshot.json"
V3 = ROOT / "dashboard" / "test" / "fixtures" / "snapshot.v3.json"
NOW = dt.datetime(2026, 10, 2, 20, 0, tzinfo=dt.UTC)


def synthetic(n_trades: int = 24, days: int = 14, n_alerts: int = 6, seed: int = 7) -> dict[str, Any]:
    rng = random.Random(seed)
    today = dt.date(2026, 10, 2)
    sessions = {today - dt.timedelta(days=i): object() for i in range(days + 7)
                if (today - dt.timedelta(days=i)).weekday() < 5}
    trades, eq = [], 600.0
    for i in range(n_trades):
        day = (today - dt.timedelta(days=n_trades - i)).isoformat()
        r = round(rng.choice([-1.0, -1.0, -0.4, 0.6, 1.2, 2.0]) + rng.uniform(-0.1, 0.1), 3)
        eq = round(eq * (1 + r * 0.01), 2)
        trades.append({"event": "trade_closed", "day": day, "symbol": "QQQM", "qty": 2, "entry": 200.0,
                       "exit": round(200 + r, 2), "stop": 199.0, "R": r, "reason": "target" if r > 0 else "stop",
                       "origin": "entry", "exit_price_estimated": i == 3, "booked": True, "virtual": {"equity": eq}})
    runs = []
    for i in range(days):
        d = today - dt.timedelta(days=days - 1 - i)
        if d.weekday() < 5:
            for job in ("routine", "paper-b", "forward"):
                st = "refused" if (job == "paper-b" and i % 5 == 0) else "ok"
                runs.append({"job": job, "status": st, "started": f"{d}T13:30:00+00:00"})
        for h in range(0, 24, 6):
            runs.append({"job": "dashboard", "status": "failed" if (i, h) == (4, 6) else "ok",
                         "started": f"{d}T{h:02d}:05:00+00:00"})
    account = {"start_equity": 600.0, "equity": eq, "high_water": max(eq, 612.0), "latched": False,
               "day_pnl": {today.isoformat(): -3.1, (today - dt.timedelta(days=2)).isoformat(): 4.0},
               "trades_by_day": {today.isoformat(): 1},
               "latch_history": [{"at": "2026-09-22T01:00:00+00:00", "reset_by": "owner"}]}
    alerts = [{"at": f"2026-10-0{1 + i % 2}T{10 + i:02d}:00:00+00:00", "key": f"job:{i}",
               "event": "fired" if i % 2 == 0 else "resolved", "title": "Job late" if i % 2 == 0 else "Job recovered",
               "priority": 4 if i % 2 == 0 else 2} for i in range(n_alerts)]
    with tempfile.TemporaryDirectory() as tmp:
        log = Path(tmp) / "events.jsonl"
        audit.append("kill_on", path=log, now=dt.datetime(2026, 9, 29, 12, tzinfo=dt.UTC))
        dep = Path(tmp) / "20260929T064229Z.json"
        dep.write_text(json.dumps({"to": "f53c9aa0000000000000", "smoke_ok": True}))
        rows = audit.read(log)
        trail = ops_view.audit_trail(deploys=[dep], account=account, runs=runs, alert_history=alerts,
                                     audit_rows=rows)
        daily = Path(tmp) / "daily"
        daily.mkdir()
        (daily / "2026-10-01.json").write_text(json.dumps({"equity_pct": 0.8, "cum_r": 3.0, "trades": n_trades - 1,
                                                           "firing": 0, "kill": True, "head": "f53c9aa00000",
                                                           "preflight_failed": 1, "g2_trades": n_trades - 1}))
        dig = ops_view.digest({"equity_pct": round((eq / 600 - 1) * 100, 2), "cum_r": 3.4, "trades": n_trades,
                               "firing": 1, "kill": True, "head": "f53c9aa00000", "preflight_failed": 0,
                               "g2_trades": n_trades}, daily, today)
    curve = performance.curve(trades)
    journal: list[dict[str, Any]] = []                     # the same trades as the runner would have journaled them
    for i, t in enumerate(trades):
        tid = f"{t['day']}-B-QQQM-0"
        journal += [{"event": "armed", "ts": f"{t['day']}T12:30:00+00:00", "day": t["day"], "kill": False,
                     "entries_off": []},
                    {"event": "decision", "ts": f"{t['day']}T14:30:05+00:00", "would_signal": True, "blockers": [],
                     "signal_t": f"{t['day']} 14:29:00+00:00", "trigger": 400.01, "stop": 398.0, "runner_acts": True},
                    {"event": "entry_placed", "ts": f"{t['day']}T14:30:06+00:00", "trigger": 200.0, "stop": 199.0,
                     "target": 202.0, "qty": 2},
                    {"event": "entry_filled", "ts": f"{t['day']}T14:31:{i % 60:02d}+00:00", "trade_id": tid, "qty": 2,
                     "price": 200.0},
                    {**{k: v for k, v in t.items() if k != "virtual"}, "ts": f"{t['day']}T19:45:00+00:00",
                     "trade_id": tid},
                    {"event": "session_end", "ts": f"{t['day']}T20:00:05+00:00", "outcome": "traded"}]
    journal += [{"event": "armed", "ts": f"{today}T12:30:00+00:00", "day": today.isoformat(), "kill": False,
                 "entries_off": []},
                {"event": "decision", "ts": f"{today}T14:30:05+00:00", "would_signal": True, "blockers": [],
                 "signal_t": f"{today} 14:29:00+00:00", "trigger": 400.01, "stop": 398.0, "runner_acts": True},
                {"event": "entry_placed", "ts": f"{today}T14:30:06+00:00", "trigger": 200.0, "stop": 199.0,
                 "target": 202.0, "qty": 2},
                {"event": "entry_filled", "ts": f"{today}T14:31:00+00:00", "trade_id": f"{today}-B-QQQM-0", "qty": 2,
                 "price": 200.02}]
    dd_pct, dd_r = performance.max_drawdown(curve)
    return {
        "risk": risk_view.view(today, account, kill=True, root=ROOT),
        "perf": {"stats": performance.stats(trades, sessions=days + 20), "sessions": days + 20,
                 "min_trades": thresholds.MIN_TRADES_STATS, "min_sessions": thresholds.MIN_SESSIONS_SHARPE,
                 "max_dd_pct": dd_pct, "max_dd_r": dd_r, "curve": curve, "histogram": performance.histogram(trades),
                 "band": {"available": False, "reason": "no expectation band until the DEC-0011 re-runs"}},
        "blotter": ops_view.blotter(trades),
        "today": today_view.view(journal, today, account),
        "sla": ops_view.sla(runs, today, sessions, days=days),
        "audit": {"chain_ok": True, "chain_bad_seq": None, "rows": len(rows), "bad_lines": 0, "events": trail},
        "alerts_history": ops_view.alert_log(alerts),
        "digest": dig,
    }


def build_v3(v2: dict[str, Any], views: dict[str, Any]) -> dict[str, Any]:
    san = publish.Sanitizer(lambda x: x, None, strict=False)
    views = dict(views)
    history = views.pop("alerts_history")
    out = dict(v2)
    for k, v in views.items():
        out[k] = san.apply(publish.ALLOW[k], v)
    out["alerts"] = {**(v2.get("alerts") or {}), "history": san.apply(publish.ALLOW["alerts"]["history"], history)}
    out["schema_version"] = publish.SCHEMA_VERSION
    ops = out["ops"] = {**out["ops"]}
    ops["forward"] = {**ops["forward"], "books": san.apply(publish.ALLOW["ops"]["forward"]["books"], BOOKS)}
    ops["paper"] = {**ops["paper"], "g2": {**ops["paper"]["g2"], "unchecked_sessions": 1}}
    routine = ops["routine"] = {**ops["routine"], "near": san.apply(publish.ALLOW["ops"]["routine"]["near"], NEAR)}
    routine["stages"] = [{**st, **({"scan_failed": False} if st.get("stats") else {})} for st in routine["stages"]]
    ops["forward"]["funnel"] = san.apply(publish.ALLOW["ops"]["forward"]["funnel"], FUNNEL)
    return out


_BOOK = {"strategy": "r3:F:GG-1", "hyp": "HYP-0010", "sessions": 9, "errors": 0, "first": "2026-09-28", "last": "2026-10-08",
         "trades": 3, "total_r": -0.8, "max_dd_r": 1.8, "last_trade": "2026-10-07", "risk_usd": 6, "nominal_usd": -4.8,
         "signals": 4, "refused": 1, "shadow_resolved": 1}
BOOKS = [   # the trial books (v3 additions the v2 fixture cannot carry): one row with no admission step, one with none traded
    {**_BOOK, "strategy": "B_qqq_qqqm", "hyp": None, "trades": 5, "total_r": 1.2, "max_dd_r": 0.9, "risk_usd": None,
     "nominal_usd": None, "signals": None, "refused": None, "shadow_resolved": None},
    _BOOK,
    {**_BOOK, "strategy": "r3:MP-1", "hyp": "HYP-0014", "trades": 0, "total_r": 0.0, "max_dd_r": 0.0, "last_trade": None,
     "nominal_usd": 0.0, "signals": 2, "refused": 2, "shadow_resolved": 0}]


def main(argv: list[str]) -> int:
    v2 = json.loads(V2.read_text())
    body = json.dumps(build_v3(v2, synthetic()), indent=1, sort_keys=True) + "\n"
    # the risk rows carry source-file hashes; keep the fixture stable across unrelated code edits
    snap = json.loads(body)
    for row in snap["risk"]["limits"]:
        row["source_sha"] = "000000000000"
    snap["risk"]["sources"] = {k: "000000000000" for k in snap["risk"]["sources"]}
    body = json.dumps(snap, indent=1, sort_keys=True) + "\n"
    if "--check" in argv:
        if not V3.exists() or V3.read_text() != body:
            print(f"{V3.relative_to(ROOT)} is stale: run python scripts/gen_fixture.py", file=sys.stderr)
            return 1
        return 0
    V3.write_text(body)
    print(f"wrote {V3.relative_to(ROOT)} ({len(body)} bytes)")
    return 0


# The newest dry-run stage's near misses and the newest funnel of record: counts, tickers, prices, closed codes.
NEAR = {"total": 3, "rows": [{"symbol": "ZZZA", "price": 4.13, "reason": "catalyst_missing"},
                             {"symbol": "ZZZB", "price": 9.5, "reason": "float"},
                             {"symbol": "ZZZC", "price": 2.84, "reason": "rvol"}]}
FUNNEL = {"session": "2026-09-28", "pool": {"universe": 4393, "snapshot_symbols": 812, "kept": 31},
          "counts": {"n_kept": 31, "n_passed": 2, "n_tier1": 2, "n_chart_ok": 1, "n_tier2": 1, "n_primary": 1,
                     "drop_catalyst_missing": 22, "drop_float": 14, "drop_rvol": 9}}


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
