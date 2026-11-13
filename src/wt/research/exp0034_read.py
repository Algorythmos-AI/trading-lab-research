"""EXP-0034's read (DEC-0051 section 8, precondition 2): the groups, the counted sessions, the read trigger, the
measure, the session bootstrap, the halves, too-few, the secondary option R25 and the sensitivity table.

The read is run once, by the owner, by scripts/exp0034_read.py (docs/runbooks/exp0034-read.md). This module holds the
logic only; it never fetches anything and never reads a clock. Its inputs are a local copy of the PRIVATE store
(`desk/log/`, `desk/signal/`, `desk/feeds/board/`), the saved SIP bars (wt.research.exp0034_outcome) and
dashboard/src/lib/market-calendar.json. Every frozen definition is in
research/experiments/EXP-0034-desk-signal-gates/config.yaml; where this code and that file differ, the file wins.
"""
from __future__ import annotations

import hashlib
import json
import math
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path
from typing import Any

from wt.research import exp0034_outcome as oc
from wt.research.signal_record import iso, iso_ms, parse_signal_record

SEED = 20261159
RESAMPLES = 5000
INTERVAL = (2.5, 97.5)
READ_AT_A = 100
TOO_FEW_GROUP = 30
TOO_FEW_SESSIONS = 20
COUNTED_SHARE = (9, 10)                # at least 90% of expectedSlots, compared in integers
SERVER_SETTLE_MS = 60_000              # trade-state.ts SERVER_SETTLE_MS
STAMP_WINDOW_MS = 2 * 60_000           # a usable stamp's at lies in [t0 - 2 min, t0]
HIDDEN_GAP_MS = 10 * 60_000            # a stamp gap over 10 minutes across a deployment change
FEES = (0.55, 0.56)                    # OWNER_FEES, open and close, a contract
MARKET_GATES = ("market_direction", "volume", "stock_bid_ask", "shock")
INDEXES = ("SPY", "QQQ")
NOT_SCORED = ("not_logged", "not_usable", "gate_unavailable", "contract_failed", "other", "card_missing",
              "bars_incomplete", "no_entry_bar", "log_incomplete")


# ---- the generator and the percentile -------------------------------------------------------------------------------
M32 = 0xFFFFFFFF


def _imul(x: int, y: int) -> int:
    return (x * y) & M32


def mulberry32(seed: int) -> Callable[[], int]:
    """config.yaml statistics.prng_step, in unsigned 32-bit arithmetic (the same bits as the JavaScript)."""
    a = seed & M32

    def nxt() -> int:
        nonlocal a
        a = (a + 0x6D2B79F5) & M32
        t = _imul(a ^ (a >> 15), a | 1)
        t = (t ^ ((t + _imul(t ^ (t >> 7), t | 61)) & M32)) & M32
        return (t ^ (t >> 14)) & M32

    return nxt


def percentile(sorted_d: list[float], p: float) -> float:
    """numpy's linear percentile as config.yaml writes it: h = (N - 1) p / 100, q = d[fl] + (h - fl)(d[fl+1] - d[fl])."""
    n = len(sorted_d)
    if n == 0:
        raise ValueError("no values")
    h = (n - 1) * p / 100
    fl = math.floor(h)
    if fl + 1 >= n:
        return sorted_d[n - 1]
    return sorted_d[fl] + (h - fl) * (sorted_d[fl + 1] - sorted_d[fl])


# ---- the calendar and the slots -------------------------------------------------------------------------------------
@dataclass(frozen=True)
class Calendar:
    sessions: tuple[str, ...]
    half_days: frozenset[str]

    @staticmethod
    def load(path: Path) -> Calendar:
        doc = json.loads(path.read_text())
        return Calendar(tuple(doc["sessions"]), frozenset(h["date"] for h in doc["half_days"]))


def expected_slots(clock: oc.SessionClock) -> list[int]:
    """desk-eval.ts expectedSlots: each bar end from 09:32 whose settle instant falls before the close."""
    out, end = [], clock.open_ms + oc.BAR_MS
    while end + SERVER_SETTLE_MS < clock.close_ms:
        out.append(end)
        end += oc.BAR_MS
    return out


def hhmm(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, oc.NY).strftime("%H%M")


def ny_minutes(ms: int) -> int:
    d = datetime.fromtimestamp(ms / 1000, oc.NY)
    return d.hour * 60 + d.minute


