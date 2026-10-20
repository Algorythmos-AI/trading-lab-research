"""EXP-0025: the options clone's one historical dry run on SPY and QQQ (DEC-0031). Run once.

    WT_ENV_FILE=~/trading/.env python scripts/options_clone_dry_run.py

Reads the consolidated tape's daily and 1-minute bars for SPY and QQQ and each same-day contract's 1-minute trade
bars from the broker's market data (cached under data/exp0025/, kept out of git), replays every session of the span
with `wt.options.dryrun` at 1x and 2x the assumed spread, and writes report.md and result.json into
research/experiments/EXP-0025-options-clone-dry-run/. It refuses to write over a report that exists.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import sys
from collections import Counter
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

import pandas as pd  # noqa: E402
import yaml  # noqa: E402

from wt.core.config import DATA_DIR  # noqa: E402
from wt.options import dryrun, review, session  # noqa: E402
from wt.options import levels as lv  # noqa: E402
from wt.options.intraday import daily_raw  # noqa: E402
from wt.options.regime import NEW_YORK  # noqa: E402

OUT = ROOT / "research" / "experiments" / "EXP-0025-options-clone-dry-run"
CACHE = DATA_DIR / "exp0025"
ROOTS = ("SPY", "QQQ")
FIRST, LAST = "2026-03-02", "2026-10-16"
DATA = "https://data.alpaca.markets"


def sessions() -> list[dt.date]:
    out, d = [], dt.date.fromisoformat(FIRST)
    while d <= dt.date.fromisoformat(LAST):
        if lv.is_session(d.isoformat()):
            out.append(d)
        d += dt.timedelta(days=1)
    return out


def rows(df: pd.DataFrame, sym: str) -> list[dict[str, Any]]:
    part = df[df.symbol == sym]
    return [{"t": t.isoformat(), "o": o, "h": h, "l": low, "c": c, "v": v, "vw": vw}
            for t, o, h, low, c, v, vw in zip(part.t, part.o, part.h, part.l, part.c, part.v, part.vw, strict=True)]


def stock_data(a: Any) -> tuple[pd.DataFrame, pd.DataFrame]:
    CACHE.mkdir(parents=True, exist_ok=True)
    daily_p, mins_p = CACHE / "daily.parquet", CACHE / "minutes.parquet"
    if not daily_p.exists():
        a.bars(ROOTS, "1Day", "2025-01-01", LAST + "T23:59:00Z", adjustment="split").to_parquet(daily_p)
    if not mins_p.exists():
        parts = []
        start = dt.date.fromisoformat(FIRST)
        while start <= dt.date.fromisoformat(LAST):
            end = min(start + dt.timedelta(days=31), dt.date.fromisoformat(LAST) + dt.timedelta(days=1))
            parts.append(a.bars(ROOTS, "1Min", f"{start}T08:00:00Z", f"{end}T01:00:00Z", adjustment="split"))
            start = end
        pd.concat(parts).drop_duplicates(["symbol", "t"]).to_parquet(mins_p)
    return pd.read_parquet(daily_p), pd.read_parquet(mins_p)


def option_bars(a: Any, sym: str, day: dt.date) -> list[dict[str, Any]]:
    p = CACHE / "options" / f"{sym}.json"
    if p.exists():
        return list(json.loads(p.read_text()))
    p.parent.mkdir(parents=True, exist_ok=True)
    start = dt.datetime.combine(day, dt.time(9, 30), NEW_YORK).astimezone(dt.UTC)
    end = dt.datetime.combine(day, dt.time(16, 0), NEW_YORK).astimezone(dt.UTC)
    params = {"symbols": sym, "timeframe": "1Min", "limit": "10000",
              "start": start.strftime("%Y-%m-%dT%H:%M:%SZ"), "end": end.strftime("%Y-%m-%dT%H:%M:%SZ")}
    out: list[dict[str, Any]] = []
    while True:
        j = a.get(f"{DATA}/v1beta1/options/bars", params)
        out += (j.get("bars") or {}).get(sym, []) if isinstance(j, dict) else []
        token = j.get("next_page_token") if isinstance(j, dict) else None
        if not token:
            break
        params["page_token"] = token
    p.write_text(json.dumps(out))
    return out


def load_events() -> list[dict[str, Any]]:
    import csv
    with open(ROOT / "config" / "events" / "macro_events.csv") as fh:
        return list(csv.DictReader(fh))


def run(a: Any) -> dict[str, Any]:
    cfg = yaml.safe_load((ROOT / "config" / "options_clone.yaml").read_text())
    risk = yaml.safe_load((ROOT / "config" / "risk.yaml").read_text())["O"]
    macro = load_events()
    daily, mins = stock_data(a)
    mins["day"] = mins.t.dt.tz_convert(NEW_YORK).dt.date
    loaded = {r: lv.load_ibkr(daily_raw(rows(daily, r))) for r in ROOTS}
    days = sessions()
    out: dict[str, Any] = {"span": [FIRST, LAST], "sessions": len(days), "roots": list(ROOTS), "runs": {}}
    per_day: dict[float, list[tuple[str, float]]] = {}
    for mult in (1.0, 2.0):
        trades: list[dict[str, Any]] = []
        left: Counter[str] = Counter()
        skipped: Counter[str] = Counter()
        day_pnl: list[tuple[str, float]] = []
        for d in days:
            today = mins[mins.day == d]
            minutes, marks = {}, {}
            for r in ROOTS:
                rr = rows(today, r)
                minutes[r] = dryrun.minute_bars_from(rr, d)
                try:
                    levels = lv.levels_for(loaded[r].bars, d.isoformat())
                except ValueError:
                    skipped[f"levels:{r}"] += 1
                    continue
                marks[r] = session.marks(levels, cfg["levels"]["names"], cfg["levels"]["strong"],
                                         session.premarket_range(rr, d))
            if not any(minutes.values()):
                skipped["no-stock-bars"] += 1
                continue
            res = dryrun.replay_day(d, minutes, marks, lambda s, d=d: dryrun.option_bars_from(option_bars(a, s, d)),
                                    cfg, risk, macro, mult)
            trades += res.trades
            left += res.left_out
            day_pnl.append((d.isoformat(), res.pnl))
        per_day[mult] = day_pnl
        figs = review.review(trades)
        signals = {s: left.get(f"signal:{s}", 0) for s in review.SETUPS}
        no_bar = {s: left.get(f"no-option-bar:{s}", 0) for s in review.SETUPS}
        for s in review.SETUPS:
            figs[s]["signals"] = signals[s]
            figs[s]["no_option_bar"] = no_bar[s]
            figs[s]["reading"] = signals[s] == 0 or no_bar[s] <= signals[s] / 5      # DEC-0031: a fifth at most
        out["runs"][f"{mult:g}x"] = {"figures": figs, "left_out": dict(sorted(left.items())),
                                     "skipped": dict(skipped), "trades": trades}
    # the latches a live clone would have stopped on (counted, the replay went on)
    week: dict[str, float] = {}
    for d, p in per_day[1.0]:
        k = "%d-W%02d" % dt.date.fromisoformat(d).isocalendar()[:2]
        week[k] = week.get(k, 0.0) + p
    cum = peak = 0.0
    dd_days = 0
    for _, p in per_day[1.0]:
        cum += p
        peak = max(peak, cum)
        dd_days += cum - peak <= -float(risk["drawdown_latch"])
    out["latches_1x"] = {"weeks_at_or_below_week_latch": sum(v <= -float(risk["week_loss_latch"]) for v in week.values()),
                         "days_beyond_drawdown_latch": dd_days,
                         "days_at_day_latch": sum(p <= -float(risk["day_loss_latch"]) for _, p in per_day[1.0])}
    h = hashlib.sha256()
    for f in sorted(CACHE.rglob("*")):
        if f.is_file():
            h.update(f.name.encode())
            h.update(f.read_bytes())
    out["data_hash"] = h.hexdigest()[:16]
    return out


def render(res: dict[str, Any]) -> str:
    lines = ["# EXP-0025: the options clone, one historical dry run on SPY and QQQ: report", "",
             f"- Decision: DEC-0031 (written and merged before this ran). Span {res['span'][0]} to {res['span'][1]}, "
             f"{res['sessions']} sessions, {', '.join(res['roots'])}. Data hash `{res['data_hash']}`.",
             "- Exploratory: it changes no number of the clone and is not evidence for DEC-0030's verdict.",
             "- Unit: return on premium from the contracts' 1-minute trade bars, half the assumed spread paid each "
             "way, $0.03 a contract each way. Ranges: bootstrap of the mean by session (5000, seed 7).", ""]
    for run, body in res["runs"].items():
        lines += [f"## Spread {run}", "", "| Setup | Signals | No option bar | Trades | Sessions | Mean on premium | "
                  "Range by session | Halves | Win rate | Profit factor | Total $ | Max drawdown $ | Reading |",
                  "|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
        for s, f in body["figures"].items():
            reading = "yes" if f.get("reading", True) else "no (over a fifth left out)"
            lines.append(f"| {s} | {f.get('signals', '')} | {f.get('no_option_bar', '')} | {f['trades']} | "
                         f"{f['sessions']} | {f.get('mean_rop')} | {f.get('ci_session')} | "
                         f"{f.get('first_half_mean')} / {f.get('second_half_mean')} | {f.get('win_rate')} | "
                         f"{f.get('profit_factor')} | {f.get('total_usd')} | {f.get('max_drawdown_usd')} | {reading} |")
        lines += ["", "Exits: " + json.dumps(body["figures"]["all"].get("exits", {})),
                  "", "Left out or refused: " + json.dumps(body["left_out"]), ""]
    lines += ["## Latches a live clone would have stopped on (1x)", "", json.dumps(res["latches_1x"]), "",
              "## Reading it", "",
              "- This span was not used to choose any of the clone's numbers, but it is history: the clone's own "
              "paper record (EXP-0024) is the only evidence for its verdict.",
              "- Delta, volume and open interest could not be checked on history; the strike is the one nearest the "
              "stock. Trade bars are a rough stand-in for fills in a same-day contract's fast minutes; the 2x run "
              "is the guard, not a cure.", ""]
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=OUT)
    args = ap.parse_args(argv)
    report = args.out / "report.md"
    if report.exists():
        print(f"refused: {report} exists; a re-run is a new experiment", file=sys.stderr)
        return 1
    from wt.data.alpaca import AlpacaREST
    res = run(AlpacaREST(per_minute=150))
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "result.json").write_text(json.dumps(res, indent=1, default=str))
    report.write_text(render(res))
    print(f"wrote {report}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
