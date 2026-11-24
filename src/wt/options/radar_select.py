"""Radar → Options selection, one session at a time (DEC-0070, PROPOSED): read the stored Radar edition, turn it into
checked candidates, gate them into the universe, fetch the Stage 1 bundle for that universe and score it with the
frozen Stage 1 rules (DEC-0046, `wt.options.select`, unchanged).

    python -m wt.options.radar_select run --session <S> [--root <dir>]
    python -m wt.options.radar_select replay --session <S> [--root <dir>]
    python -m wt.options.radar_select job [--root <dir>]
    python -m wt.options.radar_select check --session <S> [--root <dir>]

`job` is the host job (`wt-options-select`, 06:45 New York on weekdays): S is today in New York (a day with no session
writes nothing and exits 0); it reads the Radar until the edition is S's and fresh or it is 07:45 New York, then runs
once on the last edition read (DEC-0070 section 4). A second job run for S finds the folder and exits 0; while
`var/options-select/OFF` exists the job runs nothing.

`S` is the session being selected for; the bundle is for D, the session before it (Stage 1 scores a finished
session). The run is a shadow: it writes records and publishes nothing, and the Options page's four names do not
change. Publishing waits for the switch record (DEC-0048) and the owner's merge.

A run writes one folder, `var/options-select/<S>/`, built in a temporary folder beside it and renamed into place
whole, so the folder exists only when every file in it was written; a second run for S finds it and stops
(idempotent):

| File | What |
|---|---|
| `candidates.json` | `wt.options.radar_candidates` record: the edition's hash, freshness status, in-scope symbols |
| `fetch.json` | the bars fetched for the desk and every candidate, and the event rows (the gate's and Stage 1's inputs) |
| `universe.json` | `wt.options.universe` record: every candidate's verdict, the chain facts read, the universe |
| `stage1-bundle.json` | the Stage 1 bundle for the universe (`select.check_bundle` shape) |
| `stage1.json` | the Stage 1 output (`select.run_bundle`), with params_sha, picker_ref and bundle_sha |
| `run.json` | the run's summary: times, statuses, counts, picks and where each came from, every file's sha256 |

`replay` recomputes the universe from `candidates.json`, `fetch.json` and the chain facts saved in `universe.json`,
then Stage 1 from the rebuilt bundle, and fails when any hash differs from the saved one.

After a job's run is written, the job checks it and writes `check.json` beside it (`check_run`): the replay's word,
whether every gate verdict carries its facts, how many of the run's picks are in the published focus for S (a count,
never a name), and the codes that keep the session from being clean. A clean session is one the switch's operational
gate counts (five are needed): on time, the Radar read ok with at least one name new to the desk, their bars fetched,
facts on every verdict, and a replay that reproduces. A session that is not clean pages the owner's phone once (codes
only). The job also checks any earlier run folder that has no `check.json` yet. `check` does the same for one session
by hand: it writes a `check.json` only where there is none (a later config or code change would make an old run's
replay differ), and `--again` rewrites one. `check.json` is not one of the run's hashed files: `replay` never reads it.

What is never written: the edition's prose (why, notes, labels, headlines), any price after the run, any outcome.
"""
from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from typing import Any

from wt.options import chain as ch
from wt.options import levels as lv
from wt.options import radar_candidates as rc
from wt.options import select as sel
from wt.options import select_fetch as sf
from wt.options import select_stage2 as s2
from wt.options import universe as un

VAR = sel.ROOT / "var" / "options-select"
EARNINGS_FILES = ("earnings.csv", "earnings_radar.csv")
RUN_SCHEMA = "wt.options/radar-select-run"
RUN_VERSION = 1
# The run must have its picks by this New York time on S to be in time for the switch's publish (Stage 2's Pass A
# fetches at 08:50; the site freezes S's focus at 09:25). A shadow run after it is still recorded, marked late.
PUBLISH_BY = (8, 40)
CHAIN_REQUEST_BUDGET = 150
CHAIN_TIME_BUDGET_S = 600

# The job reads the Radar until this New York time on S, every RADAR_RETRY_EVERY_S, while the edition is missing,
# stale or invalid (the Radar's catch-up routines fire at 06:30 and 07:30), then runs on what it last read.
RADAR_RETRY_UNTIL = (7, 45)
RADAR_RETRY_EVERY_S = 300.0
OFF = "OFF"                    # var/options-select/OFF: the job runs nothing while it exists (the owner's switch)