def close_date_of(start: str) -> str:
    """One year after the start date, the same month and day."""
    d = date.fromisoformat(start)
    return d.replace(year=d.year + 1).isoformat()


# ---- the store ------------------------------------------------------------------------------------------------------
def _read(path: Path) -> bytes | None:
    return path.read_bytes() if path.is_file() else None


def parse_dec0044(body: bytes) -> dict[str, Any] | None:
    """A DEC-0044 server record (desk-eval.ts ServerRecord), read for its rows, status and time; None when it is not one."""
    try:
        v = json.loads(body)
    except ValueError:
        return None
    if type(v) is not dict or v.get("v") != 1 or v.get("source") != "server" or not iso(v.get("evaluated_at")):
        return None
    rows = v.get("rows")
    if type(rows) is not list or type(v.get("degraded_names")) is not list or type(v.get("engine")) is not str:
        return None
    for r in rows:
        if type(r) is not dict or type(r.get("symbol")) is not str or r.get("side") not in ("call", "put") \
                or type(r.get("state")) is not str:
            return None
    return v


@dataclass(frozen=True)
class Stamp:
    key: str
    feed: str
    answered: str
    at: int
    deployment: str | None


def _stamps(store: Path, day: str) -> list[Stamp]:
    out = []
    folder = store / "desk" / "feeds" / "board" / day
    for p in sorted(folder.glob("[0-9][0-9][0-9][0-9].json")) if folder.is_dir() else []:
        try:
            v = json.loads(p.read_bytes())
        except ValueError:
            continue
        if type(v) is dict and iso(v.get("at")) and type(v.get("feed")) is str and type(v.get("answered")) is str:
            dep = v.get("deployment")
            out.append(Stamp(f"desk/feeds/board/{day}/{p.name}", v["feed"], v["answered"], iso_ms(v["at"]),
                             dep if type(dep) is str else None))
    return sorted(out, key=lambda s: s.at)


def stamp_usable(stamps: Iterable[Stamp], t0: int) -> bool:
    """DEC-0051 section 1: a stamp reading sip, answered ok, whose at lies in [t0 - 2 min, t0]; no bracketing."""
    return any(s.feed == "sip" and s.answered == "ok" and t0 - STAMP_WINDOW_MS <= s.at <= t0 for s in stamps)


@dataclass
class Slot:
    end: int
    dec: dict[str, Any] | None
    dec_sha: str | None
    signal: dict[str, Any] | None
    signal_present: bool               # a file is there, whether or not it reads


@dataclass
class Session:
    day: str
    clock: oc.SessionClock
    slots: list[Slot]
    stamps: list[Stamp]
    counted: bool = False


def load_session(store: Path, day: str, cal: Calendar) -> Session:
    clock = oc.session_clock(day, day in cal.half_days)
    slots = []
    for end in expected_slots(clock):
        dec_b = _read(store / "desk" / "log" / day / f"{hhmm(end)}.json")
        sig_b = _read(store / "desk" / "signal" / day / f"{hhmm(end)}.json")
        sig = parse_signal_record(sig_b.decode("utf-8", "replace")) if sig_b is not None else None
        slots.append(Slot(end, parse_dec0044(dec_b) if dec_b is not None else None,
                          hashlib.sha256(dec_b).hexdigest() if dec_b is not None else None, sig, sig_b is not None))
    s = Session(day, clock, slots, _stamps(store, day))
    s.counted = _counted(s)
    return s


def _slot_stamp_ok(sess: Session, slot: Slot) -> bool:
    if slot.signal is None:
        return False
    return stamp_usable(sess.stamps, iso_ms(slot.signal["dec0044"]["evaluated_at"]))


def _counted(sess: Session) -> bool:
    """At least 90% of expectedSlots hold a signal record (log mode) and have a usable board-feed stamp."""
    good = sum(1 for sl in sess.slots if sl.signal is not None and sl.signal["mode"] == "log"
               and _slot_stamp_ok(sess, sl))
    return good * COUNTED_SHARE[1] >= COUNTED_SHARE[0] * len(sess.slots)


# ---- the frozen identity the read checks against ---------------------------------------------------------------------
@dataclass(frozen=True)
class Frozen:
    params_hash: str                   # Amendment 1's parameter hash
    code_hashes: frozenset[str]        # Amendment 1's signal-code hash, plus any recorded defect fix
    engines: frozenset[str]            # the engine labels in production through the window (identity check passed)
    outcome_sha256: str                # the outcome code's hash recorded for precondition 3


