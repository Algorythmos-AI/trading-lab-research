"""The replay harness against sleeve Q on real sessions (DEC-0066 section 5, item 2).

Recorded consolidated-tape data for a fixed list of sessions is replayed through the unchanged `wt.live.runner_b`
with `wt.live.replay.BarFillBroker`, and what the runner did is set beside what the nightly forward test recorded
for the QQQ rule on the same sessions. Nothing here sends an order: the broker is the simulated one.

The match rule, fixed before any ledger row was read:
  signal   the replayed runner's first would-be signal is on the same bar as the forward test's, or neither has one;
  trade    the replayed runner has a filled entry if and only if the forward test booked a trade;
  exit     when both traded, the exit is of the same class: target, stop, or end of day.
The two are different machines on purpose: the forward test simulates QQQ itself with a fixed 2R target; the runner
trades QQQM through a quote ratio, sells its target at the bid (DEC-0063) and cancels an unfilled entry at 15:30. A
mismatch is reported, never tuned away.

No result is computed or printed: no R, no price, no profit. Statuses, bar indexes and exit classes only.

  record   PYTHONPATH=src python scripts/replay_check_b.py record 2026-11-05 2026-11-18 [--quotes 2026-11-09,...]
  check    PYTHONPATH=src python scripts/replay_check_b.py check forward.json
`forward.json`: {session: {"signal_bar": int | null, "traded": bool, "exit": str | null}}, read from the host's
forward ledger and replay records by hand.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Any

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from wt.core.clock import ET, et, to_utc_iso  # noqa: E402
from wt.core.config import DATA_DIR  # noqa: E402
from wt.data.alpaca import DATA  # noqa: E402

TAPES = DATA_DIR / "replay_tapes" / "sleeve_q"
SYMBOLS = ("QQQ", "QQQM")
EXIT_CLASS = {"target": "target", "stop": "stop", "eod_flatten": "end_of_day", "eod_market": "end_of_day",
              "eod_verify": "end_of_day"}


def as_of_quote(a: Any, sym: str, t: dt.datetime) -> dict[str, Any] | None:
    """The last NBBO quote at or before `t` (looking back one minute), or None."""
    j = a.get(f"{DATA}/v2/stocks/quotes", {"symbols": sym, "start": to_utc_iso(t - dt.timedelta(seconds=60)),
                                           "end": to_utc_iso(t), "limit": 1, "sort": "desc", "feed": "sip"})
    q = (j.get("quotes") or {}).get(sym) or []
    if not q or not q[0].get("bp") or not q[0].get("ap"):
        return None
    return {"t": q[0]["t"], "bp": float(q[0]["bp"]), "ap": float(q[0]["ap"])}


def record(a: Any, sessions: dict[dt.date, tuple[str, str]], first: dt.date, last: dt.date, quote_days: list[dt.date],
           step_s: int = 20) -> None:
    """Save minute bars for every session from fourteen before `first` to `last`, and, for `quote_days`, the NBBO as
    of every `step_s` seconds of the session (QQQM all day; QQQ for the two minutes after each half-hour mark)."""
    TAPES.mkdir(parents=True, exist_ok=True)
    days = sorted(sessions)
    start = days[max(0, days.index(first) - 15)]
    for sym in SYMBOLS:
        b = a.bars([sym], "1Min", to_utc_iso(et(start, "09:30")), to_utc_iso(et(last, sessions[last][1])), feed="sip")
        b[["t", "o", "h", "l", "c", "v"]].to_parquet(TAPES / f"bars_{sym}.parquet")
        print(f"{sym}: {len(b)} minute bars from {start}", flush=True)
    for d in quote_days:
        o, c = et(d, sessions[d][0]), et(d, sessions[d][1])
        for sym in SYMBOLS:
            f = TAPES / f"quotes_{sym}_{d}.parquet"
            if f.exists():
                continue
            rows, t = [], o
            while t <= c:
                mins = (t - o).total_seconds() / 60
                if sym == "QQQM" or (mins >= 30 and mins % 30 < 2):
                    q = as_of_quote(a, sym, t)
                    if q is not None:
                        rows.append(q)
                t += dt.timedelta(seconds=step_s)
            pd.DataFrame(rows, columns=["t", "bp", "ap"]).drop_duplicates("t").to_parquet(f)
            print(f"{d} {sym}: {len(rows)} quotes", flush=True)


def load_tape() -> Any:
    from wt.live.replay import Tape
    bars = {s: pd.read_parquet(TAPES / f"bars_{s}.parquet") for s in SYMBOLS}
    quotes = {}
    for s in SYMBOLS:
        parts = [pd.read_parquet(f) for f in sorted(TAPES.glob(f"quotes_{s}_*.parquet"))]
        if parts:
            quotes[s] = pd.concat(parts, ignore_index=True)
    return Tape(bars, quotes)


def replay_day(day: dt.date, sessions: dict[dt.date, tuple[str, str]], tape: Any) -> dict[str, Any]:
    """One session through the unchanged runner, in a throwaway state folder. Returns statuses only."""
    from wt.live import runner_b
    from wt.live.replay import BarFillBroker, ReplayClock, ReplayREST
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        runner_b.LIVE, runner_b.KILL, runner_b.MIN_FREE_GB = root / "live", root / "KILL", 0.0
        import wt.risk.mandate as mandate
        mandate.LEGACY_FILE = root / "legacy_positions.yaml"
        runner_b.events.coverage_ok = lambda d: True           # the macro calendar's reach is about today, not then
        clock = ReplayClock(dt.datetime.combine(day, dt.time(8, 0), tzinfo=ET))
        broker = BarFillBroker(clock, tape, sessions, quote_fill_age_s=60.0)
        out = sys.stdout
        try:
            sys.stdout = open(os.devnull, "w")                  # the runner echoes its journal: never to the screen
            runner_b.run(day, broker=broker, rest=ReplayREST(clock, tape, sessions), now_fn=clock.now,
                         sleep_fn=clock.sleep)
        finally:
            sys.stdout.close()
            sys.stdout = out
        rows = [json.loads(x) for x in (root / "live" / "journal.jsonl").read_text().splitlines()]
    first = next((r for r in rows if r["event"] == "decision" and r.get("would_signal")), None)
    closed = [r for r in rows if r["event"] == "trade_closed"]
    return {"signal_bar": first.get("signal_bar") if first else None,
            "entry_placed": any(r["event"] == "entry_placed" for r in rows),
            "traded": any(r["event"] == "entry_filled" for r in rows),
            "exit": EXIT_CLASS.get(closed[0].get("reason"), "other") if closed else None,
            "blocked": sorted({b.split(":")[0] for r in rows if r["event"] == "blocked" for b in r.get("blockers", [])}),
            "errors": sum(1 for r in rows if r["event"] in ("loop_error", "data_timeout")),
            "flat": broker.positions() == [] and broker.open_orders() == []}


def compare(forward: dict[str, Any], replay: dict[str, Any]) -> dict[str, str]:
    f_exit = EXIT_CLASS.get(forward.get("exit") or "", None)
    out = {"signal": "same" if forward.get("signal_bar") == replay["signal_bar"] else "different",
           "trade": "same" if bool(forward.get("traded")) == replay["traded"] else "different"}
    if forward.get("traded") and replay["traded"]:
        out["exit"] = "same" if f_exit == replay["exit"] else "different"
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("record")
    r.add_argument("first")
    r.add_argument("last")
    r.add_argument("--quotes", default="")
    c = sub.add_parser("check")
    c.add_argument("forward")
    args = ap.parse_args()
    if args.cmd == "record":
        from wt.data.alpaca import AlpacaREST
        a = AlpacaREST(per_minute=100)
        first, last = dt.date.fromisoformat(args.first), dt.date.fromisoformat(args.last)
        cal = a.calendar((first - dt.timedelta(days=40)).isoformat(), (last + dt.timedelta(days=10)).isoformat())
        sessions = {x.date: (str(x.open)[:5], str(x.close)[:5]) for x in cal.itertuples()}
        (TAPES).mkdir(parents=True, exist_ok=True)
        (TAPES / "sessions.json").write_text(json.dumps({str(k): v for k, v in sessions.items()}))
        record(a, sessions, first, last, [dt.date.fromisoformat(x) for x in args.quotes.split(",") if x])
        return 0
    os.environ["MODE"] = "paper"                               # the runner's own start check; the broker is simulated
    forward = json.loads(Path(args.forward).read_text())
    sessions = {dt.date.fromisoformat(k): tuple(v) for k, v in json.loads((TAPES / "sessions.json").read_text()).items()}
    tape = load_tape()
    result = {}
    for day in sorted(forward):
        rep = replay_day(dt.date.fromisoformat(day), sessions, tape)
        result[day] = {"forward": forward[day], "replay": rep, "match": compare(forward[day], rep)}
        print(day, json.dumps(result[day]), flush=True)
    tally: dict[str, dict[str, int]] = {}
    for v in result.values():
        for k, s in v["match"].items():
            tally.setdefault(k, {}).setdefault(s, 0)
            tally[k][s] += 1
    print(json.dumps({"sessions": len(result), "tally": tally}, indent=1))
    (TAPES / "result.json").write_text(json.dumps({"sessions": result, "tally": tally}, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