EXIT_OK, EXIT_ERROR, EXIT_USAGE, EXIT_EXISTS, EXIT_TOO_EARLY, EXIT_REPLAY, EXIT_NOT_CLEAN = 0, 1, 2, 3, 4, 5, 6

CHECK_SCHEMA = "wt.options/radar-select-check"
CHECK_VERSION = 1
CHECK_FILE = "check.json"
FACTS_VERSION = 2              # wt.options.universe.VERSION from which every verdict carries its gate facts
# Why a session is not clean, in this order (a closed set: the status block and the page take only these).
NOT_CLEAN = ("radar_not_ok", "late", "radar_bars_failed", "no_radar_candidates", "facts_missing", "replay_differs",
             "replay_error")
REPLAY_WORDS = ("reproduces", "differs", "error")
# The published focus as the check read it: for S (overlap counted), for another session, unreadable, or not read
# (a folder checked later, when S's focus is no longer the one published).
PUBLISHED_WORDS = ("ok", "other_session", "unreadable", "not_read")
_DAY_DIR = re.compile(r"\d{4}-\d{2}-\d{2}")
CLEAN_NEEDED = 5               # clean sessions before the gate thresholds' amendment (handover, DEC-0070 section 3)

ChainReader = Callable[[str, float, str], "Sequence[ch.Quote] | None"]


def sha_of(doc: Any) -> str:
    return hashlib.sha256(sel.dumps(doc).encode("ascii")).hexdigest()


def read_earnings(events_dir: Path = sf.EVENTS) -> list[dict[str, Any]]:
    """The rows of both earnings files, the desk's first. A missing Radar file gives no rows (every Radar name is then
    earnings_unknown); a missing desk file is an error."""
    rows = sf.read_rows(events_dir / EARNINGS_FILES[0])
    extra = events_dir / EARNINGS_FILES[1]
    return rows + (sf.read_rows(extra) if extra.exists() else [])


def alpaca_chain_reader(client: sf.Client, *, feed: str, clock: Callable[[], dt.datetime],
                        sleep: Callable[[float], None], cfg: rc.Config) -> ChainReader:
    """A ChainReader over `/v1beta1/options/snapshots/<root>`: the contracts of the expiries from S to S plus
    `chain_expiry_max_days`, strikes within `chain_ntm_pct` of the close. One fetcher with its own request and time
    budgets serves every name, its clock starting at the first read; a name whose fetch fails reads as None
    (chain_unavailable), never as an empty chain. Names are read in the gate's priority order, so a budget that runs
    out cuts the least preferred names first."""
    held: list[sf.Fetcher] = []                    # made at the first read, so the budget starts with the chains

    def read(symbol: str, close: float, session: str) -> Sequence[ch.Quote] | None:
        if not held:
            held.append(sf.Fetcher(client, max_requests=CHAIN_REQUEST_BUDGET,
                                   deadline=clock() + dt.timedelta(seconds=CHAIN_TIME_BUDGET_S), clock=clock,
                                   sleep=sleep))
        f = held[0]
        s = dt.date.fromisoformat(session)
        params = {"feed": feed, "limit": 1000,
                  "expiration_date_gte": s.isoformat(),
                  "expiration_date_lte": (s + dt.timedelta(days=cfg.chain_expiry_max_days)).isoformat(),
                  "strike_price_gte": f"{close * (1 - cfg.chain_ntm_pct):.2f}",
                  "strike_price_lte": f"{close * (1 + cfg.chain_ntm_pct):.2f}"}
        try:
            pages = f.paged("chain", session, f"/v1beta1/options/snapshots/{symbol.replace('.', '')}", params)
        except sf.FetchError:
            return None
        snaps: dict[str, Any] = {}
        for body in pages:
            got = body.get("snapshots")
            if isinstance(got, Mapping):
                snaps.update(got)
        return ch.parse_snapshots(snaps)
    return read


def _last_close(bars: Any, d: str) -> float | None:
    try:
        parsed = sel.parse_bars(bars)
    except Exception:
        return None
    if not parsed or parsed[-1].d != d or parsed[-1].c <= 0:
        return None
    return parsed[-1].c


