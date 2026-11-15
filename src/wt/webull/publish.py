"""Turn what `pull` read into the Trades page's journal and send it (ADR 0011). Runs as `wt`, never holds the key.

    python -m wt.webull.publish [--src DIR] [--state DIR] [--dry-run] [--fresh-money]
    python -m wt.webull.publish --parity      # compare what the host would send with the journal the site shows

It sends only while var/webull/PUBLISH_ON exists (beside its other state); without it every run is a dry run that
says what it would send. The file is an operational switch for the cutover, not a security control: any member of
group `wt` can create it.

It reads the pull job's group-readable files (/var/lib/wt-webull/out), builds the journal with `journal`, and sends it
with this host's dashboard key (DASHBOARD_KEY_ID) through `wt.ops.publish.send`. It sends when the fills or the money
change, or every HEARTBEAT_S so the page shows a fresh check time. Nothing is sent until the history backfill is
complete: a half-read history would show the owner a wrong lifetime result.

The money history (deposits, withdrawals, the daily account value) goes back further than the host's own balance
readings. The first run reads the journal the site shows now (GET /api/editions/journal) and keeps its `money` block
as the seed (var/webull/money_seed.json); later runs add the host's readings to it. The seed is kept only by a run
that sends: a dry run reads it and lets it go. If that read fails, nothing is sent and the job fails (a dry run
says so and exits 0), so the history is never silently dropped. `--fresh-money` starts without a seed, on purpose.

Alarms. The pull job exits 0 when a read fails (status.json says how), so a network outage does not page every two
minutes through OnFailure. This job, which runs after every pull, pages instead, through wt.ops.alerts (the
ntfy pages every job uses), and only when a state changes: once when it starts, once more if it still holds after
REMIND_S, and once when it clears (`step`). The states: the pull failing, the open lots disagreeing with Webull's
positions for longer than RECONCILE_GRACE_S, and the site refusing this journal as older (another writer). The pull cannot page this way itself: wt.ops.alerts needs the
checkout's environment, which the key holder does not load (ADR 0011).

Log lines carry counts and outcomes only: no symbol, price, balance or key.
"""
from __future__ import annotations

import argparse
import collections
import datetime as dt
import hashlib
import json
import os
import sys
from collections import defaultdict
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from typing import Any, Protocol

from wt.webull import journal

HEARTBEAT_S = 10 * 60
PUBLISH_ON = "PUBLISH_ON"          # in the state directory: without it the publisher only says what it would send
PARITY_ROWS = 20
REMIND_S = 30 * 60                 # a state still holding this long pages once more
RECONCILE_GRACE_S = 10 * 60        # a fill the history has not caught up with yet clears within a run or two
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


# ---- alarms --------------------------------------------------------------------------------------------------------

class Pager(Protocol):
    """What the alarms need of wt.ops.alerts.Alerts."""

    def fire(self, key: str, title: str, message: str, priority: int = 4, tags: tuple[str, ...] = ()) -> bool: ...
    def resolve(self, key: str, title: str, message: str, priority: int = 2) -> bool: ...
    def notify(self, title: str, message: str, priority: int = 3, tags: tuple[str, ...] = ()) -> bool: ...


class Silent:
    """No pages (a test, or a run without the alerts module)."""

    def fire(self, key: str, title: str, message: str, priority: int = 4, tags: tuple[str, ...] = ()) -> bool:
        return False

    def resolve(self, key: str, title: str, message: str, priority: int = 2) -> bool:
        return False

    def notify(self, title: str, message: str, priority: int = 3, tags: tuple[str, ...] = ()) -> bool:
        return False


def step(prev: Mapping[str, Any], on: bool, now: dt.datetime, since: dt.datetime | None = None,
         grace_s: float = 0.0, remind_s: float | None = REMIND_S) -> tuple[dict[str, Any], str | None]:
    """One alarm's next state and what to page: "start" once it has held `grace_s`, "still" once after `remind_s`,
    "clear" when it stops after having paged. Nothing else pages, however often it is called."""
    if not on:
        return {"on": False}, ("clear" if prev.get("paged") else None)
    began = since or (journal._t(prev["since"]) if prev.get("on") and prev.get("since") else now)
    cur = {"on": True, "since": began.isoformat(), "paged": bool(prev.get("on") and prev.get("paged")),
           "reminded": bool(prev.get("on") and prev.get("reminded"))}
    held = (now - began).total_seconds()
    if not cur["paged"]:
        if held >= grace_s:
            cur["paged"] = True
            return cur, "start"
    elif remind_s is not None and not cur["reminded"] and held >= remind_s:
        cur["reminded"] = True
        return cur, "still"
    return cur, None


