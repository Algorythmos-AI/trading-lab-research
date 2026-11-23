"""The Options desk's selection universe for one session (DEC-0070, PROPOSED): the desk's 12 names plus the Radar's
candidates that pass a fail-closed gate. Pure: no network, no clock.

    record = gate(candidates, desk, bars, chains, earnings_rows, params, cfg)

`candidates` is a `wt.options.radar_candidates` record for session S; `bars` maps a symbol to its Stage 1 bundle bar
list (the split-adjusted SIP daily bars ending at D, the session before S, as `select_fetch.fetch_stage1` saves them);
`chains` maps a candidate to its `ChainFacts` (None when its chain could not be read); `earnings_rows` are the rows of
config/events/earnings.csv and config/events/earnings_radar.csv; `params` Stage 1's frozen parameters
(`wt.options.select.load_params`, unchanged); `cfg` config/options_universe.yaml.

The desk's 12 names never pass through the gate. A candidate is checked in this order; the first check that fails
names its reject, and nothing after it is asked:

0. `radar_avoid`: the edition's own `avoid` section names it. `radar_risk`: the edition tags it `risk`.

1. `bars_<code>`: Stage 1's own validity check (`select.validity`) fails, with its code (bad_bar, stale_bar,
   short_history, missing_session, suspect_split).
2. `price_low`: the close of D is under `gate.price_min`.
3. `dollar_volume_low`: the median of close x volume over Stage 1's dollar-volume lookback is under the floor.
4. `chain_unavailable`: no chain could be read. `chain_no_expiry`: no listed expiry from S within
   `chain_expiry_max_days`. `chain_thin`: fewer near-the-money contracts than the floor. `chain_volume_low`: their
   prior-session volume is under the floor. `chain_spread_wide`: their median spread is over the cap, or none has a
   two-sided quote.
5. `earnings_unknown`: a single name whose next report is not known (Stage 1's caution earnings_date_unknown,
   `wt.risk.events.earnings_gaps`, promoted to a reject). `earnings_in_radar_calendar`: the edition's calendar names a
   report for the symbol on D, S or the session after S.

The candidates that pass are cut to `gate.max_additions` by (best list priority, higher evidence grade, symbol A to Z);
the rest are `over_cap`. While a gate threshold is unset, every candidate is `gate_unset` and none is admitted.

Every verdict carries the candidate's facts (`facts_of`), set or unset: the edition's avoid and risk flags, Stage 1's
validity code, D's close, the median dollar volume, the chain facts, whether its next report is known, and whether the
edition's calendar names a report in the hold. They are what the gate's thresholds are set from (DEC-0070 section 3:
status frequencies on saved data, never outcomes; `scripts/options_universe_frequencies.py`). All are known before S
opens; none is an outcome.
The universe is the 12 followed by the admitted names in that order. Stage 1 then ranks them
all with its frozen rules: on a wider universe its ranks are relative to every name, so the 12's ranks can move.
"""
from __future__ import annotations

import datetime as dt
import statistics
from collections.abc import Mapping, Sequence
from dataclasses import asdict, dataclass
from typing import Any

from wt.options import chain as ch
from wt.options import levels as lv
from wt.options import radar_candidates as rc
from wt.options import select as sel
from wt.risk import events as ev

SCHEMA = "wt.options/universe"
VERSION = 2            # 2: every verdict carries the candidate's gate facts (`facts`), the gate set or not
CHAIN_REJECTS = ("chain_unavailable", "chain_no_expiry", "chain_thin", "chain_volume_low", "chain_spread_wide")
REJECT_CODES = ("radar_avoid", "radar_risk") + tuple(f"bars_{c}" for c in sel.VALIDITY_CODES) + (
    "price_low", "dollar_volume_low") + CHAIN_REJECTS + ("earnings_unknown", "earnings_in_radar_calendar", "over_cap",
                                                       "gate_unset", "internal_error")