def run(session: str, *, now: dt.datetime, read_radar: Callable[[], Any], client: sf.Client, desk: Sequence[str],
        cfg: rc.Config, params: sel.Params, params_sha: str, picker_ref: str, earnings_rows: list[Any],
        macro_rows: list[Any], chain_reader: ChainReader | None, clock: Callable[[], dt.datetime],
        sleep: Callable[[float], None]) -> dict[str, dict[str, Any]]:
    """Every record of one run, by file name (see the module text). Raises sf.TooEarly before D's close is final and
    sf.FetchError when the bars cannot be fetched; nothing is returned then, so nothing is written."""
    if not lv.is_session(session):
        raise ValueError(f"{session} is not a session date")
    d = lv.prev_session(session)
    try:
        edition = read_radar()
        read_problem = None
    except Exception as e:                                  # the reader's failure is the Radar missing, said so
        edition, read_problem = None, type(e).__name__
    cand = rc.extract(edition, session, now, desk, cfg)
    if read_problem and cand["status"] == "radar_missing":
        cand["detail"] = f"the edition could not be read ({read_problem})"
    pending = sorted((c for c in cand["candidates"] if not c["core"]), key=lambda c: un.priority(c, cfg))
    extra = [c["symbol"] for c in pending]
    # The desk's bars first, on their own: a Radar symbol the broker refuses can never cost the desk its Stage 1.
    fetched = sf.fetch_stage1(client, d, list(desk), min_bars=params.min_bars, earnings_rows=earnings_rows,
                              macro_rows=macro_rows, clock=clock, sleep=sleep)
    extra_fetch: str | None = None
    # Fetched whether the gate is set or not: an unset gate admits nothing, but its facts are recorded (DEC-0070
    # section 3: the thresholds are set from them).
    if extra:
        try:
            more = sf.fetch_stage1(client, d, extra, min_bars=params.min_bars, earnings_rows=earnings_rows,
                                   macro_rows=macro_rows, clock=clock, sleep=sleep)
            fetched = {**fetched, "names": fetched["names"] + extra, "bars": {**fetched["bars"], **more["bars"]}}
        except (sf.FetchError, sel.BundleError) as e:    # no bars: every Radar name is rejected on its bars
            extra_fetch = getattr(e, "cause", type(e).__name__)
    chains: dict[str, un.ChainFacts | None] = {}
    if extra and chain_reader is not None:
        for sym in extra:
            close = _last_close(fetched["bars"].get(sym, []), d)
            if close is None:                               # the gate rejects it on its bars first
                continue
            quotes = chain_reader(sym, close, session)
            chains[sym] = None if quotes is None else un.chain_facts(quotes, close, session, cfg,
                                                                      root=sym.replace(".", ""))
    universe = un.gate(cand, desk, fetched["bars"], chains, earnings_rows, params, cfg)
    bundle = bundle_for(fetched, universe["names"])
    out = sel.run_bundle(bundle, params, sha=params_sha, ref=picker_ref)
    records: dict[str, dict[str, Any]] = {
        "candidates.json": cand, "fetch.json": fetched, "universe.json": universe,
        "stage1-bundle.json": bundle, "stage1.json": out,
    }
    deadline = s2.ny_time(session, PUBLISH_BY)
    records["run.json"] = {
        "schema": RUN_SCHEMA, "version": RUN_VERSION, "session": session, "finished_session": d,
        "mode": "shadow", "run_at": now.astimezone(dt.UTC).isoformat(),
        "finished_at": clock().astimezone(dt.UTC).isoformat(), "publish_by": deadline.isoformat(),
        "late": clock() > deadline,
        "radar_status": cand["status"], "radar_detail": cand["detail"],
        "gate_unset": universe["gate_unset"],
        "radar_bars_fetch": "ok" if extra_fetch is None else extra_fetch,
        "desk": list(desk),
        "counts": {"candidates": cand["counts"], "universe": universe["counts"], "stage1": out["counts"]},
        "picks": [{"symbol": s, "origin": universe["origin"].get(s, "core")} for s in out["picks"]],
        "selection_note": out["selection_note"],
        "hashes": {"universe_config": cfg.sha, "params_sha": params_sha, "picker_ref": picker_ref,
                   "bundle_sha": out["bundle_sha"],
                   "edition_sha256": (cand["provenance"] or {}).get("edition_sha256"),
                   **{name: sha_of(doc) for name, doc in records.items()}},
    }
    return records


