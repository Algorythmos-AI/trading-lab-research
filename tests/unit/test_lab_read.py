"""Research reads of the tape (wt.lab.read) against planted answers: a synthetic exchange logs every quote it served,
the recorder writes the tape, and the reader must give back exactly what was known at each instant: the served quote
where the contract was sampled and answered, Missing where the request failed or nothing ran, stale where the feed
froze. The freeze is recounted from the exchange's own log, not from the recorder's counters."""
from __future__ import annotations

import datetime as dt
import json
from pathlib import Path
from typing import Any

import pyarrow.parquet as pq
import pytest
from test_lab_recorder import DAY, START, Alpaca, Clock, calendar, make  # noqa: F401 (calendar: the fixture)

from wt.lab import manifest, read, recorder
from wt.lab.recorder import ns_of
from wt.lab.tape import ts_ns

TICK = dt.timedelta(seconds=5)


def record(tmp_path: Path, minutes: float, api_kw: dict[str, Any] | None = None, stale_after_s: float = 12.0,
           freeze: tuple[float, float] | None = None) -> tuple[recorder.Recorder, dict[str, Any], Alpaca]:
    clock = Clock(START - dt.timedelta(seconds=30))
    api = Alpaca(clock, **(api_kw or {}))
    if freeze:
        api.frozen = (START + dt.timedelta(minutes=freeze[0]), START + dt.timedelta(minutes=freeze[1]))
    rec = make(tmp_path, clock, api, settings=recorder.Settings(stale_after_s=stale_after_s))
    rec.run(START, START + dt.timedelta(minutes=minutes))
    doc = rec.finish({"focus_session": DAY.isoformat(), "names": ["AAA", "BBB"]})
    return rec, doc, api


def truth(api: Alpaca, sym: str, t: dt.datetime) -> tuple[float | None, float | None] | None | str:
    """What a trader could know about `sym` at `t` from the exchange's own log: the last answer, or why none."""
    seen = [x for x in api.served.get(sym, []) if x[0] <= t]
    if not seen:
        return "none"
    when, bid, ask, _ = seen[-1]
    if bid is None and ask is None:
        return "failed"
    if (t - when).total_seconds() > read.TIER1_WINDOW_S:
        return "old"
    return (bid, ask)


def test_every_instant_reads_back_exactly_what_was_served(tmp_path: Path) -> None:
    rec, doc, api = record(tmp_path, 8, {"fail_tier1": {9, 30}})
    s = read.open_session(rec.folder)
    opening = sorted(doc["opening_tier1"])
    checked = missing = 0
    for k in range(doc["freeze_tick"] + 1, doc["ticks_scheduled"]):
        t = START + k * TICK + dt.timedelta(seconds=4.9)               # late in the tick, after its sweep
        for sym in opening:
            got, want = s.quote_at(sym, ns_of(t)), truth(api, sym, t)
            if isinstance(want, tuple):
                assert isinstance(got, read.Quote) and (got.bid, got.ask) == want, (k, sym, got, want)
                assert got.age_s is not None and 0 <= got.age_s < 15
                checked += 1
            else:
                assert isinstance(got, read.Missing), (k, sym, got, want)
                missing += 1
    assert checked > 1000 and missing > 0                             # both failed sweeps are seen, nothing else


def test_nothing_is_known_before_it_was_received(tmp_path: Path) -> None:
    rec, doc, api = record(tmp_path, 3)
    s = read.open_session(rec.folder)
    sym = sorted(doc["opening_tier1"])[0]
    for when, _bid, _ask, _ in api.served[sym][5:15]:
        before = s.quote_at(sym, ns_of(when) - 1)                       # a nanosecond before the answer arrived
        assert not (isinstance(before, read.Quote) and before.sampled_ns >= ns_of(when))


