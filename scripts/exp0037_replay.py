"""EXP-0037: three of the options clone's rule gaps, replayed against the frozen clone (DEC-0054). Run once.

    python scripts/exp0037_replay.py nightly     # the host job exp0037, 17:15 New York, Monday to Friday
    python scripts/exp0037_replay.py status      # the list so far, what is fetched, whether it has run (reads only)

Nothing here is run by hand. The host job `exp0037` (wt.ops.schedule) calls `nightly` every weekday evening:

1. Nothing happens while DEC-0054 is not accepted, or once the result exists.
2. The session list is fixed by rule (`wt.options.exp0037.due`): every session after the day DEC-0054 was
   accepted, the first 40, none after 2027-04-30.
3. For each listed session that has closed and is not fetched yet, it fetches the session's inputs into
   data/exp0037/<session>/: SPY and QQQ daily bars up to the session, the session's 1-minute bars, and the 1-minute
   trade bars of each same-day contract a nearest-strike entry could use. It writes their sha256 into
   var/research/exp0037/input_sha256.json. Nothing is replayed and nothing is read back.
4. The evening the list closes, it checks every saved hash again and runs check_first: the switch off against the
   engine as it was before the switches (`PRE_SWITCH`), at 1x and 2x. It stops on any difference. Then it
   replays the control and the three variants at 1x and 2x, writes result.json and report.md into
   var/research/exp0037/ and pages the owner. A pull request then commits them into EXP-0037.

A missed evening is caught up by the next one: every session that has closed and is not fetched is fetched.
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

from wt.core.config import DATA_DIR, STATE_DIR  # noqa: E402
from wt.options import dryrun, exp0037, review, session, variants  # noqa: E402
from wt.options import levels as lv  # noqa: E402
from wt.options.intraday import daily_raw  # noqa: E402
from wt.options.regime import NEW_YORK  # noqa: E402

DEC = ROOT / "research" / "decisions" / "DEC-0054-clone-loophole-trials.md"
CACHE = DATA_DIR / "exp0037"
OUT = STATE_DIR / "research" / "exp0037"
ROOTS = ("SPY", "QQQ")
DATA = "https://data.alpaca.markets"
# The engine as it was before EXP-0037's switches (origin/integration when they were written): check_first's reference.
PRE_SWITCH = "f912d6296aa6966515a6f9bd133cc20e68a543c0"
# The engine the records name: the commit that merged EXP-0037's replay code (#469). The run stops if any of these
# files differs on the host from that commit; a decision record may then name a new one before the run.
ENGINE_COMMIT = "af9b3590e638f52b65af5ba7b28bb9723f83a13a"
ENGINE_FILES = tuple(f"src/wt/options/{m}.py" for m in
                     ("dryrun", "variants", "setups", "regime", "session", "bs", "levels", "intraday"))
GIVE_UP_AFTER = 3         # evenings a session may fail to fetch before it is recorded as skipped
SKIPPED = "skipped"       # the hash file's mark for such a session: listed, never replayed
STRIKE_PAD = 2.0          # strikes fetched beyond the session's range, each side
DAILY_DAYS = 500          # calendar days of daily bars before a session (the levels need a year and more)
VERDICTS = ("supported", "falsified", "too_few")


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


def the_list(decision: Path, now: dt.datetime) -> tuple[dt.date | None, list[dt.date]]:
    """(the day DEC-0054 was accepted, the sessions on the list that have closed so far)."""
    acc = exp0037.accepted_on(decision.read_text())
    if acc is None:
        return None, []
    return acc, exp0037.due(acc, finished_through(now), is_session, [])


# ---------------------------------------------------------------- inputs, one session at a time
def frame_rows(df: Any, sym: str) -> list[dict[str, Any]]:
    part = df[df.symbol == sym]
    return [{"t": t.isoformat(), "o": float(o), "h": float(h), "l": float(low), "c": float(c), "v": float(v),
             "vw": float(vw)}
            for t, o, h, low, c, v, vw in zip(part.t, part.o, part.h, part.l, part.c, part.v, part.vw, strict=True)]


def contracts(root: str, day: dt.date, minute_rows: list[dict[str, Any]]) -> list[str]:
    """Every call and put a nearest-strike entry could use this session, with STRIKE_PAD dollars either side."""
    if not minute_rows:
        return []
    lo = min(float(r["l"]) for r in minute_rows) - STRIKE_PAD
    hi = max(float(r["h"]) for r in minute_rows) + STRIKE_PAD
    return [dryrun.occ(root, day, side, float(k)) for k in range(math.floor(lo), math.ceil(hi) + 1)
            for side in ("call", "put")]


def option_rows(a: Any, sym: str, day: dt.date) -> list[dict[str, Any]]:
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
    return out


def write(p: Path, text: str) -> None:
    """Whole or not at all: a job killed mid-write leaves no truncated file behind."""
    tmp = p.with_name(p.name + ".tmp")
    tmp.write_text(text)
    tmp.replace(p)


def fetch_session(a: Any, d: dt.date, cache: Path = CACHE) -> None:
    """Write one session's inputs to cache/<d>/, the session's files last, so a half-done fetch is redone. Every
    request ends at the session's close, 16:00 New York, never in the future (the consolidated tape's delay)."""
    folder = cache / d.isoformat()
    (folder / "options").mkdir(parents=True, exist_ok=True)
    close = dt.datetime.combine(d, dt.time(16, 0), NEW_YORK).astimezone(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    daily = a.bars(ROOTS, "1Day", (d - dt.timedelta(days=DAILY_DAYS)).isoformat(), close, adjustment="split")
    mins = a.bars(ROOTS, "1Min", f"{d}T08:00:00Z", close, adjustment="split")
    by_root = {r: frame_rows(mins, r) for r in ROOTS}
    if not all(by_root.values()):                 # not published yet: nothing is saved, the next evening retries
        raise RuntimeError(f"no 1-minute bars yet for {d}")
    for r in ROOTS:
        for sym in contracts(r, d, by_root[r]):
            p = folder / "options" / f"{sym}.json"
            if not p.exists():
                write(p, json.dumps(option_rows(a, sym, d)))
    write(folder / "daily.json", json.dumps({r: frame_rows(daily, r) for r in ROOTS}))
    write(folder / "minutes.json", json.dumps(by_root))


def session_hash(d: dt.date, cache: Path = CACHE) -> str:
    """sha256 over every file of one session's inputs, by name and content, in a fixed order."""
    folder = cache / d.isoformat()
    h = hashlib.sha256()
    for f in sorted(p for p in folder.rglob("*") if p.is_file() and p.suffix != ".tmp"):
        h.update(str(f.relative_to(folder)).encode())
        h.update(f.read_bytes())
    return h.hexdigest()