def today_session(now: dt.datetime) -> str | None:
    """Today in New York, when it is a session; else None."""
    day = now.astimezone(s2.NY).date().isoformat()
    return day if lv.is_session(day) else None


def wait_for_radar(session: str, *, read_radar: Callable[[], Any], desk: Sequence[str], cfg: rc.Config,
                   clock: Callable[[], dt.datetime], sleep: Callable[[float], None]
                   ) -> tuple[Callable[[], Any], dt.datetime, str, int]:
    """Read the Radar until its edition for `session` is fresh (status ok) or it is RADAR_RETRY_UNTIL New York.
    Returns a reader that gives back the last read (its edition, or its exception again), so the run sees one edition
    and one hash; the time of that read (the run's `now`); its status; and how many reads it took."""
    until = s2.ny_time(session, RADAR_RETRY_UNTIL)
    tries = 0
    while True:
        tries += 1
        at = clock()
        edition: Any = None
        failure: Exception | None = None
        try:
            edition = read_radar()
        except Exception as e:                              # read again later; at the end, the run records it
            failure = e
        status = rc.extract(edition, session, at, desk, cfg)["status"]
        if status == "ok" or at >= until:
            def last(edition: Any = edition, failure: Exception | None = failure) -> Any:
                if failure is not None:
                    raise failure
                return edition
            return last, at, status, tries
        sleep(min(RADAR_RETRY_EVERY_S, max(1.0, (until - at).total_seconds())))


def sweep_dead_tmp(root: Path, session: str) -> list[Path]:
    """Remove S's temporary folders left by a run that was killed (its process is gone); a live run's is kept."""
    gone: list[Path] = []
    for tmp in root.glob(f".{session}.tmp-*"):
        try:
            pid = int(tmp.name.rsplit("-", 1)[1])
        except ValueError:
            continue
        try:
            os.kill(pid, 0)
            alive = True
        except ProcessLookupError:
            alive = False
        except PermissionError:                             # another user's process: not ours to judge
            alive = True
        if not alive:
            shutil.rmtree(tmp, ignore_errors=True)
            gone.append(tmp)
    return gone


def bundle_for(fetched: Mapping[str, Any], names: Sequence[str]) -> dict[str, Any]:
    """The Stage 1 bundle for `names` from a fetch for a superset of them."""
    doc = {"schema": sel.BUNDLE_SCHEMA, "version": sel.BUNDLE_VERSION, "session": fetched["session"],
           "adjustment": sel.BUNDLE_ADJUSTMENT, "names": list(names),
           "bars": {n: fetched["bars"].get(n, []) for n in names},
           "earnings_rows": fetched["earnings_rows"], "macro_rows": fetched["macro_rows"]}
    sel.check_bundle(doc)
    return doc


def write_run(root: Path, session: str, records: Mapping[str, Mapping[str, Any]]) -> Path:
    """Write the run's folder whole: a temporary folder, every file, then one rename. Raises FileExistsError when S's
    folder exists (a second run is refused, never merged)."""
    final = root / session
    if final.exists():
        raise FileExistsError(str(final))
    root.mkdir(parents=True, exist_ok=True)
    tmp = root / f".{session}.tmp-{os.getpid()}"
    if tmp.exists():
        shutil.rmtree(tmp)
    tmp.mkdir()
    try:
        for name in [n for n in records if n != "run.json"] + ["run.json"]:
            s2.write_new(tmp / name, sel.dumps(records[name]))
        if final.exists():                                 # a run that finished meanwhile wins; this one is dropped
            raise FileExistsError(str(final))
        try:
            os.rename(tmp, final)
        except OSError as e:                               # macOS: ENOTEMPTY/EEXIST when another run won the race
            if final.exists():
                raise FileExistsError(str(final)) from e
            raise
        fd = os.open(root, os.O_RDONLY)
        try:
            os.fsync(fd)                                   # the rename itself survives a power cut
        finally:
            os.close(fd)
    except BaseException:
        shutil.rmtree(tmp, ignore_errors=True)
        raise
    return final


