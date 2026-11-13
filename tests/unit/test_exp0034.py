"""EXP-0034's outcome code and read script (DEC-0051 section 8), on synthetic data only.

Nothing here reads a real signal record, journal, ledger, bar or result: every record, stamp and bar is built below.
"""
from __future__ import annotations

import copy
import hashlib
import json
import math
import subprocess
import sys
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from typing import Any

import numpy as np
import pytest
import yaml

from wt.research import exp0034_outcome as oc
from wt.research import exp0034_read as er
from wt.research.signal_record import parse_signal_record

ROOT = Path(__file__).resolve().parents[2]
CONFIG = ROOT / "research" / "experiments" / "EXP-0034-desk-signal-gates" / "config.yaml"
SCRIPT = ROOT / "scripts" / "exp0034_read.py"
# The outcome code's hash, frozen with precondition 3. Changing it is an early end unless a dated README note records
# a defect fix before the read; update this pin only in that pull request.
FROZEN_SHA256 = {
    "src/wt/research/exp0034_outcome.py": "575956bd51b46c59b326071074f23fdb026e07d876ec4c1b710be1fcc0aebc1d",
    "src/wt/research/exp0034_read.py": "dcb0bfe97dbc6e5affad0b39db88a7fd44693dc734256ac1cdb869ac2b79eb05",
    "src/wt/research/signal_record.py": "5ef275788245357df8672f6041946b2fa505295c0d12be0ab0a4747f25305076",
    "scripts/exp0034_read.py": "a16fed06d389c4a9febe826b7c86591023d1882ba079147086bf69eb8be0a522",
}
OUTCOME_SHA256 = FROZEN_SHA256["src/wt/research/exp0034_outcome.py"]
PH = "a" * 64
CH = "c0de"
ENGINE = "e-synthetic"
FROZEN = er.Frozen(PH, frozenset({CH}), frozenset({ENGINE}), OUTCOME_SHA256)


def ms(day: str, hh: int, mm: int, ss: int = 0) -> int:
    return int(datetime.combine(date.fromisoformat(day), time(hh, mm, ss), oc.NY).timestamp() * 1000)