# ---- breaks and their groups ----------------------------------------------------------------------------------------
@dataclass
class Break:
    day: str
    symbol: str
    side: str
    broke_at: str | None
    slot: int                          # the scoring slot's end (ms)
    group: str = ""
    word: str | None = None
    evaluated_ms: int | None = None
    failed_gates: tuple[str, ...] = ()
    contract_pass: bool | None = None
    contract_failed_check: str | None = None
    card: dict[str, Any] | None = None
    occ: str | None = None
    ask: float | None = None
    outcome: oc.Outcome | None = None
    r: float | None = None
    scored: bool = False
    r25: float | None = None
    r25_why: str | None = None
    extras: dict[str, Any] = field(default_factory=dict)


def _side_of(rec: dict[str, Any], symbol: str, side: str) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    for n in rec["names"]:
        if n["symbol"] == symbol:
            for s in n["sides"]:
                if s["side"] == side:
                    return n, s
            return n, None
    return None, None


def find_breaks(sess: Session) -> list[Break]:
    """One break per (session, symbol, side, brokeAt) whose side reads enter_zone in the DEC-0044 log, at its first
    enter_zone slot. brokeAt is read from the slot's signal record; a run of consecutive enter_zone slots whose first
    slot has no record is one break (its brokeAt unknown), and takes the first brokeAt a later slot of the run logs."""
    known: dict[tuple[str, str, str], Break] = {}
    run: dict[tuple[str, str], tuple[int, Break]] = {}
    out: list[Break] = []
    for j, sl in enumerate(sess.slots):
        if sl.dec is None:
            continue
        for row in sl.dec["rows"]:
            if row["state"] != "enter_zone":
                continue
            sym, side = row["symbol"], row["side"]
            sd = _side_of(sl.signal, sym, side)[1] if sl.signal is not None and sl.signal["mode"] == "log" else None
            ba = sd["broke_at"] if sd is not None else None
            prev = run.get((sym, side))
            cont = prev is not None and prev[0] == j - 1
            if ba is not None and (sym, side, ba) in known:
                b = known[(sym, side, ba)]
            elif cont and prev is not None and (ba is None or prev[1].broke_at is None or prev[1].broke_at == ba):
                b = prev[1]
                if b.broke_at is None and ba is not None:
                    b.broke_at = ba
                    known[(sym, side, ba)] = b
            else:
                b = Break(sess.day, sym, side, ba, sl.end)
                out.append(b)
                if ba is not None:
                    known[(sym, side, ba)] = b
            run[(sym, side)] = (j, b)
    return out


def classify(b: Break, sess: Session, frozen: Frozen) -> None:
    """config.yaml unit.group_order at the scoring slot, the first that applies."""
    sl = next(x for x in sess.slots if x.end == b.slot)
    rec = sl.signal
    if not sl.signal_present:
        b.group = "not_logged"
        return
    if rec is None or rec["mode"] != "log":
        b.group = "not_usable"
        return
    name, sd = _side_of(rec, b.symbol, b.side)
    dec = sl.dec or {}
    bad = (rec["dec0044"]["status"] != "ok" or rec["dec0044"]["sha256"] != sl.dec_sha
           or any(d.get("symbol") == b.symbol for d in dec.get("degraded_names", []) if type(d) is dict)
           or bool(rec["unusable"]) or rec["params_hash"] != frozen.params_hash
           or rec["code_hash"] not in frozen.code_hashes or rec["feed_stock"] != "sip"
           or name is None or sd is None or bool(sd["unusable"])
           or (name["chain"] is not None and name["chain"]["feed"] != "opra")
           or not _slot_stamp_ok(sess, sl))
    if bad or sd is None:
        b.group = "not_usable"
        return
    g = sd["gates"]
    b.word, b.evaluated_ms, b.card = sd["word"], iso_ms(rec["evaluated_at"]), sd["card"]
    b.failed_gates = tuple(k for k in MARKET_GATES if g[k]["pass"] is False)
    c = g["contract"]
    b.contract_pass = c["pass"]
    cands = c["value"]["candidates"]
    b.contract_failed_check = (cands[0]["failed"] if cands else None) or c["value"]["why"]
    b.occ = c["value"]["picked"]
    if b.occ is not None:
        b.ask = next((x["ask"] for x in cands if x["occ"] == b.occ), None)
    if any(g[k]["pass"] is None or (k == "volume" and g[k]["not_yet"]) for k in MARKET_GATES):
        b.group = "gate_unavailable"
    elif b.word == ("CALL" if b.side == "call" else "PUT"):
        b.group = "a"
    elif c["pass"] is not True:
        b.group = "contract_failed"
    elif b.word in ("WAIT", "NO TRADE") and b.failed_gates:
        b.group = "b"
    else:
        b.group = "other"