def fetched(d: dt.date, cache: Path = CACHE) -> bool:
    folder = cache / d.isoformat()
    return (folder / "daily.json").exists() and (folder / "minutes.json").exists()


def load_hashes(out: Path = OUT) -> dict[str, str]:
    p = out / "input_sha256.json"
    return dict(json.loads(p.read_text())) if p.exists() else {}


def save_hashes(hashes: dict[str, str], out: Path = OUT) -> None:
    out.mkdir(parents=True, exist_ok=True)
    tmp = out / "input_sha256.json.tmp"
    tmp.write_text(json.dumps(dict(sorted(hashes.items())), indent=1) + "\n")
    tmp.replace(out / "input_sha256.json")


# ---------------------------------------------------------------- the replay
def cached_option(folder: Path) -> Any:
    def get(sym: str) -> list[dryrun.OBar]:
        p = folder / "options" / f"{sym}.json"
        return dryrun.option_bars_from(json.loads(p.read_text())) if p.exists() else []
    return get


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


def inputs(days: list[dt.date], cfg: dict[str, Any], cache: Path = CACHE) -> list[tuple[dt.date, Any, Any, Path]]:
    out = []
    for d in days:
        folder = cache / d.isoformat()
        daily = json.loads((folder / "daily.json").read_text())
        mins = json.loads((folder / "minutes.json").read_text())
        minutes, marks = {}, {}
        for r in ROOTS:
            minutes[r] = dryrun.minute_bars_from(mins.get(r, []), d)
            try:
                levels = lv.levels_for(lv.load_ibkr(daily_raw(daily.get(r, []))).bars, d.isoformat())
            except ValueError:
                continue
            marks[r] = session.marks(levels, cfg["levels"]["names"], cfg["levels"]["strong"],
                                     session.premarket_range(mins.get(r, []), d))
        out.append((d, minutes, marks, folder))
    return out