def iso(t: int) -> str:
    return datetime.fromtimestamp(t // 1000, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{t % 1000:03d}Z"


# ---- the generator, the percentile ----------------------------------------------------------------------------------
def test_generator_vectors_match_config() -> None:
    cfg = yaml.safe_load(CONFIG.read_text())["statistics"]
    assert cfg["seed"] == er.SEED and cfg["resamples"] == er.RESAMPLES and cfg["prng"] == "mulberry32"
    for seed, want in cfg["generator_test_vectors"].items():
        nxt = er.mulberry32(int(seed))
        assert [nxt(), nxt(), nxt()] == want


def test_percentile_is_numpy_linear() -> None:
    assert er.percentile([1.0, 2.0, 3.0, 4.0], 50) == 2.5
    assert er.percentile([0.0, 10.0], 2.5) == pytest.approx(0.25)
    assert er.percentile([5.0], 97.5) == 5.0
    rng = np.random.default_rng(1)
    for n in (2, 7, 5000):
        d = sorted(rng.normal(size=n).tolist())
        for p in (0, 2.5, 50, 97.5, 100):
            assert er.percentile(d, p) == pytest.approx(float(np.percentile(d, p, method="linear")), abs=1e-12)


def test_bootstrap_is_deterministic_and_discards_empty_groups() -> None:
    per = [(1.0, 1, 0.0, 0), (0.0, 0, -1.0, 1), (2.0, 2, 1.0, 2)]
    d1, n1 = er.bootstrap(per, keep=200)
    d2, n2 = er.bootstrap(per, keep=200)
    assert d1 == d2 and n1 == n2 and len(d1) == 200 and n1 >= 200 and d1 == sorted(d1)
    # the draw is floor(u x n) with u = next() / 2**32, from the configured seed
    nxt = er.mulberry32(er.SEED)
    first = [math.floor(nxt() / 2 ** 32 * 3) for _ in range(3)]
    assert all(0 <= i < 3 for i in first)
    with pytest.raises(ValueError):
        er.bootstrap([(1.0, 1, 0.0, 0)], keep=10)


# ---- the outcome code ---------------------------------------------------------------------------------------------
DAY = "2027-03-01"
CLOCK = oc.session_clock(DAY, False)


def flat_bars(day: str = DAY, price: float = 100.0, half: bool = False, skip: tuple[int, ...] = ()) -> list[oc.Bar]:
    c = oc.session_clock(day, half)
    n = (c.close_ms - c.open_ms) // 60_000
    return [oc.Bar(c.open_ms + i * 60_000, price, price + 0.05, price - 0.05, price, 100.0)
            for i in range(n) if i not in skip]


def test_frozen_code_hashes_are_pinned() -> None:
    for rel, want in FROZEN_SHA256.items():
        assert hashlib.sha256((ROOT / rel).read_bytes()).hexdigest() == want, rel
    assert er.read_code_sha256() == FROZEN_SHA256["src/wt/research/exp0034_read.py"]
    assert oc.outcome_code_sha256() == OUTCOME_SHA256
    assert oc.outcome_code_sha256() == hashlib.sha256(Path(oc.__file__).read_bytes()).hexdigest()


def test_join_and_usable() -> None:
    b2 = oc.join_2m(flat_bars(), CLOCK)
    assert len(b2) == 195 and b2[0].t == CLOCK.open_ms and b2[-1].t == CLOCK.close_ms - oc.BAR_MS
    assert b2[0].v == 200.0 and oc.usable(b2, CLOCK)
    # a bar starting at 16:00 is dropped; one before 09:30 too
    extra = flat_bars() + [oc.Bar(CLOCK.close_ms, 1, 999, 0, 1, 1), oc.Bar(CLOCK.open_ms - 60_000, 1, 999, 0, 1, 1)]
    assert oc.join_2m(extra, CLOCK) == b2
    # five missing slots usable, six not; the last slot missing not usable
    five = flat_bars(skip=tuple(i for k in range(10, 15) for i in (2 * k, 2 * k + 1)))
    six = flat_bars(skip=tuple(i for k in range(10, 16) for i in (2 * k, 2 * k + 1)))
    assert oc.usable(oc.join_2m(five, CLOCK), CLOCK) and not oc.usable(oc.join_2m(six, CLOCK), CLOCK)
    assert not oc.usable(oc.join_2m(flat_bars(skip=(388, 389)), CLOCK), CLOCK)
    half = oc.session_clock("2027-11-26", True)
    assert half.slots == 105 and oc.usable(oc.join_2m(flat_bars("2027-11-26", half=True), half), half)


def test_entry_bar_boundary() -> None:
    b2 = oc.join_2m(flat_bars(), CLOCK)
    t = ms(DAY, 10, 0)
    assert b2[oc.entry_index(b2, t)].t == t                     # a bar starting exactly at the evaluation time
    assert b2[oc.entry_index(b2, t + 1)].t == t + oc.BAR_MS
    assert oc.entry_index(b2, CLOCK.close_ms - oc.BAR_MS + 1) is None
    o = oc.break_outcome(flat_bars(), CLOCK, CLOCK.close_ms - 1000, "call", 100.0, 99.0, 102.0)
    assert o.status == "no_entry_bar"
    assert oc.break_outcome(None, CLOCK, t, "call", 100, 99, 102).status == "bars_incomplete"


def _bars2(rows: list[tuple[float, float, float, float]]) -> list[oc.Bar]:
    return [oc.Bar(i * oc.BAR_MS, o, h, low, c, 1) for i, (o, h, low, c) in enumerate(rows)]


def test_after_fill_rules() -> None:
    # target first on the fill bar
    e = oc.after_fill(_bars2([(100, 102.5, 99.5, 100), (100, 100, 90, 90)]), 0, "call", 102.0, 99.0)
    assert (e.price, e.why, e.bar) == (102.0, "target1", 0)
    # the fill bar closing through the stop does not stop it; a later close strictly through does
    e = oc.after_fill(_bars2([(100, 100, 98, 98.5), (99, 99, 98, 99.0), (99, 99, 98, 98.9)]), 0, "call", 102.0, 99.0)
    assert (e.price, e.why, e.bar) == (98.9, "stopped", 2)
    # both on one bar: stopped at that close
    e = oc.after_fill(_bars2([(100, 100, 100, 100), (100, 103, 97, 98)]), 0, "call", 102.0, 99.0)
    assert (e.price, e.why) == (98, "same_bar_conflict")
    # neither: the last bar's close
    e = oc.after_fill(_bars2([(100, 100.5, 99.5, 100), (100, 100.5, 99.5, 100.25)]), 0, "call", 102.0, 99.0)
    assert (e.price, e.why) == (100.25, "session_close")
    # put mirrored
    e = oc.after_fill(_bars2([(100, 100, 100, 100), (100, 101.5, 100, 101.2)]), 0, "put", 98.0, 101.0)
    assert (e.price, e.why) == (101.2, "stopped")


def test_r_sign_and_rounding() -> None:
    assert oc.r_multiple("call", 102.0, 100.0, 100.0, 99.0) == 2.0
    assert oc.r_multiple("put", 98.0, 100.0, 100.0, 101.0) == 2.0
    assert oc.r_multiple("put", 101.0, 100.0, 100.0, 101.0) == -1.0
    assert oc.r_multiple("call", 100.125, 100.0, 100.0, 99.0) == 0.13
    with pytest.raises(ValueError):
        oc.r_multiple("call", 1, 1, 1, 1)


def test_no_future_bar_leaks_into_the_outcome() -> None:
    """Bars before the entry bar and after the close cannot change the outcome; a change after the exit bar cannot."""
    base = flat_bars()
    t = ms(DAY, 11, 0)
    o = oc.break_outcome(base, CLOCK, t, "call", 100.0, 99.0, 100.04)
    assert o.status == "scored" and o.exit is not None and o.exit.why == "target1"
    i_entry = (t - CLOCK.open_ms) // 60_000
    before = [oc.Bar(b.t, b.o, 500.0, 1.0, b.c, b.v) if i < i_entry else b for i, b in enumerate(base)]
    after_exit = [oc.Bar(b.t, b.o, 500.0, 1.0, 1.0, b.v) if b.t >= o.exit_bar_end else b for b in base]  # type: ignore[operator]
    late = base + [oc.Bar(CLOCK.close_ms + 60_000 * k, 1, 900, 0.5, 1, 1) for k in range(5)]
    for bars in (before, after_exit, late):
        assert oc.break_outcome(bars, CLOCK, t, "call", 100.0, 99.0, 100.04) == o
    # a bar that leaked in from before the evaluation would be the entry bar: the entry is never earlier than t
    assert o.entry_bar_start is not None and o.entry_bar_start >= t


class FakeREST:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def bars(self, symbols: list[str], timeframe: str, start: str, end: str, feed: str = "", adjustment: str = ""
             ) -> Any:
        import pandas as pd
        self.calls.append({"symbols": symbols, "timeframe": timeframe, "feed": feed, "adjustment": adjustment,
                           "start": start, "end": end})
        rows = [{"symbol": "AAA", "t": pd.Timestamp(b.t, unit="ms", tz="UTC"), "o": b.o, "h": b.h, "l": b.low,
                 "c": b.c, "v": b.v} for b in flat_bars()[:3]]
        return pd.DataFrame(rows)


def test_fetch_names_sip_waits_for_the_close_and_saves_once(tmp_path: Path) -> None:
    fake = FakeREST()
    with pytest.raises(RuntimeError):
        oc.fetch_session_bars(fake, ["AAA"], DAY, False, tmp_path, CLOCK.close_ms + 29 * 60_000)
    p = oc.fetch_session_bars(fake, ["AAA"], DAY, False, tmp_path, CLOCK.close_ms + 30 * 60_000)
    assert fake.calls[0]["feed"] == "sip" and fake.calls[0]["timeframe"] == "1Min" and fake.calls[0]["adjustment"] == "raw"
    assert hashlib.sha256(p.read_bytes()).hexdigest() == p.with_suffix(".json.sha256").read_text().strip()
    loaded = oc.load_session_bars(tmp_path, DAY)
    assert loaded is not None and loaded["AAA"] == flat_bars()[:3]
    with pytest.raises(FileExistsError):
        oc.fetch_session_bars(fake, ["AAA"], DAY, False, tmp_path, CLOCK.close_ms + 31 * 60_000)
    p.write_bytes(p.read_bytes().replace(b'"AAA"', b'"AAB"'))
    assert oc.load_session_bars(tmp_path, DAY) is None             # the SHA-256 no longer matches


def test_fetch_through_the_real_client_names_the_feed(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    from wt.data import alpaca as alpaca_data
    sent: list[dict[str, Any]] = []

    class Resp:
        status_code = 200

        def json(self) -> dict[str, Any]:
            return {"bars": {}, "next_page_token": None}

        def raise_for_status(self) -> None:
            return None

    monkeypatch.setenv("APCA_API_KEY_ID", "test")
    monkeypatch.setenv("APCA_API_SECRET_KEY", "test")
    c = alpaca_data.AlpacaREST()
    monkeypatch.setattr(c.s, "get", lambda url, params=None, timeout=0, **k: sent.append(dict(params or {})) or Resp())
    oc.fetch_session_bars(c, ["AAA"], DAY, False, tmp_path, CLOCK.close_ms + 31 * 60_000)
    assert sent and all(p["feed"] == "sip" for p in sent)


# ---- synthetic records ----------------------------------------------------------------------------------------------
def gate(p: bool | None, value: Any, not_yet: bool = False) -> dict[str, Any]:
    return {"pass": p, "not_yet": not_yet, "why": "x", "value": value}


def side_entry(side: str, word: str, broke_at: str | None, *, gates: dict[str, bool | None] | None = None,
               contract: bool = True, card: dict[str, float] | None = None) -> dict[str, Any]:
    g = {"market_direction": True, "volume": True, "stock_bid_ask": True, "shock": True, **(gates or {})}
    occ = "AAA270305C00100000" if contract else None
    cand = {"occ": "AAA270305C00100000", "expiry": "2027-03-05", "strike": 100, "kind": side, "bid": 1.0, "ask": 1.1,
            "at": None, "volume": 500, "delta": 0.5, "failed": None if contract else "premium",
            "checks": [{"id": "premium", "pass": contract, "value": 1.1, "why": "x"}]}
    return {
        "side": side,
        "gates": {
            "market_direction": gate(g["market_direction"], {"SPY": "up", "QQQ": None}),
            "volume": gate(g["volume"], 2.0),
            "stock_bid_ask": gate(g["stock_bid_ask"], {"bps": 2, "age_ms": 100}),
            "shock": gate(g["shock"], {"ranges": [1, None, 1.5], "release": None}),
            "contract": gate(contract, {"expiry": "2027-03-05", "why": None if contract else "none-passed",
                                        "picked": occ, "candidates": [cand]}),
        },
        "state": "enter_zone", "broke_at": broke_at, "broke_earlier": False, "gap": False,
        "card": card if card is not None else ({"level": 100, "entry": 100.0, "stop": 99.0, "t1": 102.0}
                                               if side == "call" else
                                               {"level": 100, "entry": 100.0, "stop": 101.0, "t1": 98.0}),
        "word": word, "lifecycle": None, "scoring": None, "missing": None, "for": [], "against": [], "unusable": [],
    }


def signal_record(day: str, end: int, sides: dict[str, list[dict[str, Any]]], dec_sha: str, evaluated: int,
                  follow: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    return {
        "v": 1, "mode": "log", "switch": "log", "session": day, "slot_end": iso(end), "evaluated_at": iso(evaluated),
        "engine": ENGINE, "params_hash": PH, "params_status": "frozen", "code_hash": CH,
        "frozen_params_hash": PH, "frozen_code_hash": CH,
        "dec0044": {"key": f"desk/log/{day}/{er.hhmm(end)}.json", "sha256": dec_sha, "status": "ok", "reason": None,
                    "evaluated_at": iso(end + 60_000)},
        "stamp": None, "stamp_usable": True, "feed_stock": "sip",
        "flow": {"as_of": iso(end), "age_ms": 10, "missing": []}, "flow_why": None,
        "baseline": {"v": 1, "for_session": day, "built_at": "x", "sessions": 20},
        "context": {"SPY": None, "QQQ": None}, "edition": {"session": day, "as_of": None},
        "focus": sorted(sides), "unusable": [],
        "names": [{"symbol": s, "stock": None, "volume_slot": {"value": 1.0, "why": None},
                   "chain": {"as_of": iso(end), "served_at": None, "feed": "opra", "fallback": None,
                             "checked_age_ms": 5}, "sides": v} for s, v in sorted(sides.items())],
        "breaks": [], "breaks_from": None, "history_usable": True, "follow": follow or [],
    }


def test_parser_accepts_the_shape_and_rejects_others() -> None:
    end = ms(DAY, 10, 0)
    rec = signal_record(DAY, end, {"AAA": [side_entry("call", "CALL", iso(end - 120_000))]}, "0" * 64, end + 61_000)
    assert parse_signal_record(json.dumps(rec)) == rec
    for mutate in (lambda r: r.pop("follow"), lambda r: r.update(extra=1), lambda r: r.update(v=2),
                   lambda r: r.update(slot_end="2027-03-01T15:00:00Z"), lambda r: r.update(switch="dry"),
                   lambda r: r["names"][0]["sides"][0].update(word="BUY"),
                   lambda r: r["names"][0]["sides"][0]["gates"]["volume"].update(value=True),
                   lambda r: r.update(params_hash="A" * 64)):
        bad = copy.deepcopy(rec)
        mutate(bad)
        assert parse_signal_record(json.dumps(bad)) is None
    assert parse_signal_record(json.dumps(rec).replace("2.0", "NaN", 1)) is None
    assert parse_signal_record("[]") is None and parse_signal_record("{") is None


# ---- a synthetic store ----------------------------------------------------------------------------------------------
class Store:
    def __init__(self, root: Path) -> None:
        self.root = root / "store"
        self.bars = root / "bars"
        self.root.mkdir(parents=True)
        (self.root / "SYNTHETIC").write_text("synthetic\n")
        self.days: list[str] = []

    def write(self, rel: str, body: bytes) -> None:
        p = self.root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(body)

    def session(self, day: str, breaks: list[dict[str, Any]], *, logged_share: float = 1.0,
                bars: list[oc.Bar] | None = None, stamp_feed: str = "sip", skip_signal: tuple[int, ...] = ()) -> None:
        """Every expected slot gets a DEC-0044 record and (for the first logged_share of slots) a signal record and a
        stamp. Each break: {symbol, side, at (slot index), word, gates, contract, card}."""
        self.days.append(day)
        clock = oc.session_clock(day, False)
        slots = er.expected_slots(clock)
        n_logged = int(round(len(slots) * logged_share))
        for j, end in enumerate(slots):
            rows = [{"symbol": b["symbol"], "side": b["side"], "state": "enter_zone" if b["at"] <= j <= b["at"] + 1
                     else "watch", "bar_end": iso(end)} for b in breaks]
            dec = json.dumps({"v": 1, "engine": ENGINE, "source": "server", "status": "ok", "reason": None,
                              "slot_end": iso(end), "evaluated_at": iso(end + 60_000), "session": day,
                              "edition_session": day, "edition_as_of": None, "board": "live", "rows": rows,
                              "degraded_names": [], "snapshot_ok": True, "day": {}}).encode()
            self.write(f"desk/log/{day}/{er.hhmm(end)}.json", dec)
            if j >= n_logged:
                continue
            self.write(f"desk/feeds/board/{day}/{er.hhmm(end + 60_000)}.json", json.dumps(
                {"v": 1, "feed": stamp_feed, "answered": "ok", "at": iso(end + 30_000), "deployment": "d1",
                 "commit": None, "prev": None}).encode())
            if j in skip_signal:
                continue
            sides: dict[str, list[dict[str, Any]]] = {}
            for b in breaks:
                ba = iso(slots[b["at"]] - 120_000)
                word = b["word"] if b["at"] <= j <= b["at"] + 1 else "WAIT"
                sides.setdefault(b["symbol"], []).append(side_entry(
                    b["side"], word, ba if b["at"] <= j else None, gates=b.get("gates"),
                    contract=b.get("contract", True), card=b.get("card")))
            rec = signal_record(day, end, sides, hashlib.sha256(dec).hexdigest(), end + 61_000)
            self.write(f"desk/signal/{day}/{er.hhmm(end)}.json", json.dumps(rec).encode())
        rows: dict[str, list[dict[str, Any]]] = {}
        for b in breaks:
            src = bars if bars is not None else flat_bars(day)
            rows[b["symbol"]] = [{"t": x.t, "o": x.o, "h": x.h, "l": x.low, "c": x.c, "v": x.v} for x in src]
        body = json.dumps({"v": 1, "day": day, "half_day": False, "feed": "sip", "timeframe": "1Min",
                           "adjustment": "raw", "bars": rows}, sort_keys=True).encode()
        self.bars.mkdir(exist_ok=True)
        (self.bars / f"{day}.json").write_bytes(body)
        (self.bars / f"{day}.json.sha256").write_text(hashlib.sha256(body).hexdigest())

    def calendar(self) -> er.Calendar:
        return er.Calendar(tuple(sorted(self.days)), frozenset())


def sessions_from(start: str, n: int) -> list[str]:
    out, d = [], date.fromisoformat(start)
    while len(out) < n:
        if d.weekday() < 5:
            out.append(d.isoformat())
        d += timedelta(days=1)
    return out


def closed(days: list[str]) -> er.Window:
    """A window whose close date has come: the day after the last session."""
    end = (date.fromisoformat(days[-1]) + timedelta(days=1)).isoformat()
    return er.Window(days[0], end, end, None, days[0])


def window(start: str, today: str) -> er.Window:
    return er.Window(start, er.close_date_of(start), today, None, start)


def one(store: Store, day: str, b: dict[str, Any], **kw: Any) -> er.Break:
    store.session(day, [b], **kw)
    p = er.prepare(store.root, store.bars, store.calendar(), window(day, day), FROZEN)
    assert len(p.breaks) == 1, p.breaks
    return p.breaks[0]


@pytest.mark.parametrize("b,group", [
    ({"word": "CALL"}, "a"),
    ({"word": "WAIT", "gates": {"market_direction": False}}, "b"),
    ({"word": "NO TRADE", "gates": {"market_direction": False, "shock": False}}, "b"),
    ({"word": "NO TRADE", "gates": {"stock_bid_ask": False}, "contract": False}, "contract_failed"),
    ({"word": "WAIT", "gates": {"volume": None}}, "gate_unavailable"),
    ({"word": "NO TRADE"}, "other"),                      # a clean slot read NO TRADE (brokeEarlier or gap)
    ({"word": "PUT"}, "other"),                           # a put word on the call side
    ({"word": "CALL", "card": {"level": 1, "entry": None, "stop": 99.0, "t1": 102.0}}, "card_missing"),
])
def test_group_order(tmp_path: Path, b: dict[str, Any], group: str) -> None:
    got = one(Store(tmp_path), DAY, {"symbol": "AAA", "side": "call", "at": 40, **b})
    assert got.group == group
    assert got.scored == (group in ("a", "b"))


def test_group_not_logged_and_not_usable(tmp_path: Path) -> None:
    s = Store(tmp_path)
    assert one(s, DAY, {"symbol": "AAA", "side": "call", "at": 40, "word": "CALL"}, skip_signal=(40,)).group == \
        "not_logged"
    s2 = Store(tmp_path / "2")
    s2.session(DAY, [{"symbol": "AAA", "side": "call", "at": 40, "word": "CALL"}])
    p = s2.root / "desk" / "signal" / DAY / f"{er.hhmm(er.expected_slots(CLOCK)[40])}.json"
    rec = json.loads(p.read_text())
    rec["code_hash"] = "other"
    p.write_text(json.dumps(rec))
    pr = er.prepare(s2.root, s2.bars, s2.calendar(), window(DAY, DAY), FROZEN)
    assert pr.breaks[0].group == "not_usable"
    assert {"day": DAY, "cause": "signal-code hash changed"} in pr.early


def test_put_is_scored_with_its_sign(tmp_path: Path) -> None:
    clock = oc.session_clock(DAY, False)
    bars = [oc.Bar(b.t, b.o, b.h, 97.0 if b.t >= ms(DAY, 11, 0) else b.low, b.c, b.v) for b in flat_bars()]
    b = one(Store(tmp_path), DAY, {"symbol": "AAA", "side": "put", "at": 40, "word": "PUT"}, bars=bars)
    assert b.group == "a" and b.outcome is not None and b.outcome.exit is not None
    assert b.outcome.exit.why == "target1" and b.r == 2.0
    assert b.outcome.entry_bar_start == er.expected_slots(clock)[40] + 2 * 60_000   # evaluated 61 s after the end


def test_counted_session_boundary(tmp_path: Path) -> None:
    n = len(er.expected_slots(CLOCK))
    assert n == 194
    need = math.ceil(0.9 * n)                              # 175 of 194: 90.2%; 174 is 89.69%
    for k, counted in ((need, True), (need - 1, False)):
        s = Store(tmp_path / str(k))
        s.session(DAY, [{"symbol": "AAA", "side": "call", "at": 10, "word": "CALL"}], logged_share=k / n)
        sess = er.load_session(s.root, DAY, s.calendar())
        assert sess.counted is counted
    assert er._counted.__doc__ and (need * 10 >= 9 * n) and ((need - 1) * 10 < 9 * n)


def test_counted_exactly_ninety_percent() -> None:
    """With 10 expected slots, 9 is exactly 90% and counts; the integer rule has no float edge."""
    c = oc.session_clock(DAY, False)
    slots = [er.Slot(i, None, None, None, False) for i in range(10)]
    sess = er.Session(DAY, c, slots, [])
    rec = {"mode": "log", "dec0044": {"evaluated_at": iso(1_000_000)}}
    sess.stamps = [er.Stamp("k", "sip", "ok", 1_000_000 - 60_000, "d")]
    for i in range(9):
        slots[i].signal = rec
    assert er._counted(sess)
    slots[8].signal = None
    assert not er._counted(sess)


def test_stamp_window_rule() -> None:
    st = [er.Stamp("k", "sip", "ok", 1_000_000, "d")]
    assert er.stamp_usable(st, 1_000_000) and er.stamp_usable(st, 1_120_000)
    assert not er.stamp_usable(st, 999_999) and not er.stamp_usable(st, 1_120_001)
    assert not er.stamp_usable([er.Stamp("k", "iex", "ok", 1_000_000, "d")], 1_000_000)
    assert not er.stamp_usable([er.Stamp("k", "sip", "stale", 1_000_000, "d")], 1_000_000)


def test_stamp_feed_other_than_sip_is_an_early_end(tmp_path: Path) -> None:
    s = Store(tmp_path)
    s.session(DAY, [{"symbol": "AAA", "side": "call", "at": 10, "word": "CALL"}], stamp_feed="iex")
    p = er.prepare(s.root, s.bars, s.calendar(), window(DAY, DAY), FROZEN)
    assert any(e["cause"] == "board-feed stamp reading other than sip" for e in p.early)
    assert p.breaks[0].group == "log_incomplete"


def test_outcome_hash_change_is_an_early_end(tmp_path: Path) -> None:
    s = Store(tmp_path)
    s.session(DAY, [])
    f = er.Frozen(PH, frozenset({CH}), frozenset({ENGINE}), "0" * 64)
    assert er.prepare(s.root, s.bars, s.calendar(), window(DAY, DAY), f).early[0]["cause"] == "outcome code changed"


# ---- the read: trigger, too few, halves -----------------------------------------------------------------------------
def build(tmp_path: Path, n_sessions: int, a_per: int, b_per: int, *, b_from: int = 0) -> tuple[Store, list[str]]:
    s = Store(tmp_path)
    days = sessions_from("2027-03-01", n_sessions)
    syms = [f"S{i}" for i in range(max(a_per + b_per, 1))]
    for k, d in enumerate(days):
        brs = [{"symbol": syms[i], "side": "call", "at": 20 + i, "word": "CALL"} for i in range(a_per)]
        if k >= b_from:
            brs += [{"symbol": syms[a_per + i], "side": "call", "at": 20 + a_per + i, "word": "WAIT",
                     "gates": {"market_direction": False}} for i in range(b_per)]
        s.session(d, brs)
    return s, days


def test_too_few_at_29_and_30_breaks(tmp_path: Path) -> None:
    for n_b, too_few in ((29, True), (30, False)):
        root = tmp_path / str(n_b)
        s, days = build(root, 30, 1, 1, b_from=30 - n_b)
        p, rep = er.run_read(s.root, s.bars, s.calendar(), closed(days), FROZEN)
        assert rep is not None and rep["group_sizes"] == {"a": 30, "b": n_b}
        assert rep["sessions"]["counted"] == 30
        assert (rep["verdict"] == "too_few") is too_few


def test_too_few_at_19_and_20_sessions(tmp_path: Path) -> None:
    for n, too_few in ((19, True), (20, False)):
        root = tmp_path / str(n)
        s, days = build(root, n, 2, 2)
        p, rep = er.run_read(s.root, s.bars, s.calendar(), closed(days), FROZEN)
        assert rep is not None and rep["sessions"]["counted"] == n and rep["group_sizes"]["a"] >= 30
        assert (rep["verdict"] == "too_few") is too_few
        assert rep["point_estimate"] == pytest.approx(0.0)     # flat bars: every R is the same
        assert rep["verdict"] in ("too_few", "falsified")


def test_halves_with_an_empty_group_fail(tmp_path: Path) -> None:
    s, days = build(tmp_path, 4, 1, 1, b_from=2)               # b only in the second half
    p, rep = er.run_read(s.root, s.bars, s.calendar(), closed(days), FROZEN)
    assert rep is not None
    assert rep["halves"]["first"]["estimate"] is None and rep["halves"]["first"]["n_b"] == 0
    assert rep["verdict"] == "too_few"


def test_read_trigger_at_100_group_a_breaks(tmp_path: Path) -> None:
    s, days = build(tmp_path, 26, 4, 1)                         # 4 a breaks a session: the 100th on session 25
    p = er.prepare(s.root, s.bars, s.calendar(), er.Window(days[0], er.close_date_of(days[0]), days[-1], None, days[0]), FROZEN)
    assert p.trigger == "group_a_100" and p.read_day == days[24]
    assert sum(1 for b in p.breaks if b.group == "a" and b.scored) == 100
    assert all(b.day <= days[24] for b in p.breaks)
    # session 25's b break comes after its 100th a break (later slot): not taken
    assert sum(1 for b in p.breaks if b.group == "b") == 24
    p2 = er.prepare(s.root, s.bars, s.calendar(), er.Window(days[0], er.close_date_of(days[0]), days[10], None, days[0]), FROZEN)
    assert p2.trigger is None


def _run(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run([sys.executable, str(SCRIPT), *args], capture_output=True, text=True, cwd=ROOT)


def test_script_refuses(tmp_path: Path) -> None:
    s, days = build(tmp_path, 3, 1, 1)
    out = tmp_path / "results.json"
    base = ["--store", str(s.root), "--bars", str(s.bars), "--start", days[0], "--params-hash", PH,
            "--code-hash", CH, "--engine", ENGINE, "--outcome-sha256", OUTCOME_SHA256, "--today", days[-1],
            "--calendar", str(_cal(tmp_path, s)), "--readme", str(_readme(tmp_path, days[0]))]
    r = _run("--dry-run-synthetic", "--out", str(out), *base)
    assert r.returncode == 2 and not out.exists()               # no --read
    r = _run("--read", "--dry-run-synthetic", "--out", str(out), *base)
    assert r.returncode == 4 and not out.exists() and "not due" in r.stdout   # before the trigger
    late = [*base[:-6], "--today", er.close_date_of(days[0]), *base[-4:]]
    r = _run("--read", "--dry-run-synthetic", "--out", str(out), *late)
    assert r.returncode == 0, r.stdout + r.stderr
    rep = json.loads(out.read_text())
    assert rep["window"]["trigger"] == "close_date" and rep["verdict"] == "too_few"
    body = out.read_bytes()
    r = _run("--read", "--dry-run-synthetic", "--out", str(out), *late)
    assert r.returncode == 2 and "exists" in r.stdout and out.read_bytes() == body   # read once
    (s.root / "SYNTHETIC").unlink()
    r = _run("--read", "--dry-run-synthetic", "--out", str(tmp_path / "other.json"), *late)
    assert r.returncode == 2
    r = _run("--read", "--out", str(tmp_path / "x.json"), *late)
    assert r.returncode == 2                                     # --out without the synthetic mode


def _readme(tmp_path: Path, start: str) -> Path:
    p = tmp_path / "README.md"
    p.write_text(f"# synthetic\n\n- Window start date (the first counted session after that): {start}\n")
    return p


def _cal(tmp_path: Path, s: Store) -> Path:
    p = tmp_path / "calendar.json"
    p.write_text(json.dumps({"sessions": sorted(s.days), "half_days": []}))
    return p


def test_report_holds_only_safe_figures(tmp_path: Path) -> None:
    s, days = build(tmp_path, 3, 1, 1)
    _, rep = er.run_read(s.root, s.bars, s.calendar(), closed(days), FROZEN)
    text = json.dumps(rep)
    assert rep is not None and "S0" not in text and "S1" not in text and "AAA27" not in text
    assert set(rep["counted_not_scored"]) == set(er.NOT_SCORED)

# ---- the fix round --------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("side,o,t1,stop,why", [
    ("call", 102.0, 102.0, 99.0, "entry_beyond_t1"), ("call", 103.0, 102.0, 99.0, "entry_beyond_t1"),
    ("call", 99.0, 102.0, 99.0, "entry_beyond_stop"), ("call", 98.0, 102.0, 99.0, "entry_beyond_stop"),
    ("put", 98.0, 98.0, 101.0, "entry_beyond_t1"), ("put", 97.0, 98.0, 101.0, "entry_beyond_t1"),
    ("put", 101.0, 98.0, 101.0, "entry_beyond_stop"), ("put", 102.0, 98.0, 101.0, "entry_beyond_stop"),
])
def test_entry_beyond_t1_or_stop_exits_at_entry_open(side: str, o: float, t1: float, stop: float, why: str) -> None:
    e = oc.after_fill(_bars2([(o, o + 5, o - 5, o), (o, o, o, o)]), 0, side, t1, stop)  # type: ignore[arg-type]
    assert (e.price, e.why, e.bar) == (o, why, 0)
    assert oc.r_multiple(side, e.price, o, 100.0, stop) == 0.0  # type: ignore[arg-type]


def test_entry_beyond_t1_through_break_outcome() -> None:
    bars = [oc.Bar(b.t, 103.0, 103.5, 102.5, 103.0, b.v) for b in flat_bars()]
    o = oc.break_outcome(bars, CLOCK, ms(DAY, 11, 0), "call", 100.0, 99.0, 102.0)
    assert o.exit is not None and o.exit.why == "entry_beyond_t1" and o.r == 0.0
    bars = [oc.Bar(b.t, 97.0, 97.5, 96.5, 97.0, b.v) for b in flat_bars()]
    o = oc.break_outcome(bars, CLOCK, ms(DAY, 11, 0), "put", 100.0, 101.0, 98.0)
    assert o.exit is not None and o.exit.why == "entry_beyond_t1"


def test_today_is_refused_on_the_real_path() -> None:
    r = _run("--read", "--today", "2027-01-01")
    assert r.returncode == 2 and "--today" in r.stdout


def _change_code_hash(folder: Path) -> None:
    for f in folder.glob("*.json"):
        rec = json.loads(f.read_text())
        rec["code_hash"] = "changed"
        f.write_text(json.dumps(rec))


def test_early_end_after_the_read_day_does_not_block(tmp_path: Path) -> None:
    s, days = build(tmp_path, 27, 4, 1)                         # the read day is session 25
    _change_code_hash(s.root / "desk" / "signal" / days[26])
    w = er.Window(days[0], er.close_date_of(days[0]), days[-1], None, days[0])
    pr = er.prepare(s.root, s.bars, s.calendar(), w, FROZEN)
    assert pr.read_day == days[24] and pr.early == []
    _change_code_hash(s.root / "desk" / "signal" / days[3])
    assert er.prepare(s.root, s.bars, s.calendar(), w, FROZEN).early


def _args(tmp_path: Path, s: Store, days: list[str], out: Path, start_line: str | None = None) -> list[str]:
    return ["--read", "--dry-run-synthetic", "--out", str(out), "--store", str(s.root), "--bars", str(s.bars),
            "--start", days[0], "--params-hash", PH, "--code-hash", CH, "--engine", ENGINE, "--outcome-sha256",
            OUTCOME_SHA256, "--today", er.close_date_of(days[0]), "--calendar", str(_cal(tmp_path, s)),
            "--readme", str(_readme(tmp_path, start_line or days[0]))]


@pytest.mark.parametrize("damage", ["missing", "hash", "feed"])
def test_bad_bars_file_is_a_refusal(tmp_path: Path, damage: str) -> None:
    s, days = build(tmp_path, 3, 1, 1)
    f = s.bars / f"{days[1]}.json"
    if damage == "missing":
        f.unlink()
    elif damage == "hash":
        f.write_bytes(f.read_bytes() + b" ")
    else:
        body = f.read_bytes().replace(b'"feed": "sip"', b'"feed": "iex"')
        assert body != f.read_bytes()
        f.write_bytes(body)
        (s.bars / f"{days[1]}.json.sha256").write_text(hashlib.sha256(body).hexdigest())
    with pytest.raises(er.BarsRefused) as e:
        er.prepare(s.root, s.bars, s.calendar(), closed(days), FROZEN)
    assert e.value.day == days[1]
    out = tmp_path / "results.json"
    r = _run(*_args(tmp_path, s, days, out))
    assert r.returncode == 2 and days[1] in r.stdout and not out.exists()


def test_verified_file_with_incomplete_bars_is_bars_incomplete(tmp_path: Path) -> None:
    b = one(Store(tmp_path), DAY, {"symbol": "AAA", "side": "call", "at": 40, "word": "CALL"},
            bars=flat_bars(skip=tuple(range(0, 20))))
    assert b.group == "bars_incomplete" and not b.scored


def _r25_case(follow_at: dict[int, float | None], why: oc.ExitWhy, exit_end: int, n: int = 6) -> er.Break:
    slots = []
    for i in range(n):
        f = [] if i not in follow_at else [{"symbol": "AAA", "side": "call", "broke_at": iso(0), "occ": "X",
                                             "bid": follow_at[i], "ask": None, "at": None, "age_ms": None,
                                             "checked_age_ms": None, "why": None}]
        slots.append(er.Slot(i * 10, None, None, {"mode": "log", "follow": f}, True))
    sess = er.Session(DAY, CLOCK, slots, [])
    b = er.Break(DAY, "AAA", "call", iso(0), 0, group="a", occ="X", ask=1.0, scored=True)
    b.outcome = oc.Outcome("scored", 100.0, 0, oc.Exit(100.0, why, 0), exit_end, 0.0)
    er._r25(b, sess)
    return b


def test_r25_takes_only_the_first_record_at_or_after_the_exit() -> None:
    assert _r25_case({2: 1.5}, "target1", 20).r25 == pytest.approx(((1.5 - 1.0) * 100 - 1.11) / 25)
    b = _r25_case({2: None, 3: 1.5}, "target1", 20)            # the first has no bid: not valued, no later search
    assert b.r25 is None and b.r25_why == "no logged exit quote"
    assert _r25_case({3: 1.5}, "target1", 20).r25 is None       # the first at or after has no follow entry
    b = _r25_case({5: 0.5, 2: 1.5}, "session_close", 20)        # session_close: the session's last record
    assert b.r25 == pytest.approx(((0.5 - 1.0) * 100 - 1.11) / 25)


def test_lock_refuses_a_second_run(tmp_path: Path) -> None:
    s, days = build(tmp_path, 3, 1, 1)
    out = tmp_path / "results.json"
    (tmp_path / "results.json.lock").write_text("")
    r = _run(*_args(tmp_path, s, days, out))
    assert r.returncode == 2 and "lock" in r.stdout and not out.exists()
    (tmp_path / "results.json.lock").unlink()
    assert _run(*_args(tmp_path, s, days, out)).returncode == 0 and not (tmp_path / "results.json.lock").exists()


def test_start_date_checks(tmp_path: Path) -> None:
    s, days = build(tmp_path, 3, 1, 1)
    w = closed(days)
    w.recorded_start = days[1]
    assert any("README" in e["cause"] for e in er.prepare(s.root, s.bars, s.calendar(), w, FROZEN).early)
    w.recorded_start = None
    assert er.prepare(s.root, s.bars, s.calendar(), w, FROZEN).early
    s2 = Store(tmp_path / "2")
    d2 = sessions_from("2027-03-01", 2)
    s2.session(d2[0], [], logged_share=0.5)                     # the start session is not counted
    s2.session(d2[1], [])
    assert any("first counted" in e["cause"]
               for e in er.prepare(s2.root, s2.bars, s2.calendar(), closed(d2), FROZEN).early)
    out = tmp_path / "r.json"
    r = _run(*_args(tmp_path, s, days, out, days[1]))
    assert r.returncode == 3 and "README" in r.stdout and not out.exists()


def _sess(day: str, stamps: list[tuple[int, str | None]]) -> er.Session:
    return er.Session(day, oc.session_clock(day, False), [], [er.Stamp("k", "sip", "ok", t, d) for t, d in stamps])


def _hidden(ss: list[er.Session]) -> list[dict[str, str]]:
    return [e for e in er.early_ends(ss, FROZEN) if "deployment" in e["cause"]]


def test_hidden_change_within_a_session_only() -> None:
    d1, d2 = sessions_from("2027-03-01", 2)
    t1, t2 = ms(d1, 15, 59), ms(d2, 9, 30)
    assert _hidden([_sess(d1, [(t1, "d1")]), _sess(d2, [(t2, "d2")])]) == []      # an overnight deploy
    a = ms(d1, 10, 0)
    assert _hidden([_sess(d1, [(a, "d1"), (a + 10 * 60_000, "d2")])]) == []
    assert _hidden([_sess(d1, [(a, "d1"), (a + 10 * 60_000 + 1, "d2")])]) == [
        {"day": d1, "cause": "stamp gap over 10 minutes across a deployment change"}]
    assert _hidden([_sess(d1, [(a, "d1"), (a + 20 * 60_000, None)])]) == []
    assert _hidden([_sess(d1, [(a, None), (a + 20 * 60_000, "d2")])]) == []