def _card_ok(card: dict[str, Any] | None) -> bool:
    return (card is not None and all(type(card.get(k)) in (int, float) for k in ("entry", "stop", "t1"))
            and card["entry"] != card["stop"])


def score(b: Break, sess: Session, bars: dict[str, list[oc.Bar]] | None, *, also: bool = False) -> None:
    """The stock outcome of a group a or b break (or, with `also`, of any break with a word, for the sensitivity
    table's first-proposed b). Sets `scored` only for groups a and b."""
    if b.word is None or not (also or b.group in ("a", "b")):
        return
    if not _card_ok(b.card):
        if b.group in ("a", "b"):
            b.group = "card_missing"
        return
    assert b.card is not None and b.evaluated_ms is not None
    side: oc.Side = "call" if b.side == "call" else "put"
    o = oc.break_outcome(bars.get(b.symbol) if bars is not None else None, sess.clock, b.evaluated_ms, side,
                         float(b.card["entry"]), float(b.card["stop"]), float(b.card["t1"]))
    b.outcome = o
    if o.status == "scored":
        b.r = o.r
        b.scored = b.group in ("a", "b")
    elif b.group in ("a", "b"):
        b.group = o.status


# ---- early ends the code can see ------------------------------------------------------------------------------------
def early_ends(sessions: list[Session], frozen: Frozen) -> list[dict[str, str]]:
    """The early ends a read can detect from the inputs (config.yaml window.ends_early_on); date and cause only."""
    out: list[dict[str, str]] = []

    def add(day: str, cause: str) -> None:
        if not any(e["day"] == day and e["cause"] == cause for e in out):
            out.append({"day": day, "cause": cause})

    if oc.outcome_code_sha256() != frozen.outcome_sha256:
        add(sessions[0].day if sessions else "", "outcome code changed")
    for s in sessions:                        # within a session only: a deploy between sessions is not a change
        for a, b in zip(s.stamps, s.stamps[1:], strict=False):
            if (b.at - a.at > HIDDEN_GAP_MS and a.deployment is not None and b.deployment is not None
                    and a.deployment != b.deployment):
                add(s.day, "stamp gap over 10 minutes across a deployment change")
    for s in sessions:
        for st in s.stamps:
            if st.feed != "sip":
                add(s.day, "board-feed stamp reading other than sip")
        for sl in s.slots:
            if sl.dec is not None and sl.dec["engine"] not in frozen.engines:
                add(s.day, "engine label changed")
            r = sl.signal
            if r is None:
                continue
            if r["mode"] == "dry":
                add(s.day, "a dry record in the window")
                continue
            if r["engine"] not in frozen.engines:
                add(s.day, "engine label changed")
            if r["params_hash"] != frozen.params_hash:
                add(s.day, "parameter hash changed")
            if r["code_hash"] not in frozen.code_hashes:
                add(s.day, "signal-code hash changed")
            if r["feed_stock"] not in (None, "sip") or any(
                    n["chain"] is not None and n["chain"]["feed"] != "opra" for n in r["names"]):
                add(s.day, "a feed other than sip or opra")
    return out


# ---- the read -------------------------------------------------------------------------------------------------------
@dataclass
class Window:
    start: str
    close: str
    today: str
    selection_switch: str | None = None
    recorded_start: str | None = None   # the start date EXP-0034's README records; None or a mismatch is an early end


class BarsRefused(Exception):
    """A counted session's saved bars are missing, fail their SHA-256 or name another feed: the read refuses."""

    def __init__(self, day: str, why: str) -> None:
        super().__init__(f"{day}: {why}")
        self.day, self.why = day, why


@dataclass
class Prepared:
    sessions: list[Session]
    breaks: list[Break]
    early: list[dict[str, str]]
    trigger: str | None                # "group_a_100" or "close_date"; None when not met
    read_day: str | None
    bars_root: Path


