"""The options clone's nightly review (DEC-0030): the day per name, and every setup's figures so far.

    python scripts/options_clone_review.py [--date YYYY-MM-DD]

Figures under the $2.00 cap (to 2026-10-29) and under the $15.00 cap (2026-10-30 to 2026-11-04, EXP-0028) and under the
$5.00 spread cap (from 2026-11-05, EXP-0029) are kept apart.
Reads the clone's journal and the day's decision lines; writes var/options/review/<date>.json and prints a summary.
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

from wt.core.config import DATA_DIR, STATE_DIR  # noqa: E402
from wt.options import review  # noqa: E402

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


def build(day: str, journal: Path = JOURNAL, state: Path = OPT) -> dict:
    rows = jsonl(journal)
    trades = [r for r in rows if r.get("event") == "trade_closed"]
    today = [r for r in rows if str(r.get("ts", ""))[:10] == day or str(r.get("trade_id", ""))[:10] == day]
    return {
        "session": day,
        "names": review.day_line(jsonl(state / "decisions" / f"{day}.jsonl")),
        "today": {"trades": sum(1 for r in trades if review.session_of(r) == day),
                  "latched": sorted({str(r.get("kind")) for r in today if r.get("event") == "latched"}),
                  "feed_unfit": [r.get("why") for r in today if r.get("event") == "feed_unfit"],
                  "pages": sorted({str(r.get("key")) for r in today if r.get("event") == "page"}),
                  "flat": next((r.get("flat") for r in today if r.get("event") == "verify_flat"), None)},
        "setups": review.review(review.in_window(trades, "old")),
        "cap15": review.review(review.in_window(trades, "cap15"), review.TRIALS),
        "spread5": review.review(review.in_window(trades, "spread5"), review.TRIALS),
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
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