KINDS = {"transient": "the network or Webull's side", "error": "Webull refused the read"}


def page_text(key: str, event: str, since: dt.datetime | None = None, kind: object = None,
              n: object = None) -> tuple[str, str]:
    """The title and message of one alarm page: fixed words, and values through wt.ops.alerts' guards only."""
    from wt.ops import alerts as al
    at = f"{al.hhmm(since)} UTC" if since else "earlier"
    why = KINDS.get(al.word(kind, tuple(KINDS), "other"), "see the journal")
    texts = {
        ("pull", "start"): ("Webull reads failing", f"The host's Webull read has failed since {at} ({why}). It "
                            "tries again every run. Check: journalctl -u wt-webull-pull."),
        ("pull", "still"): ("Webull reads still failing", f"The host's Webull read has failed since {at} ({why}), "
                            "30 minutes or more. Check: journalctl -u wt-webull-pull."),
        ("pull", "clear"): ("Webull reads working again", "The host's Webull read works again."),
        ("reconcile", "start"): ("Webull holdings disagree", f"The journal's open lots and Webull's positions "
                                 f"disagree on {al.count(n)} holding(s) since {at}. Compare the Trades page with "
                                 "the app."),
        ("reconcile", "still"): ("Webull holdings still disagree", f"The journal's open lots and Webull's "
                                 f"positions have disagreed since {at}, 30 minutes or more."),
        ("reconcile", "clear"): ("Webull holdings agree again", "The journal's open lots match Webull's positions."),
        ("superseded", "start"): ("Webull journal superseded", f"Since {at} the site holds a journal newer than the "
                                  "host's: something else writes it. Check that the cloud routine is retired."),
        ("superseded", "still"): ("Webull journal still superseded", f"Since {at} the site has refused the host's "
                                  "journal as older, 30 minutes or more."),
        ("superseded", "clear"): ("Webull journal sent again", "The site takes the host's journal again."),
    }
    return texts.get((key, event), ("Webull journal alarm", "An alarm of the Webull journal changed."))


ALARM_KEYS = (("pull", "start"), ("pull", "still"), ("pull", "clear"), ("reconcile", "start"), ("reconcile", "still"),
              ("reconcile", "clear"), ("superseded", "start"), ("superseded", "still"), ("superseded", "clear"))


def page(pager: Pager, key: str, event: str, since: dt.datetime | None = None, kind: object = None,
         n: object = None) -> None:
    title, msg = page_text(key, event, since, kind, n)
    if event == "start":
        pager.fire(f"webull:{key}", title, msg)
    elif event == "still":
        pager.notify(title, msg, 4)
    else:
        pager.resolve(f"webull:{key}", title, msg)


class Alarms:
    """Each alarm's state in var/webull/alarms.json, and the pages `step` asks for."""

    def __init__(self, path: Path, pager: Pager) -> None:
        self.path, self.pager = path, pager
        d = read_json(path, {})
        self.state: dict[str, Any] = d if isinstance(d, dict) else {}

    def set(self, key: str, on: bool, now: dt.datetime, since: dt.datetime | None = None, grace_s: float = 0.0,
            kind: object = None, n: object = None) -> str | None:
        prev = self.state.get(key)
        cur, event = step(prev if isinstance(prev, dict) else {}, on, now, since, grace_s)
        self.state[key] = cur
        write_json(self.path, self.state)
        if event:
            log(f"alarm: {key} {event}")
            page(self.pager, key, event, journal._t(cur["since"]) if cur.get("since") else since, kind, n)
        return event


def pull_alarm(alarms: Alarms, status: Mapping[str, Any], now: dt.datetime) -> None:
    """The pull failing: on while its status says "failing", off when it says "ok". A token waiting for approval
    is paged by the pull itself (once per token) and leaves this alarm as it was."""
    st = status.get("state") or ("ok" if status.get("ok") else None)
    if st not in ("ok", "failing"):
        return
    since = journal._t(status["since"]) if st == "failing" and isinstance(status.get("since"), str) else None
    alarms.set("pull", st == "failing", now, since=since, kind=status.get("kind"))