def prepare(store: Path, bars_root: Path, cal: Calendar, window: Window, frozen: Frozen) -> Prepared:
    """Load the window, find and group every break, and decide whether the read is due. Computes no statistic."""
    days = [d for d in cal.sessions if window.start <= d < window.close and d <= window.today]
    sessions = [load_session(store, d, cal) for d in days]
    breaks: list[Break] = []
    trigger, read_day, a_count, cut_slot = None, None, 0, None
    for s in sessions:
        found = find_breaks(s)
        for b in found:
            classify(b, s, frozen)
            if not s.counted:
                b.extras["group_at_slot"] = b.group
                b.group = "log_incomplete"
        bars = None
        if s.counted and any(b.group in ("a", "b") for b in found):
            why = oc.verify_session_bars(bars_root, s.day)
            if why is not None:
                raise BarsRefused(s.day, why)
            bars = oc.load_session_bars(bars_root, s.day)
        for b in found:
            if s.counted:
                score(b, s, bars)
        for b in sorted(found, key=lambda x: (x.slot, x.symbol, x.side)):
            if cut_slot is not None and b.slot > cut_slot:
                break
            breaks.append(b)
            if b.scored and b.group == "a":
                a_count += 1
                if a_count == READ_AT_A:
                    cut_slot = b.slot
        if cut_slot is not None:
            trigger, read_day = "group_a_100", s.day
            break
    if trigger is None and window.today >= window.close:
        trigger, read_day = "close_date", sessions[-1].day if sessions else None
    if read_day is not None:
        sessions = [s for s in sessions if s.day <= read_day]
    early = early_ends(sessions, frozen)      # judged only on the sessions up to the read day
    first_counted = next((s.day for s in sessions if s.counted), None)
    if window.recorded_start != window.start:
        early.append({"day": window.start, "cause": "start date differs from the README's recorded start date"})
    if sessions and first_counted != window.start:
        early.append({"day": window.start, "cause": "start date is not the first counted session"})
    return Prepared(sessions, breaks, early, trigger, read_day, bars_root)


def _mean(xs: list[float]) -> float | None:
    return sum(xs) / len(xs) if xs else None


def _diff(bs: Iterable[Break], in_b: Callable[[Break], bool] | None = None) -> dict[str, Any]:
    a = [x.r for x in bs if x.scored and x.group == "a" and x.r is not None]
    bs = list(bs)
    b = [x.r for x in bs if x.r is not None and (in_b(x) if in_b else (x.scored and x.group == "b"))]
    ma, mb = _mean(a), _mean(b)
    return {"estimate": None if ma is None or mb is None else ma - mb, "n_a": len(a), "n_b": len(b)}


def bootstrap(per_session: list[tuple[float, int, float, int]], seed: int = SEED, keep: int = RESAMPLES
              ) -> tuple[list[float], int]:
    """Sessions drawn with replacement (index floor(u x n)), every scored break of a drawn session with it; a resample
    with an empty group is discarded and drawing continues until `keep` are kept. Returns the sorted differences and
    the number of resamples drawn."""
    n = len(per_session)
    if n == 0:
        raise ValueError("no sessions")
    if not any(x[1] for x in per_session) or not any(x[3] for x in per_session):
        raise ValueError("a group is empty in every resample")
    nxt = mulberry32(seed)
    out: list[float] = []
    drawn = 0
    while len(out) < keep:
        drawn += 1
        sa = na = sb = nb = 0.0
        for _ in range(n):
            s = per_session[math.floor(nxt() / 2 ** 32 * n)]
            sa, na, sb, nb = sa + s[0], na + s[1], sb + s[2], nb + s[3]
        if na and nb:
            out.append(sa / na - sb / nb)
    out.sort()
    return out, drawn


def _window_of(b: Break, sess_close: int) -> str:
    m = ny_minutes(b.slot)
    if 9 * 60 + 35 <= m < 10 * 60:
        return "09:35-10:00"
    if 10 * 60 <= m < 11 * 60 + 30:
        return "10:00-11:30"
    if 13 * 60 <= m and b.slot <= sess_close:
        return "13:00-close"
    return "outside"