@dataclass(frozen=True)
class ChainFacts:
    """What the gate reads of one name's option chain, from the broker's snapshots of its nearest expiry."""
    expiry: str | None              # the nearest listed expiry on or after S, or None
    ntm_contracts: int              # contracts of that expiry with a strike within chain_ntm_pct of the close
    ntm_volume: float               # their prior-session summed volume
    ntm_spread_pct: float | None    # the median (ask - bid) / mid over those with a two-sided quote; None if none


def chain_facts(quotes: Sequence[ch.Quote], close: float, session: str, cfg: rc.Config,
                root: str | None = None) -> ChainFacts:
    """ChainFacts from parsed snapshots (`wt.options.chain.parse_snapshots`). With `root`, only that root's contracts
    count (a snapshot answer for another underlying is never read as this name's chain). Pure."""
    if root is not None:
        quotes = [q for q in quotes if q.contract.root == root]
    s = dt.date.fromisoformat(session)
    last = s + dt.timedelta(days=cfg.chain_expiry_max_days)
    expiries = sorted({q.contract.expiry for q in quotes if s <= q.contract.expiry <= last})
    if not expiries or close <= 0:
        return ChainFacts(None, 0, 0.0, None)
    exp = expiries[0]
    near = [q for q in quotes if q.contract.expiry == exp and abs(q.contract.strike - close) <= cfg.chain_ntm_pct * close]
    spreads = [(q.ask - q.bid) / q.mid for q in near if q.bid is not None and q.ask is not None and q.mid]
    return ChainFacts(exp.isoformat(), len(near), float(sum(q.volume for q in near)),
                      statistics.median(spreads) if spreads else None)


def priority(c: Mapping[str, Any], cfg: rc.Config) -> tuple[int, int, str]:
    best = min(cfg.list_priority.index(n) for n in c["lists"])
    return best, -(c["evidence_grade"] or 0), c["symbol"]


def _check(c: Mapping[str, Any], parsed: list[lv.Bar] | None, facts: ChainFacts | None, d: str, s: str,
           rows: Sequence[Mapping[str, Any]], p: sel.Params, cfg: rc.Config) -> str | None:
    sym = c["symbol"]
    if c.get("avoid", True):                       # a record without the field is read as avoided: fail closed
        return "radar_avoid"
    if c.get("risk_tag", True):
        return "radar_risk"
    why = sel.validity(parsed, d, p)
    if why is not None or parsed is None:
        return f"bars_{why or 'bad_bar'}"
    window = parsed[-p.min_bars:]
    close = window[-1].c
    assert cfg.price_min is not None and cfg.median_dollar_volume_min is not None
    if close < cfg.price_min:
        return "price_low"
    dv = statistics.median(b.c * b.v for b in window[-p.dollar_volume:])
    if dv < cfg.median_dollar_volume_min:
        return "dollar_volume_low"
    if facts is None:
        return "chain_unavailable"
    if facts.expiry is None:
        return "chain_no_expiry"
    assert cfg.chain_ntm_strikes_min is not None and cfg.chain_volume_min is not None
    assert cfg.chain_spread_max_pct is not None
    if facts.ntm_contracts < cfg.chain_ntm_strikes_min:
        return "chain_thin"
    if facts.ntm_volume < cfg.chain_volume_min:
        return "chain_volume_low"
    if facts.ntm_spread_pct is None or facts.ntm_spread_pct > cfg.chain_spread_max_pct:
        return "chain_spread_wide"
    if sym not in p.index_names and ev.earnings_gaps(rows, [sym], dt.date.fromisoformat(d),
                                                     p.earnings_unknown_after_days):
        return "earnings_unknown"
    hold = {d, s, lv.next_session(s)}
    if hold & set(c["calendar_earnings"]):
        return "earnings_in_radar_calendar"
    return None


