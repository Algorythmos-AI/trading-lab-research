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

The edition's format is `edition_format` in config/options_desk.yaml (1, or 2 for the day's context, events and
each name's volatility), or `--format`. Before sending format 2 the script asks the dashboard's /api/health what it
accepts, and builds format 1 when the answer is older or cannot be read: an edition the site would refuse whole is
never sent.

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

import yaml  # noqa: E402

from wt.options import edition  # noqa: E402

# Building needs this file, wt.options and a YAML reader, and nothing else: a dry run works in an environment
# that has none of the lab's other dependencies. The sender (requests and the rest) is loaded only to send.
CONFIG_DIR = Path(__file__).resolve().parents[1] / "config"


def load_yaml(name: str) -> dict:
    return yaml.safe_load((CONFIG_DIR / name).read_text())


def _publish():
    from wt.ops import publish
    return publish

KEY_ID = "radar"
DEFAULT_URL = "https://lab.algorythmos.com/api/ingest"


STAMPS = ("run_id", "as_of")        # the two fields that differ between any two builds: when each was made


def differences(a: object, b: object, path: str = "") -> list[str]:
    """Where two editions differ, as paths (`tickers[3].zones[1].hi`), ignoring when each was built. Numbers are
    compared exactly: both builds round the same way, so a last-digit difference is a difference."""
    if isinstance(a, dict) and isinstance(b, dict):
        out: list[str] = []
        for k in sorted(set(a) | set(b)):
            if not path and k in STAMPS:
                continue
            here = f"{path}.{k}" if path else str(k)
            if k not in a or k not in b:
                out.append(f"{here} (only in {'the other' if k in a else 'this'} build)")
            else:
                out += differences(a[k], b[k], here)
        return out
    if isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            return [f"{path} (length {len(a)} against {len(b)})"]
        return [d for i, (x, y) in enumerate(zip(a, b, strict=True)) for d in differences(x, y, f"{path}[{i}]")]
    return [] if a == b and type(a) is type(b) else [path]


def site_accepts(url: str, bypass: str | None) -> int:
    """The newest edition format the live dashboard validates, from /api/health; 0 when it cannot be read."""
    health, _ = _publish().read_health(url, bypass)
    editions = health.get("editions") if isinstance(health, dict) else None
    options = editions.get("options") if isinstance(editions, dict) else None
    accepts = options.get("accepts") if isinstance(options, dict) else None
    return accepts if isinstance(accepts, int) and not isinstance(accepts, bool) else 0


def macro_calendar() -> list[dict[str, object]] | None:
    """The repo's macro-event calendar, or None when it cannot be read: the edition then goes out without events
    and says its calendar is unknown."""
    try:
        from wt.risk import events
        return list(events.events())
    except Exception as e:  # noqa: BLE001 — events are an extra: a broken calendar file must not stop the levels
        print(f"macro calendar unavailable ({e.__class__.__name__}): sending without events", file=sys.stderr)
        return None


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="options_edition.py")
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--pulls", type=Path, help="folder of <NAME>.daily.json, <NAME>.hourly.json, <NAME>.snapshot.json")
    src.add_argument("--transcript", type=Path, help="session transcript (JSON lines) holding the tool results")
    ap.add_argument("--since-ts", default="", help="with --transcript: only tool calls at or after this UTC ISO prefix")
    ap.add_argument("--data", type=Path, required=True, help="state folder: levels/, iv_history.csv, scorecard.csv")
    ap.add_argument("--now", help="UTC time to treat as now, e.g. 2026-10-12T22:00:00 (default: the clock)")
    ap.add_argument("--out", type=Path, help="also write the edition here")
    ap.add_argument("--format", type=int, choices=(1, 2), help="edition format (default: edition_format in the desk's config)")
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true", help="build and write, do not send")
    mode.add_argument("--send", action="store_true")
    ap.add_argument("--compare", type=Path, help="an edition written by another build of the same pulls: print how the two differ, as counts")
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

    url = os.environ.get("DASHBOARD_INGEST_URL") or DEFAULT_URL
    secret, bypass = os.environ.get("RADAR_INGEST_SECRET"), os.environ.get("VERCEL_AUTOMATION_BYPASS_SECRET")
    fmt = a.format or desk.get("edition_format")
    if fmt not in (edition.EDITION_VERSION, edition.EDITION_VERSION_MAX) or isinstance(fmt, bool):
        if fmt is not None:
            print(f"edition_format {fmt!r} is not a format this script writes: using {edition.EDITION_VERSION}", file=sys.stderr)
        fmt = edition.EDITION_VERSION
    if fmt > edition.EDITION_VERSION and a.send:
        # Asked on every send, and a send that cannot ask (no secrets) builds format 1 too: a format 2 file is
        # only ever written for a dashboard known to take it, or on a dry run.
        accepts = site_accepts(url, bypass) if secret and bypass else 0
        if accepts < fmt:
            print(f"the dashboard accepts edition format {accepts or 'unknown'}: building format {edition.EDITION_VERSION}")
            fmt = edition.EDITION_VERSION
    rules_doc = json.loads((CONFIG_DIR / "options_rules.json").read_text())
    calendar = macro_calendar() if fmt > edition.EDITION_VERSION else None
    doc = edition.build_edition(levels_doc, edition.read_csv(a.data / "iv_history.csv"),
                                edition.read_csv(a.data / "scorecard.csv"), rules_doc, dt.datetime.now(dt.UTC),
                                version=fmt, calendar=calendar)
    body = json.dumps(doc, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()
    if a.out:
        a.out.write_bytes(body)
    print(f"edition: format {doc['schema_version']}, session {doc['session']}, {len(doc['tickers'])} tickers, "
          f"{len(doc['paper'])} paper trades, {len(body)} bytes")
    if a.compare:
        try:
            other = json.loads(a.compare.read_text())
        except (OSError, ValueError) as e:
            print(f"compare: {a.compare} cannot be read ({e.__class__.__name__})", file=sys.stderr)
            return 1
        diffs = differences(other, doc)
        print(f"compare: {len(diffs)} difference(s) outside run_id and as_of")
        for path in diffs[:40]:
            print(f"  {path}")              # where they differ, never the values: the pulls are real market data
        if diffs:
            return 1
    if a.dry_run:
        return 1 if run.failed else 0

    missing = [n for n, v in (("RADAR_INGEST_SECRET", secret), ("VERCEL_AUTOMATION_BYPASS_SECRET", bypass)) if not v]
    if missing or secret is None:
        print("NOT PUBLISHED: missing environment variable(s): " + ", ".join(missing), file=sys.stderr)
        return 3
    publish = _publish()
    ok, detail = publish.send(body, url, secret, bypass, key_id=KEY_ID)
    # For an edition only 200 means stored (or the same run already there). The sender counts 409 as fine for a
    # snapshot; here it means the dashboard holds a newer edition and kept it.
    stored = ok and detail == "HTTP 200"
    # The status code and nothing else: never the response's text.
    print(f"dashboard: {'stored' if stored else 'NOT stored'} ({publish.error_code(detail)})")
    return 0 if stored and not run.failed else 1


if __name__ == "__main__":
    sys.exit(main())