def run(src: Path, state: Path, *, read_back: Callable[[], dict[str, Any] | None],
        send: Callable[[bytes], tuple[bool, str]], dry_run: bool = False, fresh_money: bool = False,
        pager: Pager | None = None, clock: Callable[[], dt.datetime] = lambda: dt.datetime.now(dt.UTC)) -> int:
    alarms = Alarms(state / "alarms.json", pager or Silent())
    status = read_json(src / "status.json", {})
    pull_alarm(alarms, status, journal._t(status["at"]) if isinstance(status.get("at"), str) else clock())
    history = read_json(src / "history.json", {})
    if not history.get("complete"):
        log(f"waiting: the order history is read through {history.get('through') or 'nothing yet'}; not sending")
        return 0
    if not status.get("ok") or not status.get("at"):
        log(f"not sending: the last read of Webull did not finish ({status.get('state') or 'no status'}"
            f"{', since ' + str(status['since']) if status.get('since') else ''})")
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
                if dry_run:
                    log("dry run: could not read the journal the site shows now; nothing sent, no seed kept")
                    return 0
                log("stop: could not read the journal the site shows now, so its money history can't be carried over")
                return 1
            seed = seed_from(edition)
        n_values, n_transfers = len(seed.get("values") or []), len(seed.get("transfers") or [])
        if dry_run:
            log(f"dry run: money seed read, not kept: {n_values} daily values, {n_transfers} transfers")
        else:
            write_json(seed_path, seed)
            log(f"money seed kept: {n_values} daily values, {n_transfers} transfers")
    money = money_from(doc, seed or None, load_readings(src))
    if money:
        doc["money"], doc["schema_version"] = money, 2

    off = reconcile(doc, read_json(src / "positions.json", None))
    write_json(state / "reconcile.json", {"at": doc["as_of"], "symbols_off": off})
    if off:
        log(f"warn: open lots and Webull's positions disagree on {off} symbol(s)")
    alarms.set("reconcile", off > 0, now, grace_s=RECONCILE_GRACE_S, n=off)

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
    if ok and superseded(detail):
        log(f"superseded: the site holds a newer journal than this one ({summary}); not recorded as sent")
        alarms.set("superseded", True, now)
        return 0
    log(f"{'sent' if ok else 'not sent'}: {summary} ({detail.split(':')[0]})")
    if ok:
        write_json(state / "last_sent.json", {"at": doc["as_of"], "hash": h})
        alarms.set("superseded", False, now)
    return 0 if ok else 1


def superseded(detail: str) -> bool:
    """wt.ops.publish.send counts a 409 as sent. For a desk snapshot that is right; for the journal it means the
    site already holds one with a later as_of ("older", dashboard/src/lib/ingest.ts storeEdition), which only another
    writer can have made. The site answers a repeat of the same run_id with 200 "duplicate", so it is not this."""
    return detail.startswith("HTTP 409") and '"duplicate"' not in detail


# ---- parity: the host's journal against the site's -------------------------------------------------------------------

Row = tuple[Any, ...]


def _utc(s: Any) -> str | None:
    return journal._t(s).astimezone(dt.UTC).isoformat(timespec="seconds") if isinstance(s, str) and s else None


def trade_row(t: Mapping[str, Any]) -> Row:
    """A trade as parity compares it: its own fields, never its id."""
    strike = t.get("strike")
    return (t.get("symbol"), t.get("kind"), None if strike is None else round(float(strike), 4), t.get("expiry"),
            t.get("side"), round(float(t.get("qty") or 0), 6), _utc(t.get("opened_at")), _utc(t.get("closed_at")),
            round(float(t.get("pnl") or 0), 2))


def last_fill(doc: Mapping[str, Any]) -> str | None:
    """The newest fill a journal shows: an opening, or a close by an order (an expiry is not a fill)."""
    times = [_utc(t.get("opened_at")) for t in doc.get("trades") or []]
    times += [_utc(t.get("closed_at")) for t in doc.get("trades") or [] if t.get("close") == "order"]
    times += [_utc(o.get("opened_at")) for o in doc.get("open") or []]
    return max((x for x in times if x), default=None)


def money_total(doc: Mapping[str, Any]) -> float | None:
    """Money in less money out over the whole history (the transfers), the money block's total."""
    m = doc.get("money")
    return round(sum(float(t.get("amount") or 0) for t in m.get("transfers") or []), 2) if isinstance(m, dict) else None


def compare(host: Mapping[str, Any], site: Mapping[str, Any]) -> dict[str, Any]:
    mine = collections.Counter(trade_row(t) for t in host.get("trades") or [])
    theirs = collections.Counter(trade_row(t) for t in site.get("trades") or [])
    only_host, only_site = sorted((mine - theirs).elements(), key=repr), sorted((theirs - mine).elements(), key=repr)
    counts = {k: {"host": f(host), "site": f(site)} for k, f in (
        ("trades", lambda d: len(d.get("trades") or [])), ("open_lots", lambda d: len(d.get("open") or [])),
        ("fills", lambda d: d.get("fills")), ("last_fill", last_fill), ("money_total", money_total))}
    exact = not only_host and not only_site and all(v["host"] == v["site"] for v in counts.values())
    value = {k: (d.get("money") or {}).get("account_value") for k, d in (("host", host), ("site", site))}
    return {"exact": exact, "counts": counts, "account_value": value, "host_as_of": host.get("as_of"),
            "site_as_of": site.get("as_of"), "only_host": [list(r) for r in only_host[:PARITY_ROWS]],
            "only_site": [list(r) for r in only_site[:PARITY_ROWS]], "n_only_host": len(only_host),
            "n_only_site": len(only_site)}


