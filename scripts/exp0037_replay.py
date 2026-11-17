"""EXP-0037: three of the options clone's rule gaps, replayed against the frozen clone (DEC-0054). Run once.

    python scripts/exp0037_replay.py sessions          # add each session that has closed to README.md's list
    WT_ENV_FILE=~/trading/.env python scripts/exp0037_replay.py run

`sessions` reads no market data: it writes into the README every session after DEC-0054 was accepted that has
closed, until 40 sessions or 2027-04-30, so the list is fixed before anything is replayed. It does nothing while
DEC-0054 is not accepted.

`run` refuses unless DEC-0054 is accepted, the list is complete and no result exists. It then:
1. fetches every input once (SPY and QQQ daily and 1-minute bars, and the 1-minute trade bars of each same-day
   contract a nearest-strike entry could use that session) into data/exp0037/, kept out of git, and writes a
   sha256 per session before any config runs;
2. check_first: replays every session with the switch off and with the engine as it was before the switches
   (`wt.options.dryrun` at PRE_SWITCH), at 1x and 2x, and stops on any difference;
3. replays the control and the three variants at 1x and 2x on the cached data alone;
4. writes result.json and report.md into research/experiments/EXP-0037-clone-loophole-replay/.
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import hashlib
import importlib.util
import json
import math
import subprocess
import sys
import types
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

import yaml  # noqa: E402

from wt.core.config import DATA_DIR  # noqa: E402
from wt.options import dryrun, exp0037, review, session, variants  # noqa: E402
from wt.options import levels as lv  # noqa: E402
from wt.options.intraday import daily_raw  # noqa: E402
from wt.options.regime import NEW_YORK  # noqa: E402

EXP = ROOT / "research" / "experiments" / "EXP-0037-clone-loophole-replay"
DEC = ROOT / "research" / "decisions" / "DEC-0054-clone-loophole-trials.md"
CACHE = DATA_DIR / "exp0037"
ROOTS = ("SPY", "QQQ")
DATA = "https://data.alpaca.markets"
# The engine as it was before EXP-0037's switches (origin/integration when they were written): check_first's reference.
PRE_SWITCH = "f912d6296aa6966515a6f9bd133cc20e68a543c0"
STRIKE_PAD = 2.0          # strikes fetched beyond the session's range, each side


# ---------------------------------------------------------------- the session list
def finished_through(now: dt.datetime) -> dt.date:
    """The last day whose session has closed: today after 16:15 New York, otherwise yesterday."""
    ny = now.astimezone(NEW_YORK)
    return ny.date() if ny.time() >= dt.time(16, 15) else ny.date() - dt.timedelta(days=1)


def is_session(d: dt.date) -> bool:
    try:
        return bool(lv.is_session(d.isoformat()))
    except ValueError:                       # past the calendar's end: not a session it can vouch for
        return False


def add_sessions(readme: Path, decision: Path, now: dt.datetime) -> list[dt.date]:
    acc = exp0037.accepted_on(decision.read_text())
    if acc is None:
        return []
    text = readme.read_text()
    have = exp0037.listed(text)
    new = exp0037.due(acc, finished_through(now), is_session, have)
    if not new:
        return []
    lines = text.rstrip("\n").split("\n")
    lines += [f"- {d.isoformat()}" for d in new]
    readme.write_text("\n".join(lines) + "\n")
    return new


# ---------------------------------------------------------------- inputs
def frame_rows(df: Any, sym: str) -> list[dict[str, Any]]:
    part = df[df.symbol == sym]
    return [{"t": t.isoformat(), "o": o, "h": h, "l": low, "c": c, "v": v, "vw": vw}
            for t, o, h, low, c, v, vw in zip(part.t, part.o, part.h, part.l, part.c, part.v, part.vw, strict=True)]


def fetch_option(a: Any, sym: str, day: dt.date) -> None:
    p = CACHE / "options" / f"{sym}.json"
    if p.exists():
        return
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


def contracts(root: str, day: dt.date, minute_rows: list[dict[str, Any]]) -> list[str]:
    """Every call and put a nearest-strike entry could use this session, with STRIKE_PAD dollars either side."""
    if not minute_rows:
        return []
    lo = min(float(r["l"]) for r in minute_rows) - STRIKE_PAD
    hi = max(float(r["h"]) for r in minute_rows) + STRIKE_PAD
    return [dryrun.occ(root, day, side, float(k)) for k in range(math.floor(lo), math.ceil(hi) + 1)
            for side in ("call", "put")]


def fetch(a: Any, days: list[dt.date]) -> dict[str, str]:
    """Fetch every input once; the sha256 of each session's inputs: the daily bars up to that session (the marks),
    its 1-minute stock bars and every contract file it may read."""
    import pandas as pd
    CACHE.mkdir(parents=True, exist_ok=True)
    daily_p, mins_p = CACHE / "daily.parquet", CACHE / "minutes.parquet"
    first, last = days[0], days[-1]
    if not daily_p.exists():
        a.bars(ROOTS, "1Day", (first - dt.timedelta(days=500)).isoformat(), f"{last}T23:59:00Z",
               adjustment="split").to_parquet(daily_p)
    if not mins_p.exists():
        parts = [a.bars(ROOTS, "1Min", f"{d}T08:00:00Z", f"{d + dt.timedelta(days=1)}T01:00:00Z", adjustment="split")
                 for d in days]
        pd.concat(parts).drop_duplicates(["symbol", "t"]).to_parquet(mins_p)
    mins = pd.read_parquet(mins_p)
    mins["day"] = mins.t.dt.tz_convert(NEW_YORK).dt.date
    daily = pd.read_parquet(daily_p)
    daily_day = daily.t.dt.tz_convert(NEW_YORK).dt.date
    hashes: dict[str, str] = {}
    for d in days:
        today = mins[mins.day == d]
        h = hashlib.sha256()
        for r in ROOTS:
            h.update(json.dumps(frame_rows(daily[daily_day <= d], r), sort_keys=True, default=str).encode())
            rr = frame_rows(today, r)
            h.update(json.dumps(rr, sort_keys=True, default=str).encode())
            for sym in contracts(r, d, rr):
                fetch_option(a, sym, d)
                h.update(sym.encode())
                h.update((CACHE / "options" / f"{sym}.json").read_bytes())
        hashes[d.isoformat()] = h.hexdigest()
    return hashes


def cached_option(sym: str) -> list[dryrun.OBar]:
    p = CACHE / "options" / f"{sym}.json"
    return dryrun.option_bars_from(json.loads(p.read_text())) if p.exists() else []


def load_events() -> list[dict[str, Any]]:
    with open(ROOT / "config" / "events" / "macro_events.csv") as fh:
        return list(csv.DictReader(fh))


def pre_switch_engine() -> types.ModuleType:
    """`wt.options.dryrun` as it was at PRE_SWITCH, loaded beside the current one."""
    src = subprocess.run(["git", "-C", str(ROOT), "show", f"{PRE_SWITCH}:src/wt/options/dryrun.py"],
                         check=True, capture_output=True, text=True).stdout
    spec = importlib.util.spec_from_loader("wt.options._dryrun_pre_switch", loader=None)
    assert spec is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod          # dataclasses resolve their module by name
    exec(compile(src, f"{PRE_SWITCH[:12]}:dryrun.py", "exec"), mod.__dict__)
    return mod


# ---------------------------------------------------------------- the run
def inputs(days: list[dt.date], cfg: dict[str, Any]) -> list[tuple[dt.date, dict[str, Any], dict[str, Any]]]:
    import pandas as pd
    daily = pd.read_parquet(CACHE / "daily.parquet")
    mins = pd.read_parquet(CACHE / "minutes.parquet")
    mins["day"] = mins.t.dt.tz_convert(NEW_YORK).dt.date
    loaded = {r: lv.load_ibkr(daily_raw(frame_rows(daily, r))) for r in ROOTS}
    out = []
    for d in days:
        today = mins[mins.day == d]
        minutes, marks = {}, {}
        for r in ROOTS:
            rr = frame_rows(today, r)
            minutes[r] = dryrun.minute_bars_from(rr, d)
            try:
                levels = lv.levels_for(loaded[r].bars, d.isoformat())
            except ValueError:
                continue
            marks[r] = session.marks(levels, cfg["levels"]["names"], cfg["levels"]["strong"],
                                     session.premarket_range(rr, d))
        out.append((d, minutes, marks))
    return out


def replay(engine: Any, data: list[tuple[dt.date, dict[str, Any], dict[str, Any]]], cfg: dict[str, Any],
           risk: dict[str, Any], macro: list[dict[str, Any]], mult: float, variant: str | None) -> list[dict[str, Any]]:
    trades: list[dict[str, Any]] = []
    for d, minutes, marks in data:
        if not any(minutes.values()):
            continue
        kw = {"variant": variant} if engine is dryrun else {}     # the pre-switch engine has no switch
        res = engine.replay_day(d, minutes, marks, cached_option, cfg, risk, macro, mult, **kw)
        trades += [{**t, "session": d.isoformat()} for t in res.trades]
    return trades


def run(a: Any, days: list[dt.date]) -> dict[str, Any]:
    cfg = yaml.safe_load((ROOT / "config" / "options_clone.yaml").read_text())
    risk = yaml.safe_load((ROOT / "config" / "risk.yaml").read_text())["O"]
    macro = load_events()
    hashes = fetch(a, days)                                   # 1. inputs, hashed and saved before any config runs
    (EXP / "input_sha256.json").write_text(json.dumps(hashes, indent=1) + "\n")
    data = inputs(days, cfg)
    old = pre_switch_engine()                                 # 2. check_first
    for mult in (1.0, 2.0):
        before = replay(old, data, cfg, risk, macro, mult, None)
        now = replay(dryrun, data, cfg, risk, macro, mult, None)
        if not exp0037.same_as_pre_switch(before, now):
            raise SystemExit(f"check_first failed at {mult:g}x: the control differs from the pre-switch engine")
    runs: dict[str, dict[str, list[dict[str, Any]]]] = {}     # 3. the four configs
    for name in (None, *variants.VARIANTS):
        runs[name or "control"] = {f"{m:g}x": replay(dryrun, data, cfg, risk, macro, m, name) for m in (1.0, 2.0)}
    c = runs["control"]
    out: dict[str, Any] = {"experiment": "EXP-0037", "decision": "DEC-0054", "sessions": [d.isoformat() for d in days],
                           "input_sha256": hashes, "pre_switch": PRE_SWITCH, "check_first": "passed",
                           "verdicts": {}, "figures": {}, "runs": runs}
    for v in variants.VARIANTS:
        r = runs[v]
        out["verdicts"][v] = exp0037.verdict(v, c["1x"], r["1x"], c["2x"], r["2x"])
        added, displaced = exp0037.groups(c["1x"], r["1x"])
        out["figures"][v] = {"added": review.review(list(added)), "displaced": review.review(list(displaced)),
                             "all": review.review(r["1x"])}
    out["figures"]["control"] = {"all": review.review(c["1x"])}
    return out


def render(res: dict[str, Any]) -> str:
    lines = ["# EXP-0037: three of the options clone's rule gaps, replayed against the frozen clone: report", "",
             f"- Decision: DEC-0054. {len(res['sessions'])} sessions, {res['sessions'][0]} to {res['sessions'][-1]}, "
             f"SPY and QQQ. check_first {res['check_first']} against `{res['pre_switch'][:12]}`.",
             "- Read once. A supported variant changes nothing by itself: a further record may freeze it for a new "
             "paper experiment with new trials.", "",
             "| Hypothesis | Variant | Added | Sessions | Displaced | Added mean 1x | Range 1x | Added mean 2x | "
             "Total 1x variant / control | Verdict |", "|---|---|---|---|---|---|---|---|---|---|"]
    for v, x in res["verdicts"].items():
        lines.append(f"| {x['hypothesis']} | {v} | {x['added']} | {x['added_sessions']} | {x['displaced']} | "
                     f"{x['added_mean_1x']} | {x['range_1x']} | {x['added_mean_2x']} | "
                     f"{x['total_1x']['variant']} / {x['total_1x']['control']} | **{x['verdict']}** |")
    lines += ["", "Input sha256 by session: see result.json.", ""]
    return "\n".join(lines)


def refusal(exp: Path, decision: Path, now: dt.datetime) -> str | None:
    """Why `run` may not start, or None."""
    acc = exp0037.accepted_on(decision.read_text())
    if acc is None:
        return "DEC-0054 is not accepted"
    days = exp0037.listed((exp / "README.md").read_text())
    if exp0037.due(acc, finished_through(now), is_session, days):
        return "the session list is behind: run `sessions` first"
    if not exp0037.complete(days, now.astimezone(NEW_YORK).date()):
        return f"the list has {len(days)} sessions and is not closed"
    if any((exp / f).exists() for f in ("report.md", "result.json", "input_sha256.json")):
        return "a result exists; a re-run is a new experiment"
    return None


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("command", choices=["sessions", "run"])
    args = ap.parse_args(argv)
    readme = EXP / "README.md"
    now = dt.datetime.now(dt.UTC)
    if args.command == "sessions":
        new = add_sessions(readme, DEC, now)
        print(f"added {len(new)} session(s)" + (": " + ", ".join(d.isoformat() for d in new) if new else ""))
        return 0
    why = refusal(EXP, DEC, now)
    if why:
        print(f"refused: {why}", file=sys.stderr)
        return 1
    days = exp0037.listed(readme.read_text())
    report = EXP / "report.md"
    from wt.data.alpaca import AlpacaREST
    res = run(AlpacaREST(per_minute=150), days)
    (EXP / "result.json").write_text(json.dumps(res, indent=1, default=str))
    report.write_text(render(res))
    print(f"wrote {report}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