def facts_of(c: Mapping[str, Any], parsed: list[lv.Bar] | None, chain: ChainFacts | None, d: str, s: str,
             rows: Sequence[Mapping[str, Any]], p: sel.Params) -> dict[str, Any]:
    """The facts the gate reads for candidate `c`, whatever its thresholds: no threshold is applied here."""
    sym = c["symbol"]
    why = sel.validity(parsed, d, p)
    out: dict[str, Any] = {
        "avoid": bool(c.get("avoid", True)), "risk_tag": bool(c.get("risk_tag", True)),
        "validity": "ok" if why is None and parsed is not None else (why or "bad_bar"),
        "close": None, "median_dollar_volume": None,
        "chain": None if chain is None else asdict(chain),
        "earnings_known": None if sym in p.index_names else not ev.earnings_gaps(
            rows, [sym], dt.date.fromisoformat(d), p.earnings_unknown_after_days),
        "earnings_in_hold": bool({d, s, lv.next_session(s)} & set(c.get("calendar_earnings") or [])),
    }
    if out["validity"] == "ok" and parsed is not None:
        window = parsed[-p.min_bars:]
        out["close"] = round(window[-1].c, 4)
        out["median_dollar_volume"] = round(statistics.median(b.c * b.v for b in window[-p.dollar_volume:]), 2)
    return out


def gate(candidates: Mapping[str, Any], desk: Sequence[str], bars: Mapping[str, Any],
         chains: Mapping[str, ChainFacts | None], earnings_rows: Sequence[Any], p: sel.Params,
         cfg: rc.Config) -> dict[str, Any]:
    """The universe record (see the module text). While any gate threshold is unset (null in the config), every Radar
    name is rejected `gate_unset` and the universe is the desk's 12: an unset gate never admits anything."""
    s = candidates["session"]
    d = lv.prev_session(s)
    core = list(dict.fromkeys(desk))
    pending = [c for c in candidates["candidates"] if not c["core"]] if candidates["status"] == "ok" else []
    unset = bool(cfg.unset())
    # A row more than EARNINGS_MAX_AHEAD_DAYS after D is malformed (a junk far-future date never makes a report known).
    rows = [r for r in earnings_rows
            if isinstance(r, Mapping) and ev.earnings_row_problem(r, dt.date.fromisoformat(d)) is None]
    verdicts: list[dict[str, Any]] = []
    passed: list[Mapping[str, Any]] = []
    for c in pending:
        try:
            parsed = sel.parse_bars(bars.get(c["symbol"], []))
        except Exception:                                   # one name never stops the others
            parsed = None
        try:
            code = "gate_unset" if unset else _check(c, parsed, chains.get(c["symbol"]), d, s, rows, p, cfg)
        except Exception:                                   # one name never stops the others; it is never admitted
            code = "internal_error"
        chain = chains.get(c["symbol"])
        try:
            facts: dict[str, Any] | None = facts_of(c, parsed, chain, d, s, rows, p)
        except Exception:                                   # a fact that cannot be read is recorded as missing
            facts = None
        verdicts.append({"symbol": c["symbol"], "reject": code, "chain": None if chain is None else asdict(chain),
                         "facts": facts})
        if code is None:
            passed.append(c)
    passed.sort(key=lambda c: priority(c, cfg))
    admitted = [c["symbol"] for c in passed[:cfg.max_additions]]
    for v in verdicts:
        if v["reject"] is None and v["symbol"] not in admitted:
            v["reject"] = "over_cap"
    by_code: dict[str, int] = {}
    for v in verdicts:
        if v["reject"]:
            by_code[v["reject"]] = by_code.get(v["reject"], 0) + 1
    return {
        "schema": SCHEMA,
        "version": VERSION,
        "universe_sha": cfg.sha,
        "session": s,
        "finished_session": d,
        "radar_status": candidates["status"],
        "gate_unset": cfg.unset(),
        "names": core + [n for n in admitted if n not in core],
        "origin": {**{n: "core" for n in core}, **{n: "radar" for n in admitted if n not in core}},
        "radar_on_desk": sorted(c["symbol"] for c in candidates["candidates"] if c["core"]),
        "verdicts": sorted(verdicts, key=lambda v: v["symbol"]),
        "counts": {"core": len(core), "candidates_gated": len(pending), "admitted": len(admitted),
                   "rejected": dict(sorted(by_code.items()))},
    }
