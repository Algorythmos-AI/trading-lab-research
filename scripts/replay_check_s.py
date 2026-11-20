"""Sleeve S on real recorded sessions: the mechanics only (DEC-0066 section 5, item 4).

A fixed list of sessions from the forward period is recorded from the consolidated tape and replayed through the
unchanged `wt.live.runner_s` with the simulated bar-fill broker, dummy keys, a stand-in ACCEPTED record and a
throwaway state folder. Nothing here can send an order.

What is recorded for a session: the names the causal scan could ever admit that day (the day's low at least 2.8%
under its open and a range touching US$15 to US$250: a superset, since a name admitted at any scan ends the day at
least 3% under its open), their minute bars for that session and the one before, and their daily bars. Quotes are
recorded in a second pass, as the NBBO as of each instant, only for the names the first pass saw signal.

What is reported: counts. Scans, universe size, signals by what blocked them, orders placed, filled and cancelled by
reason, closes by exit class, errors, and whether the book was flat at the end. By construction the report carries
no R, no price, no profit and no equity, and the journal is never printed: family S's trials are judged only on
paper sessions after acceptance (DEC-0066), and this is not one.

  record   PYTHONPATH=src python scripts/replay_check_s.py record 2026-11-05 2026-11-18
  run      PYTHONPATH=src python scripts/replay_check_s.py run            (first pass: no quotes)
  quotes   PYTHONPATH=src python scripts/replay_check_s.py quotes         (record quotes for the signals seen)
  run      PYTHONPATH=src python scripts/replay_check_s.py run            (second pass)
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
import tempfile
from collections import Counter
from pathlib import Path
from typing import Any

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from wt.core.clock import ET, et, to_utc_iso  # noqa: E402
from wt.core.config import DATA_DIR  # noqa: E402
from wt.data.alpaca import DATA  # noqa: E402

TAPES = DATA_DIR / "replay_tapes" / "sleeve_s"
DROP_SUPERSET = 0.028
EXIT_CLASS = {"target": "target", "stop": "stop", "time_stop_5m": "stagnation", "eod_flatten": "end_of_day",
              "eod_market": "end_of_day", "eod_verify": "end_of_day", "adopted_exit": "adopted"}
KEYS = {"APCA_S_KEY_ID": "REPLAY-NO-KEY", "APCA_S_SECRET_KEY": "replay-no-secret"}
BAR_COLS = ["symbol", "t", "o", "h", "l", "c", "v"]


def sessions_file() -> dict[dt.date, tuple[str, str]]:
    raw = json.loads((TAPES / "sessions.json").read_text())
    return {dt.date.fromisoformat(k): (v[0], v[1]) for k, v in raw.items()}


def record(a: Any, first: dt.date, last: dt.date) -> None:
    from wt.live import scan_s
    TAPES.mkdir(parents=True, exist_ok=True)
    cal = a.calendar((first - dt.timedelta(days=70)).isoformat(), (last + dt.timedelta(days=10)).isoformat())
    sessions = {x.date: (str(x.open)[:5], str(x.close)[:5]) for x in cal.itertuples()}
    (TAPES / "sessions.json").write_text(json.dumps({str(k): v for k, v in sessions.items()}))
    days = [d for d in sorted(sessions) if first <= d <= last]
    (TAPES / "days.json").write_text(json.dumps([str(d) for d in days]))
    daily_f = TAPES / "daily.parquet"
    if not daily_f.exists():
        symbols = scan_s.tradable_symbols(a.assets("active"))
        d = a.bars(symbols, "1Day", to_utc_iso(et(first - dt.timedelta(days=50), "00:00")),
                   to_utc_iso(et(last, "23:59")), feed="sip", adjustment="split")
        d[BAR_COLS].to_parquet(daily_f)
        print(f"daily bars: {len(d)} rows, {d.symbol.nunique()} symbols", flush=True)
    daily = pd.read_parquet(daily_f)
    daily["day"] = pd.to_datetime(daily.t, utc=True).dt.tz_convert(ET).dt.date
    ordered = sorted(sessions)
    for d in days:
        f = TAPES / f"minutes_{d}.parquet"
        if f.exists():
            continue
        today = daily[daily.day == d]
        sup = sorted(today[((today.o - today.l) / today.o >= DROP_SUPERSET) & (today.l <= 250.0) & (today.h >= 15.0)].symbol)
        prev = ordered[ordered.index(d) - 1]
        parts = []
        if sup:
            for day in (prev, d):
                parts.append(a.bars(sup, "1Min", to_utc_iso(et(day, sessions[day][0])), to_utc_iso(et(day, sessions[day][1])),
                                    feed="sip"))
        m = pd.concat(parts, ignore_index=True) if parts else pd.DataFrame(columns=BAR_COLS)
        m[BAR_COLS].to_parquet(f)
        print(f"{d}: superset {len(sup)} names, {len(m)} minute bars", flush=True)


def tape_for(d: dt.date) -> Any:
    from wt.live.replay import Tape
    m = pd.read_parquet(TAPES / f"minutes_{d}.parquet")
    bars = {str(s): g.drop(columns="symbol").reset_index(drop=True) for s, g in m.groupby("symbol")}
    daily = pd.read_parquet(TAPES / "daily.parquet")
    daily = daily[daily.symbol.isin(bars)]
    # a recorded daily bar is stamped at its session's midnight in New York, which is what the replay client expects
    day_frames = {str(s): g.drop(columns="symbol").reset_index(drop=True) for s, g in daily.groupby("symbol")}
    quotes = {}
    qf = TAPES / f"quotes_{d}.parquet"
    if qf.exists():
        q = pd.read_parquet(qf)
        quotes = {str(s): g.drop(columns="symbol").reset_index(drop=True) for s, g in q.groupby("symbol")}
    return Tape(bars, quotes, day_frames)


def replay_day(d: dt.date, sessions: dict[dt.date, tuple[str, str]]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """(the counts for the report, the signals seen as symbol and time for the quote pass)."""
    from wt.live import runner_s
    from wt.live.replay import BarFillBroker, ReplayClock, ReplayREST
    tape = tape_for(d)
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        record_file = root / "DEC-0066.md"
        record_file.write_text("- **Status: ACCEPTED** (a stand-in for the replay; the real record is read by no one here)\n")
        state = root / "smallcap"
        runner_s.DIR, runner_s.PLANS, runner_s.KILL = state, state / "plans", state / "KILL"
        runner_s.VA_PATH, runner_s.JOURNAL = state / "virtual_account.json", root / "journal.jsonl"
        runner_s.RECORD, runner_s.MIN_FREE_GB = record_file, 0.0
        clock = ReplayClock(dt.datetime.combine(d, dt.time(9, 25), tzinfo=ET))
        broker = BarFillBroker(clock, tape, sessions)
        out = sys.stdout
        try:
            sys.stdout = open(os.devnull, "w")                  # the runner echoes its journal: never to the screen
            runner_s.run(d, poll_s=10.0, broker=broker, rest=ReplayREST(clock, tape, sessions), now_fn=clock.now,
                         sleep_fn=clock.sleep, environ=KEYS)
        finally:
            sys.stdout.close()
            sys.stdout = out
        rows = [json.loads(x) for x in (root / "journal.jsonl").read_text().splitlines()]
    ev = Counter(r["event"] for r in rows)
    end = next((r for r in rows if r["event"] == "session_end"), {})
    armed = next((r for r in rows if r["event"] == "armed"), {})
    blocked = Counter(b.split(":")[0] for r in rows if r["event"] == "signal_blocked" for b in r.get("blockers", []))
    signals = [{"symbol": r["symbol"], "signal_t": r["signal_t"]} for r in rows
               if r["event"] in ("signal_blocked", "entry_placed", "entry_not_placed")]
    counts = {"names_on_tape": len(tape.bars), "entries_off": len(armed.get("entries_off", [])),
              "scans": end.get("scans"), "universe": end.get("universe"),
              "signals": ev["signal_blocked"] + ev["entry_placed"] + ev["entry_not_placed"],
              "signals_missed": ev["signal_missed"], "blocked_by": dict(sorted(blocked.items())),
              "entries_placed": ev["entry_placed"], "entries_filled": ev["entry_filled"],
              "entries_cancelled": dict(sorted(Counter(r.get("why") for r in rows if r["event"] == "entry_cancelled").items())),
              "closes": dict(sorted(Counter(EXIT_CLASS.get(r.get("reason"), "other") for r in rows
                                            if r["event"] == "trade_closed").items())),
              "errors": {k: ev[k] for k in ("loop_error", "held_error", "data_timeout", "scan_failed") if ev[k]},
              "not_flat_rows": ev["END_OF_DAY_NOT_FLAT"], "session_end": bool(end),
              "flat": broker.positions() == [] and broker.open_orders() == []}
    return counts, signals


def record_quotes(a: Any, sessions: dict[dt.date, tuple[str, str]]) -> None:
    """The NBBO as of each instant, for each signal the first pass saw: every 10 seconds for half an hour from the
    end of the signal's minute, then every minute to the close."""
    seen = json.loads((TAPES / "signals.json").read_text())
    for day, sigs in sorted(seen.items()):
        f = TAPES / f"quotes_{day}.parquet"
        if f.exists() or not sigs:
            continue
        d = dt.date.fromisoformat(day)
        close = et(d, sessions[d][1])
        rows = []
        for s in sigs:
            t = pd.Timestamp(s["signal_t"]).to_pydatetime() + dt.timedelta(seconds=60)
            fine_until = t + dt.timedelta(minutes=30)
            while t <= close:
                j = a.get(f"{DATA}/v2/stocks/quotes", {"symbols": s["symbol"], "start": to_utc_iso(t - dt.timedelta(seconds=60)),
                                                       "end": to_utc_iso(t), "limit": 1, "sort": "desc", "feed": "sip"})
                q = (j.get("quotes") or {}).get(s["symbol"]) or []
                if q and q[0].get("bp") and q[0].get("ap"):
                    rows.append({"symbol": s["symbol"], "t": q[0]["t"], "bp": float(q[0]["bp"]), "ap": float(q[0]["ap"])})
                t += dt.timedelta(seconds=10 if t < fine_until else 60)
        pd.DataFrame(rows, columns=["symbol", "t", "bp", "ap"]).drop_duplicates(["symbol", "t"]).to_parquet(f)
        print(f"{day}: {len(sigs)} signals, {len(rows)} quotes", flush=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("record")
    r.add_argument("first")
    r.add_argument("last")
    sub.add_parser("run")
    sub.add_parser("quotes")
    args = ap.parse_args()
    if args.cmd in ("record", "quotes"):
        from wt.data.alpaca import AlpacaREST
        a = AlpacaREST(per_minute=100)
        if args.cmd == "record":
            record(a, dt.date.fromisoformat(args.first), dt.date.fromisoformat(args.last))
        else:
            record_quotes(a, sessions_file())
        return 0
    os.environ["MODE"] = "paper"                               # the runner's own start check; the broker is simulated
    sessions = sessions_file()
    report, seen = {}, {}
    for day in json.loads((TAPES / "days.json").read_text()):
        counts, signals = replay_day(dt.date.fromisoformat(day), sessions)
        report[day], seen[day] = counts, signals
        print(day, json.dumps(counts), flush=True)
    with_quotes = any(TAPES.glob("quotes_*.parquet"))
    if not with_quotes:
        (TAPES / "signals.json").write_text(json.dumps(seen, indent=1))
    (TAPES / f"report_{'with' if with_quotes else 'no'}_quotes.json").write_text(json.dumps(report, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
