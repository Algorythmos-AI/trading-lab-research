"""Turn what `pull` read into the Trades page's journal and send it (ADR 0011). Runs as `wt`, never holds the key.

    python -m wt.webull.publish [--src DIR] [--state DIR] [--dry-run] [--fresh-money]

It reads the pull job's group-readable files (/var/lib/wt-webull/out), builds the journal with `journal`, and sends it
with this host's dashboard key (DASHBOARD_KEY_ID) through `wt.ops.publish.send`. It sends when the fills or the money
change, or every HEARTBEAT_S so the page shows a fresh check time. Nothing is sent until the history backfill is
complete: a half-read history would show the owner a wrong lifetime result.

The money history (deposits, withdrawals, the daily account value) goes back further than the host's own balance
readings. The first run reads the journal the site shows now (GET /api/editions/journal) and keeps its `money` block
as the seed (var/webull/money_seed.json); later runs add the host's readings to it. If that read fails, nothing is
sent and the job fails, so the history is never silently dropped. `--fresh-money` starts without a seed, on purpose.

Log lines carry counts and outcomes only: no symbol, price, balance or key.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import sys
from collections import defaultdict
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from typing import Any

from wt.webull import journal

HEARTBEAT_S = 10 * 60
SEED_KEYS = ("as_of", "currency", "account_value", "cash", "positions", "usd_rate", "complete_from", "transfers", "values")


def log(msg: str) -> None:
    print(f"{dt.datetime.now(dt.UTC):%Y-%m-%dT%H:%M:%SZ} webull-publish {msg}", flush=True)


def read_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return default


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(json.dumps(data, separators=(",", ":")))
    os.replace(tmp, path)


def load_groups(src: Path) -> list[dict[str, Any]]:
    groups: list[dict[str, Any]] = []
    for p in sorted((src / "orders").glob("*.json")):
        rows = read_json(p, [])
        if isinstance(rows, list):
            groups += [g for g in rows if isinstance(g, dict)]
    return groups


def load_readings(src: Path) -> list[dict[str, Any]]:
    out = []
    try:
        lines = (src / "account.jsonl").read_text().splitlines()
    except OSError:
        return []
    for line in lines:
        try:
            row = json.loads(line)
        except ValueError:
            continue                      # a line cut short by a crash; the next reading replaces it
        if isinstance(row, dict) and {"at", "cash", "market_value"} <= row.keys():
            out.append(row)
    return sorted(out, key=lambda r: r["at"])


def realized_at(trades: Sequence[Mapping[str, Any]], at: str) -> float:
    """The closed result (USD) of every trade closed by `at`: what a balance reading at that time already holds."""
    t = journal._t(at)
    return sum(float(r["pnl"]) for r in trades if journal._t(r["closed_at"]) <= t)


def money_from(doc: Mapping[str, Any], seed: Mapping[str, Any] | None,
               readings: Sequence[Mapping[str, Any]]) -> dict[str, Any] | None:
    """The journal's money block: the seed, plus the host's readings after it and the transfers they show."""
    after = (seed or {}).get("as_of") or ""
    snaps = [journal.derive(r, realized_at(doc["trades"], r["at"])) for r in readings if r["at"] > after]
    transfers = list((seed or {}).get("transfers") or [])
    found: list[dict[str, Any]] = []
    for prev, cur in zip(snaps, snaps[1:], strict=False):
        if t := journal.detect(prev, cur, transfers + found):
            found.append(t)
    return journal.money_block(seed, snaps, found)


def reconcile(doc: Mapping[str, Any], positions: Any) -> int:
    """How many holdings the journal's open lots and Webull's own positions disagree on. Count only.

    Shares are compared by symbol and signed quantity. Options are compared as one total of contracts held, because
    the positions list names an option by its own contract symbol rather than by the underlying."""
    def k(symbol: str, option: bool) -> str:
        return "options" if option else symbol

    mine: dict[str, float] = defaultdict(float)
    for lot in doc.get("open") or []:
        q = float(lot["qty"])
        opt = lot["kind"] != "stock"
        mine[k(lot["symbol"], opt)] += abs(q) if opt else q * (1 if lot["side"] == "long" else -1)
    theirs: dict[str, float] = defaultdict(float)
    for p in (positions or {}).get("positions") or []:
        if isinstance(p, dict) and p.get("symbol"):
            opt = str(p.get("instrument_type") or "").upper() == "OPTION"
            q = float(p.get("quantity") or 0)
            theirs[k(str(p["symbol"]), opt)] += abs(q) if opt else q
    return sum(1 for s in set(mine) | set(theirs) if abs(mine.get(s, 0.0) - theirs.get(s, 0.0)) > 1e-6)


def seed_from(edition: Mapping[str, Any] | None) -> dict[str, Any]:
    money = (edition or {}).get("money")
    return {k: money[k] for k in SEED_KEYS if k in money} if isinstance(money, dict) else {}


def digest(doc: Mapping[str, Any]) -> str:
    """What changes the page: everything but the run id and the check time."""
    body = {k: v for k, v in doc.items() if k not in ("run_id", "as_of")}
    return hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def run(src: Path, state: Path, *, read_back: Callable[[], dict[str, Any] | None],
        send: Callable[[bytes], tuple[bool, str]], dry_run: bool = False, fresh_money: bool = False) -> int:
    history = read_json(src / "history.json", {})
    if not history.get("complete"):
        log(f"waiting: the order history is read through {history.get('through') or 'nothing yet'}; not sending")
        return 0
    status = read_json(src / "status.json", {})
    if not status.get("ok") or not status.get("at"):
        log(f"not sending: the last read of Webull did not finish ({status.get('why') or 'no status'})")
        return 0
    now = journal._t(status["at"])          # the journal is as of the last good read, never of this run's clock
    doc = journal.build(load_groups(src), now)

    seed_path = state / "money_seed.json"
    seed = read_json(seed_path, None)
    if seed is None:
        if fresh_money:
            seed = {}
        else:
            edition = read_back()
            if edition is None:
                log("stop: could not read the journal the site shows now, so its money history can't be carried over")
                return 1
            seed = seed_from(edition)
        write_json(seed_path, seed)
        log(f"money seed kept: {len(seed.get('values') or [])} daily values, {len(seed.get('transfers') or [])} transfers")
    money = money_from(doc, seed or None, load_readings(src))
    if money:
        doc["money"], doc["schema_version"] = money, 2

    off = reconcile(doc, read_json(src / "positions.json", None))
    write_json(state / "reconcile.json", {"at": doc["as_of"], "symbols_off": off})
    if off:
        log(f"warn: open lots and Webull's positions disagree on {off} symbol(s)")

    body = json.dumps(doc, separators=(",", ":")).encode()
    h = digest(doc)
    last = read_json(state / "last_sent.json", {})
    age = (now - journal._t(last["at"])).total_seconds() if last.get("at") else None
    summary = f"{len(doc['trades'])} trades from {doc['fills']} fills, {len(doc['open'])} open, {len(doc['gaps'])} gaps"
    if last.get("hash") == h and age is not None and age < HEARTBEAT_S:
        log(f"unchanged: {summary}; sent {int(age)}s ago")
        return 0
    if dry_run:
        log(f"dry run: {summary}, {len(body):,} bytes")
        return 0
    ok, detail = send(body)
    log(f"{'sent' if ok else 'not sent'}: {summary} ({detail})")
    if ok:
        write_json(state / "last_sent.json", {"at": doc["as_of"], "hash": h})
    return 0 if ok else 1


def main(argv: list[str] | None = None) -> int:
    from wt.core.config import STATE_DIR
    ap = argparse.ArgumentParser(prog="python -m wt.webull.publish")
    ap.add_argument("--src", type=Path, default=Path("/var/lib/wt-webull/out"))
    ap.add_argument("--state", type=Path, default=STATE_DIR / "webull")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--fresh-money", action="store_true", help="start the money history without the site's seed")
    a = ap.parse_args(argv)
    env = os.environ
    url, secret = env.get("DASHBOARD_INGEST_URL"), env.get("DASHBOARD_INGEST_SECRET")
    if not a.dry_run and not (url and secret):
        log("stop: DASHBOARD_INGEST_URL or DASHBOARD_INGEST_SECRET is not set")
        return 2

    def read_back() -> dict[str, Any] | None:
        from wt.options.pipeline_check import read_edition
        return read_edition("journal")

    def send(body: bytes) -> tuple[bool, str]:
        from wt.ops.publish import send as post
        return post(body, url or "", secret or "", env.get("VERCEL_AUTOMATION_BYPASS_SECRET"))

    return run(a.src, a.state, read_back=read_back, send=send, dry_run=a.dry_run, fresh_money=a.fresh_money)


if __name__ == "__main__":
    sys.exit(main())