def _r25(b: Break, sess: Session) -> None:
    """In at the named contract's logged ask at the scoring slot, out at its logged bid in the first record at or after
    the stock exit bar's end (follow), less OWNER_FEES; R25 = net / (0.25 x premium cost)."""
    o = b.outcome
    if b.occ is None or b.ask is None or b.ask <= 0 or o is None or o.exit_bar_end is None:
        b.r25_why = "no entry quote"
        return
    logged = [sl for sl in sess.slots if sl.signal is not None and sl.signal["mode"] == "log"]
    if o.exit is not None and o.exit.why == "session_close":
        rec = logged[-1] if logged else None              # a session_close exit: the session's last record
    else:
        rec = next((sl for sl in logged if sl.end >= o.exit_bar_end), None)   # the first at or after; never later
    f = None if rec is None or rec.signal is None else next(
        (x for x in rec.signal["follow"] if x["symbol"] == b.symbol and x["side"] == b.side and x["occ"] == b.occ
         and (b.broke_at is None or x["broke_at"] == b.broke_at)), None)
    if f is not None and f["bid"] is not None:
        cost = b.ask * 100
        net = (f["bid"] - b.ask) * 100 - FEES[0] - FEES[1]
        b.r25 = net / (0.25 * cost)
        return
    b.r25_why = "no logged exit quote"


def compute(p: Prepared, window: Window) -> dict[str, Any]:
    """The report the record allows: SAFE figures only (counts, estimate, range, verdict), nothing grouped beyond it."""
    counted_days = sorted(s.day for s in p.sessions if s.counted)
    by_day = {s.day: s for s in p.sessions}
    scored = [b for b in p.breaks if b.scored]
    per: dict[str, list[float]] = {}
    for d in counted_days:
        xs = [b for b in scored if b.day == d]
        if xs:
            a = [b.r for b in xs if b.group == "a" and b.r is not None]
            bb = [b.r for b in xs if b.group == "b" and b.r is not None]
            per[d] = [sum(a), len(a), sum(bb), len(bb)]
    sessions_scored = sorted(per)
    point = _diff(scored)
    na, nb = point["n_a"], point["n_b"]
    lo = hi = None
    drawn = 0
    if na and nb:
        diffs, drawn = bootstrap([(v[0], int(v[1]), v[2], int(v[3])) for _, v in sorted(per.items())])
        lo, hi = percentile(diffs, INTERVAL[0]), percentile(diffs, INTERVAL[1])
    half = len(counted_days) // 2
    first, rest = set(counted_days[:half]), set(counted_days[half:])
    h1 = _diff([b for b in scored if b.day in first])
    h2 = _diff([b for b in scored if b.day in rest])
    too_few = na < TOO_FEW_GROUP or nb < TOO_FEW_GROUP or len(counted_days) < TOO_FEW_SESSIONS
    halves_ok = all(h["estimate"] is not None and h["estimate"] > 0 for h in (h1, h2))
    supported = lo is not None and lo > 0 and halves_ok
    verdict = "too_few" if too_few else ("supported" if supported else "falsified")

    for b in p.breaks:
        if b.group == "a" and b.scored:
            _r25(b, by_day[b.day])
    r25 = [b.r25 for b in p.breaks if b.group == "a" and b.scored and b.r25 is not None]

    # the sensitivity table: report only, changes no verdict
    for b in p.breaks:
        if b.group == "contract_failed" and b.failed_gates and b.outcome is None:
            score(b, by_day[b.day], oc.load_session_bars(p.bars_root, b.day), also=True)
            if b.outcome is not None and b.outcome.status == "scored":
                b.r = b.outcome.r
    sens: dict[str, Any] = {}
    for w in ("09:35-10:00", "10:00-11:30", "13:00-close"):
        sens[f"window {w}"] = _diff([b for b in scored if _window_of(b, by_day[b.day].clock.close_ms) == w])
    sens["SPY and QQQ"] = _diff([b for b in scored if b.symbol in INDEXES])
    sens["single names"] = _diff([b for b in scored if b.symbol not in INDEXES])
    sens["b re-weighted to a's mix of name and window"] = _reweighted(scored, by_day)
    cf = [b for b in p.breaks if b.group == "contract_failed"]
    by_check: dict[str, int] = {}
    by_gate: dict[str, int] = {g: 0 for g in (*MARKET_GATES, "none")}
    for b in cf:
        k = b.contract_failed_check or "unknown"
        by_check[k] = by_check.get(k, 0) + 1
        for g in b.failed_gates or ("none",):
            by_gate[g] += 1
    sens["contract_failed by contract check"] = dict(sorted(by_check.items()))
    sens["contract_failed by market gate failed"] = by_gate
    sens["b as first proposed (every market-gate failure, any contract result)"] = _diff(
        [b for b in p.breaks if b.scored or b.group == "contract_failed"],
        lambda x: x.group in ("b", "contract_failed") and bool(x.failed_gates) and x.word in ("WAIT", "NO TRADE")
        and x.outcome is not None and x.outcome.status == "scored")

    counts = {g: sum(1 for b in p.breaks if b.group == g) for g in NOT_SCORED}
    sel: dict[str, Any] = {"switch_date": window.selection_switch}
    if window.selection_switch:
        for g in ("a", "b"):
            sel[g] = {"before": sum(1 for b in scored if b.group == g and b.day < window.selection_switch),
                      "after": sum(1 for b in scored if b.group == g and b.day >= window.selection_switch)}
    return {
        "experiment": "EXP-0034", "hypothesis": "HYP-0059", "trial": "SIG-CONFIRMED",
        "window": {"start": window.start, "close": window.close, "read_day": p.read_day, "trigger": p.trigger},
        "verdict": verdict,
        "measure": "mean R (a) - mean R (b), scored breaks pooled",
        "point_estimate": point["estimate"], "range_95": [lo, hi],
        "halves": {"first": h1, "rest": h2, "sessions": [half, len(counted_days) - half]},
        "group_sizes": {"a": na, "b": nb},
        "sessions": {"counted": len(counted_days), "with_scored_break": len(sessions_scored),
                     "log_incomplete": sum(1 for s in p.sessions if not s.counted)},
        "counted_not_scored": counts,
        "bootstrap": {"prng": "mulberry32", "seed": SEED, "kept": RESAMPLES if drawn else 0, "drawn": drawn,
                      "percentile": "numpy linear", "interval": list(INTERVAL)},
        "secondary_option_r25": {"valued": len(r25), "not_valued": sum(
            1 for b in p.breaks if b.group == "a" and b.scored and b.r25 is None),
            "mean": _mean(r25), "range": [min(r25), max(r25)] if r25 else [None, None]},
        "sensitivity": sens,
        "selection_switch": sel,
        "code": {"outcome_sha256": oc.outcome_code_sha256(), "read_sha256": read_code_sha256()},
    }


