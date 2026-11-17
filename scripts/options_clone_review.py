"""The options clone's nightly review (DEC-0030): the day per name, and every setup's figures so far.

    python scripts/options_clone_review.py [--date YYYY-MM-DD]

Figures under the $2.00 cap (to 2026-10-29) and under the $15.00 cap (2026-10-30 to 2026-11-04, EXP-0028) and under the
$5.00 spread cap (from 2026-11-05, EXP-0029) are kept apart.
Reads the clone's journal, the day's decision lines and its plan files; writes var/options/review/<date>.json and
prints a summary. The `quality` block is the trade-quality scorecard (wt.options.scorecard): a line per entry and the
day's line, which tells a quiet day (every bar of the entry window has a decision line) from a day with gaps.
Counts, statistics and R-like figures only. It never trades and never writes a verdict (options_clone_verdict.py).
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import yaml  # noqa: E402

from wt.core.config import CONFIG_DIR, DATA_DIR, STATE_DIR  # noqa: E402
from wt.options import levels as lv  # noqa: E402
from wt.options import review, scorecard, session  # noqa: E402

JOURNAL = DATA_DIR / "live" / "options_journal.jsonl"
OPT = STATE_DIR / "options"


def jsonl(path: Path) -> list[dict]:
    out = []
    try:
        with open(path) as fh:
            for line in fh:
                try:
                    out.append(json.loads(line))
                except ValueError:
                    continue
    except FileNotFoundError:
        pass
    return out


def plans(state: Path) -> list[dict]:
    out = []
    for f in sorted((state / "plans").glob("plan_*.json")) if (state / "plans").exists() else []:
        try:
            out.append(json.loads(f.read_text()))
        except (OSError, ValueError):
            continue
    return out


def quality(day: str, today: list[dict], decisions: list[dict], state: Path, cfg: dict) -> dict:
    """The scorecard, or the error that stopped it: it never costs the review its other figures."""
    try:
        try:
            market_open = lv.is_session(day)
        except ValueError:                                  # past the exchange calendar: score it as a session
            market_open = True
        ck = session.clock(day, cfg["day"])
        bars = scorecard.expected_bars(ck.first_entry, ck.last_entry, int(cfg["bars"]["minutes"]))
        return scorecard.scorecard(day, today, decisions, plans(state), bars, float(cfg["exits"]["premium_stop_pct"]),
                                   market_open)
    except Exception as e:  # noqa: BLE001 — a report, never a reason to lose the night's figures
        return {"error": e.__class__.__name__, "day": None, "trades": []}


def build(day: str, journal: Path = JOURNAL, state: Path = OPT, cfg: dict | None = None) -> dict:
    cfg = cfg if cfg is not None else yaml.safe_load((CONFIG_DIR / "options_clone.yaml").read_text())
    rows = jsonl(journal)
    trades = [r for r in rows if r.get("event") == "trade_closed"]
    today = [r for r in rows if str(r.get("ts", ""))[:10] == day or str(r.get("trade_id", ""))[:10] == day]
    decisions = jsonl(state / "decisions" / f"{day}.jsonl")
    return {
        "session": day,
        "names": review.day_line(decisions),
        "quality": quality(day, today, decisions, state, cfg),
        "today": {"trades": sum(1 for r in trades if review.session_of(r) == day),
                  "latched": sorted({str(r.get("kind")) for r in today if r.get("event") == "latched"}),
                  "feed_unfit": [r.get("why") for r in today if r.get("event") == "feed_unfit"],
                  "pages": sorted({str(r.get("key")) for r in today if r.get("event") == "page"}),
                  "flat": next((r.get("flat") for r in today if r.get("event") == "verify_flat"), None)},
        "setups": review.review(review.in_window(trades, "old")),
        "cap15": review.review(review.in_window(trades, "cap15"), review.TRIALS),
        "spread5": review.review(review.in_window(trades, "spread5"), review.TRIALS),
        # EXP-0039 (DEC-0056): counts only until its report is written, so no running figure is shown or stored
        "no_oi": {k: {"trades": f["trades"], "sessions": f["sessions"]}
                  for k, f in review.review(review.in_window(trades, "no_oi"), review.TRIALS).items()},
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", default=dt.datetime.now(ZoneInfo("America/New_York")).date().isoformat())
    a = ap.parse_args(argv)
    doc = build(a.date)
    out = OPT / "review" / f"{a.date}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc, indent=1))
    for name, n in sorted(doc["names"].items()):
        print(f"{name}: {n['bars']} bars, {n['setups']} setups, {n['entered']} entered, refused by {n['refused_by']}, "
              f"first refused by {n['refused_for']}")
    for s, f in [*doc["setups"].items(), *((f"{w} {k}", v) for w in ("cap15", "spread5") for k, v in doc[w].items())]:
        print(f"{s}: {f['trades']} trades in {f['sessions']} sessions, mean on premium {f.get('mean_rop')}, "
              f"range by session {f.get('ci_session')}, verdict {f['verdict']} ({'; '.join(f['why'])})")
    for k, f in doc["no_oi"].items():
        print(f"no_oi {k}: {f['trades']} trades in {f['sessions']} sessions (EXP-0039: counts only until its report)")
    q = doc["quality"]["day"]
    if q is None:
        print(f"quality: not scored ({doc['quality'].get('error')})")
        return 0
    print(f"quality: {q['verdict']}, {q['entries']} entered, {q['bar_revised']} bars revised, "
          f"{q['arm_retries']} arm tries{' (gave up)' if q['arm_gave_up'] else ''}, "
          f"{q['feed_unfit']} feed-unfit, {q['log_fault']} log faults, names from {q['names_source']}, "
          f"bars missing {q['bars_missing'] or 'none'} of {q['bars_expected']}")
    for t in doc["quality"]["trades"]:
        print(f"{t['trade_id']} {t['root']} {t['setup']} {t['side']} bar {t['signal_bar']}: final {t['bar_final']}, "
              f"quote {t['quote_age_s']} s old, spread {t['spread_pct']}% of mid, fill {t['fill_vs_ask_pct']}% vs ask "
              f"and {t['fill_vs_mid_pct']}% vs mid, delta {t['delta']}, feed {t['feed']}, "
              f"{t['signal_to_fill_min']} min to fill, exit {t['exit_reason']}, R {t['r']}"
              + (f", not logged: {', '.join(t['missing'])}" if t["missing"] else ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