def replay(folder: Path, desk: Sequence[str], cfg: rc.Config, params: sel.Params, params_sha: str,
           picker_ref: str) -> list[str]:
    """What differs between the saved run and a recomputation from its saved inputs; empty when it reproduces."""
    def load(name: str) -> dict[str, Any]:
        doc = json.loads((folder / name).read_text(encoding="utf-8"))
        if not isinstance(doc, dict):
            raise ValueError(f"{name} is not an object")
        return doc
    saved = {n: load(n) for n in ("candidates.json", "fetch.json", "universe.json", "stage1-bundle.json",
                                  "stage1.json", "run.json")}
    problems = [f"{n}: sha256 differs from run.json" for n, doc in saved.items()
                if n != "run.json" and saved["run.json"]["hashes"].get(n) != sha_of(doc)]
    if cfg.sha != saved["run.json"]["hashes"]["universe_config"]:
        problems.append("universe config changed since the run")
    if params_sha != saved["run.json"]["hashes"]["params_sha"]:
        problems.append("Stage 1 params changed since the run")
    if picker_ref != saved["run.json"]["hashes"]["picker_ref"]:
        problems.append("Stage 1 code changed since the run (picker_ref)")
    if list(desk) != saved["run.json"]["desk"]:
        problems.append("the desk's names changed since the run (options_desk.yaml)")
    desk = saved["run.json"]["desk"]
    chains = {v["symbol"]: None if v["chain"] is None else un.ChainFacts(**v["chain"])
              for v in saved["universe.json"]["verdicts"] if v["chain"] is not None or v["reject"] == "chain_unavailable"}
    uni = un.gate(saved["candidates.json"], desk, saved["fetch.json"]["bars"], chains,
                  saved["fetch.json"]["earnings_rows"], params, cfg)
    if sha_of(uni) != sha_of(saved["universe.json"]):
        problems.append("universe.json does not reproduce")
    bundle = bundle_for(saved["fetch.json"], uni["names"])
    if sha_of(bundle) != sha_of(saved["stage1-bundle.json"]):
        problems.append("stage1-bundle.json does not reproduce")
    out = sel.run_bundle(bundle, params, sha=params_sha, ref=picker_ref)
    if sha_of(out) != sha_of(saved["stage1.json"]):
        problems.append("stage1.json does not reproduce")
    return problems


def _count_of(v: Any) -> int | None:
    return v if isinstance(v, int) and not isinstance(v, bool) and v >= 0 else None


def check_run(folder: Path, desk: Sequence[str], cfg: rc.Config, params: sel.Params, params_sha: str,
              picker_ref: str, *, published: tuple[Mapping[str, Any] | None, str | None] | None,
              checked_at: dt.datetime) -> dict[str, Any]:
    """The check record of one written run (see the module text). `published`: what the dashboard's focus route
    gave, (focus block, its session), or None when it was not read. Raises OSError or ValueError when the run's
    `run.json` cannot be read: there is nothing to check then."""
    run_doc = json.loads((folder / "run.json").read_text(encoding="utf-8"))
    if not isinstance(run_doc, dict) or run_doc.get("schema") != RUN_SCHEMA:
        raise ValueError("run.json is not a run record")
    session = str(run_doc.get("session"))
    try:
        problems = replay(folder, desk, cfg, params, params_sha, picker_ref)
        replay_word = "reproduces" if not problems else "differs"
    except (OSError, ValueError, KeyError, TypeError, AttributeError, sel.BundleError):
        replay_word = "error"
    verdicts: int | None = None
    with_facts: int | None = None
    universe_version: int | None = None
    try:
        uni = json.loads((folder / "universe.json").read_text(encoding="utf-8"))
        if isinstance(uni, dict) and isinstance(uni.get("verdicts"), list):
            universe_version = _count_of(uni.get("version"))
            verdicts = len(uni["verdicts"])
            with_facts = sum(1 for v in uni["verdicts"] if isinstance(v, Mapping) and v.get("facts") is not None)
    except (OSError, ValueError):
        pass
    raw_counts = run_doc.get("counts")
    counts: Mapping[str, Any] = raw_counts if isinstance(raw_counts, Mapping) else {}
    raw_cand = counts.get("candidates")
    cand: Mapping[str, Any] = raw_cand if isinstance(raw_cand, Mapping) else {}
    n_candidates = _count_of(cand.get("candidates"))
    n_discovered = _count_of(cand.get("discovered"))       # the Radar's names new to the desk: the ones the gate sees
    raw_picks = run_doc.get("picks")
    picks = [p["symbol"].upper() for p in (raw_picks if isinstance(raw_picks, list) else [])
             if isinstance(p, Mapping) and isinstance(p.get("symbol"), str)]
    if published is None:
        pub: dict[str, Any] = {"status": "not_read", "overlap": None, "of": None}
    else:
        focus, pub_session = published
        items = (focus or {}).get("items") if isinstance(focus, Mapping) else None
        if pub_session is None or not isinstance(items, list):
            pub = {"status": "unreadable", "overlap": None, "of": None}
        elif pub_session != session:
            pub = {"status": "other_session", "overlap": None, "of": None}
        else:
            names = {str(i["symbol"]).upper() for i in items if isinstance(i, Mapping) and isinstance(i.get("symbol"), str)}
            pub = {"status": "ok", "overlap": len(names & set(picks)), "of": len(names)}
    why = {
        "radar_not_ok": run_doc.get("radar_status") != "ok",
        "late": run_doc.get("late") is not False,
        "radar_bars_failed": run_doc.get("radar_bars_fetch") != "ok",
        "no_radar_candidates": not n_discovered,                    # a run on the desk's names alone does not count
        "facts_missing": universe_version is None or universe_version < FACTS_VERSION or verdicts is None
                         or with_facts != verdicts,
        "replay_differs": replay_word == "differs",
        "replay_error": replay_word == "error",
    }
    reasons = [code for code in NOT_CLEAN if why[code]]
    return {
        "schema": CHECK_SCHEMA, "version": CHECK_VERSION, "session": session,
        "checked_at": checked_at.astimezone(dt.UTC).isoformat(),
        "clean": not reasons, "reasons": reasons, "replay": replay_word,
        "universe_version": universe_version, "verdicts": verdicts, "verdicts_with_facts": with_facts,
        "candidates": n_candidates, "discovered": n_discovered, "picks": len(picks), "published": pub,
    }