def replay(engine: Any, data: list[tuple[dt.date, Any, Any, Path]], cfg: dict[str, Any], risk: dict[str, Any],
           macro: list[dict[str, Any]], mult: float, variant: str | None) -> list[dict[str, Any]]:
    trades: list[dict[str, Any]] = []
    for d, minutes, marks, folder in data:
        if not any(minutes.values()):
            continue
        kw = {"variant": variant} if engine is dryrun else {}     # the pre-switch engine has no switch
        res = engine.replay_day(d, minutes, marks, cached_option(folder), cfg, risk, macro, mult, **kw)
        trades += [{**t, "session": d.isoformat()} for t in res.trades]
    return trades


def engine_changed() -> list[str]:
    """The engine files that differ here from ENGINE_COMMIT (all of them when git cannot say)."""
    out = []
    for f in ENGINE_FILES:
        try:
            want = subprocess.run(["git", "-C", str(ROOT), "rev-parse", f"{ENGINE_COMMIT}:{f}"], check=True,
                                  capture_output=True, text=True).stdout.strip()
            have = subprocess.run(["git", "-C", str(ROOT), "hash-object", f], check=True, capture_output=True,
                                  text=True).stdout.strip()
        except (OSError, subprocess.CalledProcessError):
            want, have = "?", ""
        if want != have:
            out.append(f)
    return out


def run(days: list[dt.date], hashes: dict[str, str], cache: Path = CACHE) -> dict[str, Any]:
    changed = engine_changed()
    if changed:
        raise SystemExit(f"the engine differs from {ENGINE_COMMIT[:12]} in {', '.join(changed)}: the replay does "
                         "not run until a decision record names the engine")
    skipped = [d for d in days if hashes.get(d.isoformat()) == SKIPPED]
    days = [d for d in days if d not in skipped]
    for d in days:                                            # the inputs are the ones hashed as each session passed
        if session_hash(d, cache) != hashes.get(d.isoformat()):
            raise SystemExit(f"input hash differs for {d}: the replay does not run")
    cfg = yaml.safe_load((ROOT / "config" / "options_clone.yaml").read_text())
    risk = yaml.safe_load((ROOT / "config" / "risk.yaml").read_text())["O"]
    macro = load_events()
    data = inputs(days, cfg, cache)
    old = pre_switch_engine()                                 # check_first
    for mult in (1.0, 2.0):
        if not exp0037.same_as_pre_switch(replay(old, data, cfg, risk, macro, mult, None),
                                          replay(dryrun, data, cfg, risk, macro, mult, None)):
            raise SystemExit(f"check_first failed at {mult:g}x: the control differs from the pre-switch engine")
    runs: dict[str, dict[str, list[dict[str, Any]]]] = {}     # the four configs
    for name in (None, *variants.VARIANTS):
        runs[name or "control"] = {f"{m:g}x": replay(dryrun, data, cfg, risk, macro, m, name) for m in (1.0, 2.0)}
    c = runs["control"]
    out: dict[str, Any] = {"experiment": "EXP-0037", "decision": "DEC-0054", "sessions": [d.isoformat() for d in days],
                           "skipped": [d.isoformat() for d in skipped], "engine_commit": ENGINE_COMMIT,
                           "input_sha256": hashes, "pre_switch": PRE_SWITCH, "check_first": "passed",
                           "commit": commit(), "verdicts": {}, "figures": {}, "runs": runs}
    for v in variants.VARIANTS:
        r = runs[v]
        out["verdicts"][v] = exp0037.verdict(v, c["1x"], r["1x"], c["2x"], r["2x"])
        added, displaced = exp0037.groups(c["1x"], r["1x"])
        out["figures"][v] = {"added": review.review(list(added)), "displaced": review.review(list(displaced)),
                             "all": review.review(r["1x"])}
    out["figures"]["control"] = {"all": review.review(c["1x"])}
    return out