def test_a_frozen_feed_is_stale_and_counted_the_same_from_the_exchanges_own_log(tmp_path: Path) -> None:
    rec, doc, api = record(tmp_path, 10, freeze=(3, 5))
    # recount from the exchange: per tier-1 sweep after the freeze, the newest quote it served and when
    t1 = set(doc["opening_tier1"])
    per_tick: dict[int, float] = {}
    for when, syms, newest in api.answers:
        if not t1 & set(syms):
            continue
        k = int((when - START).total_seconds() // 5)
        age = (ns_of(when) - (ts_ns(newest) or 0)) / 1e9
        per_tick[k] = min(per_tick.get(k, 1e9), age)
    stale = sorted(k for k, a in per_tick.items() if k > doc["freeze_tick"] and a > 12.0)
    assert len(stale) >= 18 and doc["stale_ticks"] == len(stale)       # a two-minute freeze, its first ticks fresh
    assert doc["longest_stale_s"] == len(stale) * 5.0
    assert doc["coverage"] > 0.99 and doc["coverage_fresh"] < doc["coverage"] - 0.15
    s = read.open_session(rec.folder)
    assert all(not s.fresh(k) for k in stale) and s.fresh(stale[0] - 4) and s.fresh(stale[-1] + 2)
    reasons = [g["reason"] for g in s.gaps if g["stream"] == "feed"]
    assert reasons[0].startswith("stale: newest tier-1 quote") and reasons[1] == f"fresh again after {len(stale)} stale ticks"


def test_ticks_nobody_ran_are_missing_and_said(tmp_path: Path) -> None:
    clock = Clock(START - dt.timedelta(seconds=30))
    api = Alpaca(clock, exit_at_stock=40)                               # stopped at the 40th tick
    rec = make(tmp_path, clock, api)
    rec.run(START, START + dt.timedelta(minutes=8))
    recorder.TERM.clear()
    rec.flush()
    clock.t = START + dt.timedelta(minutes=5)                           # restarted two minutes later
    rec2 = make(tmp_path, clock, api)
    rec2.run(START, START + dt.timedelta(minutes=8))
    doc = rec2.finish({"focus_session": DAY.isoformat(), "names": ["AAA", "BBB"]})
    assert doc["ticks_down"] == 20 and doc["restarts"] == 1               # ticks 40 to 59: 03:20 to 05:00
    assert doc["rows"]["option"] == sum(pq.ParquetFile(p).metadata.num_rows for p in rec2.folder.glob("option-*"))
    s = read.open_session(rec2.folder)
    sym = sorted(doc["opening_tier1"])[0]
    gone = s.quote_at(sym, ns_of(START + dt.timedelta(minutes=4, seconds=30)))
    assert isinstance(gone, read.Missing) and gone.reason.startswith("no sample for")
    assert any(g["reason"].startswith("not running: ") and "(a restart)" in g["reason"] for g in s.gaps)


def test_membership_and_the_cap_are_on_the_tape(tmp_path: Path) -> None:
    from wt.lab import tiers
    clock = Clock(START - dt.timedelta(seconds=30))
    api = Alpaca(clock, mids={"AAA": [100.0] * 30 + [104.0] * 400})     # AAA moves: new strikes come near the money
    rec = make(tmp_path, clock, api)
    rec.rules = tiers.Rules(t1_max_per_name=12)
    rec.run(START, START + dt.timedelta(minutes=6))
    doc = rec.finish({"focus_session": DAY.isoformat(), "names": ["AAA", "BBB"]})
    s = read.open_session(rec.folder)
    joined = [m for m in s.members if m["tier"] == 1]
    capped = [m for m in s.members if m["event"] == "cap"]
    assert len({m["symbol"] for m in joined}) == doc["tier1_final"] and capped and doc["tier1_refused_by_cap"] == len(capped)
    assert len({m["symbol"] for m in capped}) == len(capped)            # each refusal once


def test_a_session_that_cannot_be_trusted_is_refused(tmp_path: Path) -> None:
    rec, doc, _ = record(tmp_path, 2)
    read.open_session(rec.folder)
    part = sorted(rec.folder.glob("option-*.parquet"))[0]
    part.write_bytes(part.read_bytes() + b"x")
    with pytest.raises(read.NotReadable, match="differ"):
        read.open_session(rec.folder)
    old = tmp_path / "old" / "2026-11-19"
    old.mkdir(parents=True)
    manifest.write(old, {"recorded": True, "focus_session": "2026-11-19"})
    with pytest.raises(read.NotReadable, match="before the sample stream"):
        read.open_session(old)
    with pytest.raises(read.NotReadable, match="not finished"):
        read.open_session(tmp_path / "nowhere")


def test_the_same_exchange_gives_the_same_tape(tmp_path: Path) -> None:
    a, _, _ = record(tmp_path / "a", 4, {"fail_tier1": {7}}, freeze=(1, 2))
    b, _, _ = record(tmp_path / "b", 4, {"fail_tier1": {7}}, freeze=(1, 2))
    for stream in ("option", "stock", "sample", "gap", "member"):
        ta = [r for p in sorted(a.folder.glob(f"{stream}-*.parquet")) for r in pq.read_table(p).to_pylist()]
        tb = [r for p in sorted(b.folder.glob(f"{stream}-*.parquet")) for r in pq.read_table(p).to_pylist()]
        assert ta == tb, stream
    da, db = (json.loads((x.folder / manifest.NAME).read_text()) for x in (a, b))
    drop = {"files", "previous_manifest_sha256"}
    assert {k: v for k, v in da.items() if k not in drop} == {k: v for k, v in db.items() if k not in drop}