def write_check(folder: Path, doc: Mapping[str, Any]) -> Path:
    """Write (or rewrite) the run folder's `check.json` atomically: a temporary file beside it, then one rename."""
    path = folder / CHECK_FILE
    fd, tmp = tempfile.mkstemp(prefix=f".{CHECK_FILE}.", dir=folder)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(sel.dumps(doc))
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise
    return path


def page_text(session: str, reasons: Sequence[str]) -> tuple[str, str]:
    """The phone page for a session that is not clean: the date and the reason codes, nothing else."""
    from wt.ops.alerts import day, word
    codes = ", ".join(dict.fromkeys(word(r, NOT_CLEAN) for r in reasons)) or "unknown"
    return ("Options shadow: session not clean",
            f"The Radar to Options shadow run for {day(session)} does not count toward the {CLEAN_NEEDED} clean "
            f"sessions: {codes}. See the Radar page or run: radar_select check.")


def page_not_clean(session: str, reasons: Sequence[str], sender: Any = None) -> bool:
    """Page once for `session` (a New York day) when its run is not clean."""
    from wt.ops.alerts import Alerts
    title, message = page_text(session, reasons)
    return bool((sender if sender is not None else Alerts()).once_per_day(
        "options-select:not-clean", title, message, 3, day=session))


def check_folders(root: Path, session: str, desk: Sequence[str], cfg: rc.Config, params: sel.Params,
                  params_sha: str, picker_ref: str, *, clock: Callable[[], dt.datetime],
                  read_published: Callable[[], tuple[Mapping[str, Any] | None, str | None]],
                  sender: Any = None) -> dict[str, Any] | None:
    """The job's check after its run: S's folder (re)checked with the published focus read now, then every earlier
    run folder that has no `check.json`, checked without it. Pages when S is not clean. Returns S's check record,
    or None when S's run cannot be read. Never raises for a bad folder: the run is already written."""
    out: dict[str, Any] | None = None
    folder = root / session
    if folder.is_dir():
        try:
            published = read_published()
        except Exception:  # noqa: BLE001 (an unreadable focus is a word in the record, not a failed job)
            published = (None, None)
        try:
            out = check_run(folder, desk, cfg, params, params_sha, picker_ref, published=published,
                            checked_at=clock())
            write_check(folder, out)
        except Exception as e:  # noqa: BLE001 (the run is written; a check that breaks never fails the job)
            print(f"radar_select job {session}: check: {type(e).__name__}", file=sys.stderr)
            out = None
    earlier = sorted(p for p in root.iterdir() if p.is_dir() and _DAY_DIR.fullmatch(p.name) and p.name < session
                     and not (p / CHECK_FILE).exists()) if root.is_dir() else []
    for old in earlier:
        try:
            write_check(old, check_run(old, desk, cfg, params, params_sha, picker_ref, published=None,
                                       checked_at=clock()))
            print(f"radar_select job {session}: checked the earlier run {old.name}")
        except Exception as e:  # noqa: BLE001 (an old folder that cannot be checked is skipped, said in the log)
            print(f"radar_select job {session}: check of {old.name}: {type(e).__name__}", file=sys.stderr)
    if out is not None and not out["clean"]:
        try:
            page_not_clean(session, out["reasons"], sender)
        except Exception as e:  # noqa: BLE001 (a page that cannot be sent never fails the job)
            print(f"radar_select job {session}: page: {type(e).__name__}", file=sys.stderr)
    return out


