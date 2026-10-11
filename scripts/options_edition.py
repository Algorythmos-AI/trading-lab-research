#!/usr/bin/env python
"""Build the Options edition after the close, and send it.

    python scripts/options_edition.py --pulls DIR --data DIR --dry-run
    python scripts/options_edition.py --transcript FILE --since-ts 2026-10-12T21 --data DIR --send

The pulls are the broker's read-only data results for each name in config/options_desk.yaml: daily bars, hourly
bars and a volatility snapshot. They come either as files (`--pulls`: <NAME>.daily.json, <NAME>.hourly.json,
<NAME>.snapshot.json) or out of the transcript of the session that made the tool calls (`--transcript`).

`--data` is where the run keeps its state between nights: levels/<session>.json, iv_history.csv, scorecard.csv.
Running the same session twice adds no rows.

Exit codes:
  0  written and, with --send, stored (or the same edition was already there)
  1  a data problem for at least one name, or the dashboard did not store the edition
  2  nothing new: a weekend or holiday with the next session already built. Nothing is sent.
  3  --send without its secrets: built and written, not sent

One command does what the routine did in two (build, then publish), so: a name that could not be built does not
stop the edition going out without it, and the exit is still 1; when no name could be built nothing is sent.

Sending signs with RADAR_INGEST_SECRET under key id "radar" (the key the dashboard lets publish research
editions) and passes VERCEL_AUTOMATION_BYPASS_SECRET; both come from the environment and are never printed.
Research only: no broker is touched and nothing here is an order.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from wt.core.config import CONFIG_DIR, load_yaml  # noqa: E402
from wt.ops import publish  # noqa: E402
from wt.options import edition  # noqa: E402

KEY_ID = "radar"
DEFAULT_URL = "https://lab.algorythmos.com/api/ingest"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="options_edition.py")
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--pulls", type=Path, help="folder of <NAME>.daily.json, <NAME>.hourly.json, <NAME>.snapshot.json")
    src.add_argument("--transcript", type=Path, help="session transcript (JSON lines) holding the tool results")
    ap.add_argument("--since-ts", default="", help="with --transcript: only tool calls at or after this UTC ISO prefix")
    ap.add_argument("--data", type=Path, required=True, help="state folder: levels/, iv_history.csv, scorecard.csv")
    ap.add_argument("--now", help="UTC time to treat as now, e.g. 2026-10-12T22:00:00 (default: the clock)")
    ap.add_argument("--out", type=Path, help="also write the edition here")
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true", help="build and write, do not send")
    mode.add_argument("--send", action="store_true")
    a = ap.parse_args(argv)

    now = dt.datetime.fromisoformat(a.now) if a.now else dt.datetime.now(dt.UTC).replace(tzinfo=None)
    desk = load_yaml("options_desk.yaml")
    names = [str(n) for n in desk["names"]]
    if edition.nothing_new(now, lambda s: (a.data / "levels" / f"{s}.json").exists()):
        print(f"No new session since {edition.finished_session(now)}; the next session's levels are already built.")
        return 2

    if a.pulls:
        daily, hourly, snaps = edition.read_pulls(a.pulls, names)
    else:
        by_contract = {str(v): str(k) for k, v in (desk.get("contracts") or {}).items()}
        with a.transcript.open() as f:                # line by line: a result may hold a line separator inside a string
            daily, hourly, snaps = edition.extract_transcript(f, by_contract, a.since_ts)
    run = edition.run(names, daily, hourly, snaps, now)

    levels_doc = run.levels_doc
    if levels_doc is not None:
        path = a.data / "levels" / f"{run.session}.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(levels_doc, indent=1))
    n_iv = edition.append_unique(a.data / "iv_history.csv", edition.IV_FIELDS, run.iv_rows, edition.IV_KEY)
    n_sc = edition.append_unique(a.data / "scorecard.csv", edition.SC_FIELDS, run.scorecard_rows, edition.SC_KEY)
    print(f"finished={run.finished} next={run.session} levels={len(run.tickers)}/{len(names)} iv_rows+={n_iv} scorecard+={n_sc}")
    for t, p in run.problems.items():
        print(f"  {t}: {'; '.join(p)}")
    if levels_doc is None:
        print("no name could be built: nothing to send", file=sys.stderr)
        return 1

    rules_doc = json.loads((CONFIG_DIR / "options_rules.json").read_text())
    doc = edition.build_edition(levels_doc, edition.read_csv(a.data / "iv_history.csv"),
                                edition.read_csv(a.data / "scorecard.csv"), rules_doc, dt.datetime.now(dt.UTC))
    body = json.dumps(doc, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()
    if a.out:
        a.out.write_bytes(body)
    print(f"edition: session {doc['session']}, {len(doc['tickers'])} tickers, {len(doc['paper'])} paper trades, {len(body)} bytes")
    if a.dry_run:
        return 1 if run.failed else 0

    secret, bypass = os.environ.get("RADAR_INGEST_SECRET"), os.environ.get("VERCEL_AUTOMATION_BYPASS_SECRET")
    missing = [n for n, v in (("RADAR_INGEST_SECRET", secret), ("VERCEL_AUTOMATION_BYPASS_SECRET", bypass)) if not v]
    if missing or secret is None:
        print("NOT PUBLISHED: missing environment variable(s): " + ", ".join(missing), file=sys.stderr)
        return 3
    ok, detail = publish.send(body, os.environ.get("DASHBOARD_INGEST_URL") or DEFAULT_URL, secret, bypass, key_id=KEY_ID)
    # For an edition only 200 means stored (or the same run already there). The sender counts 409 as fine for a
    # snapshot; here it means the dashboard holds a newer edition and kept it.
    stored = ok and detail == "HTTP 200"
    # The status code and nothing else: never the response's text.
    print(f"dashboard: {'stored' if stored else 'NOT stored'} ({publish.error_code(detail)})")
    return 0 if stored and not run.failed else 1


if __name__ == "__main__":
    sys.exit(main())