def commit() -> str:
    try:
        return subprocess.run(["git", "-C", str(ROOT), "rev-parse", "HEAD"], check=True, capture_output=True,
                              text=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return "unknown"


def render(res: dict[str, Any]) -> str:
    lines = ["# EXP-0037: three of the options clone's rule gaps, replayed against the frozen clone: report", "",
             f"- Decision: DEC-0054. {len(res['sessions'])} sessions, {res['sessions'][0]} to {res['sessions'][-1]}, "
             f"SPY and QQQ. Commit `{res['commit'][:12]}`. check_first {res['check_first']} against "
             f"`{res['pre_switch'][:12]}`.",
             "- Read once. A supported variant changes nothing by itself: a further record may freeze it for a new "
             "paper experiment with new trials.", "",
             "| Hypothesis | Variant | Added | Sessions | Displaced | Added mean 1x | Range 1x | Added mean 2x | "
             "Total 1x variant / control | Verdict |", "|---|---|---|---|---|---|---|---|---|---|"]
    for v, x in res["verdicts"].items():
        lines.append(f"| {x['hypothesis']} | {v} | {x['added']} | {x['added_sessions']} | {x['displaced']} | "
                     f"{x['added_mean_1x']} | {x['range_1x']} | {x['added_mean_2x']} | "
                     f"{x['total_1x']['variant']} / {x['total_1x']['control']} | **{x['verdict']}** |")
    if res.get("skipped"):
        lines += ["", f"Listed but never fetched (skipped after {GIVE_UP_AFTER} evenings): {', '.join(res['skipped'])}."]
    lines += ["", "Input sha256 by session: see result.json.", ""]
    return "\n".join(lines)


# ---------------------------------------------------------------- the job
def nightly(a_factory: Any, now: dt.datetime, decision: Path = DEC, cache: Path = CACHE, out: Path = OUT) -> str:
    """One evening's work; returns what it did in one line (no prices, no figures)."""
    if (out / "result.json").exists():
        return "done: the replay has run"
    acc, days = the_list(decision, now)
    if acc is None:
        return "waiting: DEC-0054 is not accepted"
    hashes = load_hashes(out)
    todo = [d for d in days if d.isoformat() not in hashes]
    a = a_factory() if todo else None
    tries = json.loads((out / "tries.json").read_text()) if (out / "tries.json").exists() else {}
    failed: list[str] = []
    for d in todo:                                            # one bad session never holds up the others
        k = d.isoformat()
        try:
            if not fetched(d, cache):
                fetch_session(a, d, cache)
            hashes[k] = session_hash(d, cache)
        except Exception as e:  # noqa: BLE001
            tries[k] = int(tries.get(k, 0)) + 1
            if tries[k] >= GIVE_UP_AFTER:
                hashes[k] = SKIPPED
            else:
                failed.append(f"{k} ({type(e).__name__})")
            out.mkdir(parents=True, exist_ok=True)
            write(out / "tries.json", json.dumps(tries, indent=1) + "\n")
        save_hashes(hashes, out)
    if failed:
        raise RuntimeError(f"fetch failed for {', '.join(failed)}; retried next evening, skipped after "
                           f"{GIVE_UP_AFTER} evenings")
    if not exp0037.complete(days, now.astimezone(NEW_YORK).date()):
        return f"listed {len(days)} of {exp0037.MAX_SESSIONS} sessions; fetched {len(todo)} tonight"
    res = run(days, hashes, cache)
    tmp = out / "result.json.tmp"
    (out / "report.md").write_text(render(res))
    tmp.write_text(json.dumps(res, indent=1, default=str))
    tmp.replace(out / "result.json")                          # last: its presence means the run is complete
    page_done(len(days), [res["verdicts"][v]["verdict"] for v in variants.VARIANTS])
    return f"ran: {len(days)} sessions"


def page_done(n: int, verdicts: list[str]) -> None:
    """Tell the owner the one replay has run. An alert that cannot be sent never changes the result."""
    from wt.ops import alerts
    try:
        alerts.Alerts().once_per_day("exp0037:ran", "EXP-0037: the replay has run",
                                     f"The one replay ran on {alerts.count(n)} sessions. Verdicts: "
                                     + ", ".join(alerts.word(x, VERDICTS, "other") for x in verdicts)
                                     + ". The result waits in the state folder for its pull request.", 3)
    except Exception as e:  # noqa: BLE001
        print(f"alert exp0037:ran: {e!r}")


def status(now: dt.datetime) -> str:
    acc, days = the_list(DEC, now)
    if acc is None:
        return "DEC-0054 is not accepted"
    hashes = load_hashes()
    ran = (OUT / "result.json").exists()
    return (f"accepted {acc}; {len(days)} sessions listed; {sum(d.isoformat() in hashes for d in days)} fetched; "
            f"{'ran' if ran else 'not run'}")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("command", choices=["nightly", "status"])
    args = ap.parse_args(argv)
    now = dt.datetime.now(dt.UTC)
    if args.command == "status":
        print(status(now))
        return 0

    def alpaca() -> Any:
        from wt.data.alpaca import AlpacaREST
        return AlpacaREST(per_minute=150, shared=True)        # counts against the cross-process budget
    from wt.ops.locks import job_lock
    with job_lock("exp0037-replay") as held:                 # a run by hand never overlaps the host job
        if not held:
            print("busy: another exp0037 run holds the lock")
            return 1
        print(nightly(alpaca, now))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