def check_line(doc: Mapping[str, Any]) -> str:
    """One line for a terminal: the verdict, the reasons, the replay, the facts and the overlap count."""
    pub = doc.get("published") or {}
    overlap = (f"{pub.get('overlap')} of {pub.get('of')} picks in the published focus" if pub.get("status") == "ok"
               else f"published focus {pub.get('status')}")
    return (f"{'CLEAN' if doc.get('clean') is True else 'NOT CLEAN'}"
            f"{'' if doc.get('clean') else ' (' + ', '.join(doc.get('reasons') or []) + ')'}; replay {doc.get('replay')}; "
            f"facts on {doc.get('verdicts_with_facts')} of {doc.get('verdicts')} verdicts (universe v{doc.get('universe_version')}); "
            f"{doc.get('discovered')} new to the desk of {doc.get('candidates')} candidates; {overlap}")


# ---------------------------------------------------------------- command line

class _Parser(argparse.ArgumentParser):
    def error(self, message: str) -> Any:
        print(f"radar_select: usage: {message}", file=sys.stderr)
        raise SystemExit(EXIT_USAGE)


def _now() -> dt.datetime:
    return dt.datetime.now(dt.UTC)


def _read_radar() -> Any:
    from wt.options.pipeline_check import read_edition
    return read_edition("radar")


def _read_published() -> tuple[Mapping[str, Any] | None, str | None]:
    from wt.options.clone_site import read_focus
    return read_focus()