def parity(src: Path, state: Path, *, read_back: Callable[[], dict[str, Any] | None],
           say: Callable[[str], None] = print) -> int:
    """Build the journal from the pull's files as a send would, read the site's, and compare them: 0 when they agree
    exactly, 1 when not, 2 when either side can't be read. Prints counts and the differing trades (this is the
    owner's terminal, not a job's log) and writes var/webull/parity.json, readable by `wt` only."""
    history, status = read_json(src / "history.json", {}), read_json(src / "status.json", {})
    at = status.get("at") if status.get("ok") else status.get("last_ok")
    if not history.get("complete") or not at:
        say(f"parity: the pull has not finished the history (read through {history.get('through') or 'nothing'}) "
            "or has no good read yet")
        return 2
    site = read_back()
    if site is None:
        say("parity: could not read the journal the site shows now")
        return 2
    doc = journal.build(load_groups(src), journal._t(at))
    seed = read_json(state / "money_seed.json", None)
    money = money_from(doc, (seed if seed is not None else seed_from(site)) or None, load_readings(src))
    if money:
        doc["money"] = money
    r = compare(doc, site)
    say(f"parity: the host's journal as of {r['host_as_of']} against the site's as of {r['site_as_of']}")
    for k, v in r["counts"].items():
        say(f"  {k:<12} host {v['host']}  site {v['site']}{'' if v['host'] == v['site'] else '  <- differs'}")
    say(f"  account value host {r['account_value']['host']}  site {r['account_value']['site']} (not compared: it "
        "moves with the market)")
    for side in ("host", "site"):
        if r[f"only_{side}"]:
            say(f"only on the {side} ({r[f'n_only_{side}']}, up to {PARITY_ROWS} shown): symbol, kind, strike, "
                "expiry, side, qty, opened, closed, pnl")
            for row in r[f"only_{side}"]:
                say("  " + ", ".join("" if x is None else str(x) for x in row))
    say(f"parity: {'exact' if r['exact'] else 'NOT exact'}")
    state.mkdir(parents=True, exist_ok=True)
    fd = os.open(state / "parity.json", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump({**r, "at": dt.datetime.now(dt.UTC).isoformat(timespec="seconds")}, f, separators=(",", ":"))
    return 0 if r["exact"] else 1


def main(argv: list[str] | None = None) -> int:
    from wt.core.config import STATE_DIR
    ap = argparse.ArgumentParser(prog="python -m wt.webull.publish")
    ap.add_argument("--src", type=Path, default=Path("/var/lib/wt-webull/out"))
    ap.add_argument("--state", type=Path, default=STATE_DIR / "webull")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--fresh-money", action="store_true", help="start the money history without the site's seed")
    ap.add_argument("--parity", action="store_true", help="compare with the site's journal; sends nothing")
    a = ap.parse_args(argv)
    env = os.environ
    url, secret = env.get("DASHBOARD_INGEST_URL"), env.get("DASHBOARD_INGEST_SECRET")
    dry_run = a.dry_run or not (a.state / PUBLISH_ON).exists()
    if dry_run and not a.dry_run and not a.parity:
        log(f"dry run: no {a.state / PUBLISH_ON}, so nothing is sent")
    if not dry_run and not (url and secret):
        log("stop: DASHBOARD_INGEST_URL or DASHBOARD_INGEST_SECRET is not set")
        return 2

    def read_back() -> dict[str, Any] | None:
        from wt.options.pipeline_check import read_edition
        return read_edition("journal")

    def send(body: bytes) -> tuple[bool, str]:
        from wt.ops.publish import send as post
        return post(body, url or "", secret or "", env.get("VERCEL_AUTOMATION_BYPASS_SECRET"))

    if a.parity:
        return parity(a.src, a.state, read_back=read_back)
    from wt.ops.alerts import Alerts
    return run(a.src, a.state, read_back=read_back, send=send, dry_run=dry_run, fresh_money=a.fresh_money,
               pager=Alerts())


if __name__ == "__main__":
    sys.exit(main())