def _reweighted(scored: list[Break], by_day: dict[str, Session]) -> dict[str, Any]:
    def cell(b: Break) -> tuple[str, str]:
        return (b.symbol, _window_of(b, by_day[b.day].clock.close_ms))

    a = [b for b in scored if b.group == "a" and b.r is not None]
    bb = [b for b in scored if b.group == "b" and b.r is not None]
    if not a or not bb:
        return {"estimate": None, "n_a": len(a), "n_b": len(bb), "a_share_covered": None}
    b_cells: dict[tuple[str, str], list[float]] = {}
    for x in bb:
        b_cells.setdefault(cell(x), []).append(float(x.r or 0.0))
    a_cells: dict[tuple[str, str], int] = {}
    for x in a:
        a_cells[cell(x)] = a_cells.get(cell(x), 0) + 1
    covered = {k: n for k, n in a_cells.items() if k in b_cells}
    tot = sum(covered.values())
    if not tot:
        return {"estimate": None, "n_a": len(a), "n_b": len(bb), "a_share_covered": 0.0}
    a_cov = [float(x.r or 0.0) for x in a if cell(x) in covered]
    mb = sum(n / tot * (sum(b_cells[k]) / len(b_cells[k])) for k, n in covered.items())
    return {"estimate": sum(a_cov) / len(a_cov) - mb, "n_a": len(a), "n_b": len(bb),
            "a_share_covered": tot / len(a)}


def read_code_sha256() -> str:
    return hashlib.sha256(Path(__file__).read_bytes()).hexdigest()


def run_read(store: Path, bars_root: Path, cal: Calendar, window: Window, frozen: Frozen) -> tuple[Prepared,
                                                                                                    dict[str, Any] | None]:
    """Prepare, then compute only when there is no early end and the read is due."""
    p = prepare(store, bars_root, cal, window, frozen)
    if p.early or p.trigger is None:
        return p, None
    return p, compute(p, window)