def main(argv: list[str] | None = None, *, client: Callable[[], sf.Client] = sf._client,
         read_radar: Callable[[], Any] = _read_radar, clock: Callable[[], dt.datetime] = _now,
         sleep: Callable[[float], None] | None = None, chain_feed: str = "indicative",
         read_published: Callable[[], tuple[Mapping[str, Any] | None, str | None]] = _read_published,
         sender: Any = None) -> int:
    import time
    ap = _Parser(prog="python -m wt.options.radar_select", description="Radar → Options selection (shadow)")
    sub = ap.add_subparsers(dest="cmd", required=True, parser_class=_Parser)
    for name in ("run", "replay", "job", "check"):
        a = sub.add_parser(name)
        if name != "job":
            a.add_argument("--session", required=True)
        if name == "check":
            a.add_argument("--again", action="store_true", help="rewrite an existing check.json")
        a.add_argument("--root", type=Path, default=VAR)
    try:
        args = ap.parse_args(argv)
    except SystemExit as e:
        return e.code if isinstance(e.code, int) else EXIT_USAGE
    job = args.cmd == "job"
    try:
        cfg = rc.load_config()
        params, psha = sel.load_params()
        ref = sel.picker_ref()
        desk = sf.desk_names()
    except (rc.ConfigError, sel.ParamsError, OSError, ValueError) as e:
        print(f"radar_select: configuration: {e}", file=sys.stderr)
        return EXIT_ERROR
    if job:
        session = today_session(clock())
        if session is None:
            print("radar_select job: today is not a session; nothing to select")
            return EXIT_OK
        if (args.root / OFF).exists():
            print(f"radar_select job {session}: {args.root.name}/{OFF} exists; nothing run, nothing written")
            return EXIT_OK
    else:
        session = args.session
        if rc.ev_date(session) is None or not lv.is_session(session):
            print("radar_select: --session must be a session date written YYYY-MM-DD", file=sys.stderr)
            return EXIT_USAGE
    if args.cmd == "replay":
        try:
            problems = replay(args.root / session, desk, cfg, params, psha, ref)
        except (OSError, ValueError, KeyError) as e:
            print(f"radar_select: replay: cannot read the run ({type(e).__name__})", file=sys.stderr)
            return EXIT_ERROR
        for p in problems:
            print(f"radar_select: replay: {p}", file=sys.stderr)
        print(f"radar_select replay {session}: {'reproduces' if not problems else 'DIFFERS'}")
        return EXIT_REPLAY if problems else EXIT_OK
    if args.cmd == "check":
        kept = args.root / session / CHECK_FILE
        if kept.exists() and not args.again:
            try:
                old = json.loads(kept.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                old = None
            if isinstance(old, dict):
                print(f"radar_select check {session}: kept (--again rewrites it): {check_line(old)}")
                return EXIT_OK if old.get("clean") is True else EXIT_NOT_CLEAN
        try:
            published = read_published()
        except Exception:  # noqa: BLE001 (an unreadable focus is a word in the record)
            published = (None, None)
        try:
            doc = check_run(args.root / session, desk, cfg, params, psha, ref, published=published,
                            checked_at=clock())
            write_check(args.root / session, doc)
        except (OSError, ValueError, KeyError, TypeError, AttributeError) as e:
            print(f"radar_select: check: cannot read the run ({type(e).__name__})", file=sys.stderr)
            return EXIT_ERROR
        print(f"radar_select check {session}: {check_line(doc)}")
        return EXIT_OK if doc["clean"] else EXIT_NOT_CLEAN
    # A job's second run for S (a restart, a run by hand) is not a failure: the first run's folder stands.
    exists = EXIT_OK if job else EXIT_EXISTS
    if (args.root / session).exists():
        print(f"radar_select {args.cmd} {session}: already run; nothing written")
        return exists
    pause = sleep or time.sleep
    try:
        c = client()
        reader, now, tries = read_radar, clock(), 1
        if job:
            for gone in sweep_dead_tmp(args.root, session) if args.root.is_dir() else []:
                print(f"radar_select job {session}: removed {gone.name}, left by a run that was stopped")
            # The reader's module is imported before the wait: a deploy may switch the checkout under a waiting job.
            if read_radar is _read_radar:
                import wt.options.pipeline_check  # noqa: F401
            reader, now, status, tries = wait_for_radar(session, read_radar=read_radar, desk=desk, cfg=cfg,
                                                        clock=clock, sleep=pause)
            print(f"radar_select job {session}: radar {status} after {tries} read{'s' if tries > 1 else ''}")
        records = run(session, now=now, read_radar=reader, client=c, desk=desk, cfg=cfg,
                      params=params, params_sha=psha, picker_ref=ref, earnings_rows=read_earnings(),
                      macro_rows=sf.read_rows(sf.EVENTS / "macro_events.csv"),
                      chain_reader=alpaca_chain_reader(c, feed=chain_feed, clock=clock, sleep=pause, cfg=cfg),
                      clock=clock, sleep=pause)
        folder = write_run(args.root, session, records)
    except sf.TooEarly as e:
        print(f"radar_select: too early: {e}", file=sys.stderr)
        return EXIT_TOO_EARLY
    except sf.FetchError as e:
        print(f"radar_select: fetch: {e}", file=sys.stderr)
        return EXIT_ERROR
    except FileExistsError:
        print(f"radar_select {args.cmd} {session}: already run; nothing written")
        return exists
    except (sel.BundleError, sel.CalendarError, OSError, ValueError) as e:
        print(f"radar_select: {type(e).__name__}: {e}", file=sys.stderr)
        return EXIT_ERROR
    r = records["run.json"]
    if job:
        try:
            checked = check_folders(args.root, session, desk, cfg, params, psha, ref, clock=clock,
                                    read_published=read_published, sender=sender)
        except Exception as e:  # noqa: BLE001 (the run is written: its check never fails the job)
            print(f"radar_select job {session}: check: {type(e).__name__}", file=sys.stderr)
            checked = None
        print(f"radar_select job {session}: check: {check_line(checked) if checked else 'not written'}")
    print(f"radar_select {args.cmd} {session}: radar {r['radar_status']}, "
          f"{r['counts']['universe']['admitted']} admitted of {r['counts']['universe']['candidates_gated']} gated, "
          f"picks {' '.join(p['symbol'] for p in r['picks']) or '(none)'}{' LATE' if r['late'] else ''}; {folder}")
    return EXIT_OK

if __name__ == "__main__":
    raise SystemExit(main())
