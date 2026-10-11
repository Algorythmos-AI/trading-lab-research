"""Building the Options edition: the next session's levels, the implied-volatility log, the paper scorecard, and
the document the dashboard receives. No network: the caller hands in the pulls and sends the result.

Moved here from the cloud project's `run.py` and `push_options.py` with their behaviour unchanged. The after-close
routine pulls daily bars, hourly bars and a volatility snapshot per name from the broker's read-only data tools;
this module turns those pulls into

  * a levels document for the next session (kept as data/levels/<session>.json),
  * one implied-volatility row per name for the session just finished (appended to data/iv_history.csv),
  * one scorecard row per probation rule that triggered (appended to data/scorecard.csv), and
  * the `stocksdelta/options` edition built from those three.

Research only. Nothing here places, stages or suggests an order.
"""
from __future__ import annotations

import csv
import datetime as dt
import json
import re
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from wt.options import levels as lv
from wt.options import rules

LEVELS_SCHEMA = "stocksdelta/options-levels"
EDITION_SCHEMA = "stocksdelta/options"
EDITION_VERSION = 1
SOURCE = "IBKR daily bars (official close), IBKR implied vol snapshot"
IV_FIELDS = ["session", "ticker", "last", "daily_iv", "annual_iv", "ivp_13w", "ivp_26w", "ivp_52w", "hv_annual",
             "call_vol", "put_vol", "avg_call_vol", "avg_put_vol", "snap_ts"]
SC_FIELDS = ["session", "ticker", "rule", "side", "trigger_bar", "entry", "stop", "target", "exit", "r", "logged_at"]
IV_KEY = ("session", "ticker")
SC_KEY = ("session", "ticker", "rule")
LEVEL_KEYS = ("name", "price", "tf", "weight", "lo", "hi")
ZONE_KEYS = ("lo", "hi", "weight", "members", "side", "big")
HISTORY_DAYS = 420          # calendar days of daily bars the levels are built from
RECENT_BARS = 40            # daily bars sent for the level map's candles
BARS_MAX = 60               # what the edition's schema allows
PAPER_MAX = 40
MIN_HOURLY = 6              # fewer hourly bars than this is not a session worth scoring

Pulls = dict[str, dict[str, Any]]


# ---- reading the pulls

def _tool_text(block: Mapping[str, Any], read: Callable[[str], str | None]) -> str:
    cc = block.get("content")
    txt = cc if isinstance(cc, str) else "".join(x.get("text", "") for x in cc or [] if isinstance(x, dict))
    m = re.search(r"saved to (/\S+?\.txt)", txt)                # large results are written to a file
    if m and (saved := read(m.group(1))) is not None:
        txt = saved
    return txt


def _read_file(path: str) -> str | None:
    try:
        return Path(path).read_text()
    except OSError:
        return None


def extract_transcript(lines: Iterable[str], by_contract: Mapping[str, str], since_ts: str = "",
                       read: Callable[[str], str | None] = _read_file) -> tuple[Pulls, Pulls, Pulls]:
    """(daily, hourly, snapshot) per name: the latest result of each kind among the price-history and snapshot
    tool calls made at or after `since_ts`. `by_contract` maps the broker's contract id to the name."""
    calls: dict[str, tuple[str, str]] = {}
    daily: Pulls = {}
    hourly: Pulls = {}
    snaps: Pulls = {}
    for line in lines:
        try:
            o = json.loads(line)
        except ValueError:
            continue
        if not isinstance(o, dict):
            continue
        c = (o.get("message") or {}).get("content") if isinstance(o.get("message"), dict) else None
        if not isinstance(c, list):
            continue
        for b in c:
            if not isinstance(b, dict):
                continue
            if b.get("type") == "tool_use" and o.get("timestamp", "") >= since_ts:
                name = b.get("name", "")
                if "get_price_history" in name or "get_price_snapshot" in name:
                    calls[b["id"]] = (name, str(b["input"].get("contract_id")))
            elif b.get("type") == "tool_result" and b.get("tool_use_id") in calls:
                name, cid = calls[b["tool_use_id"]]
                t = by_contract.get(cid)
                if not t:
                    continue
                try:
                    d = json.loads(_tool_text(b, read))
                except ValueError:
                    continue
                if not isinstance(d, dict):
                    continue
                if "get_price_snapshot" in name:
                    if "implied-vol-underlying" in d:
                        snaps[t] = d
                elif d.get("chart_step") == 86400:
                    daily[t] = d
                elif d.get("chart_step") == 3600:
                    hourly[t] = d
    return daily, hourly, snaps


def read_pulls(folder: Path, names: Sequence[str]) -> tuple[Pulls, Pulls, Pulls]:
    """(daily, hourly, snapshot) per name from `<NAME>.daily.json`, `<NAME>.hourly.json`, `<NAME>.snapshot.json`.
    A missing or unreadable file is a missing pull, which the run reports for that name."""
    out: tuple[Pulls, Pulls, Pulls] = ({}, {}, {})
    for kind, into in zip(("daily", "hourly", "snapshot"), out, strict=True):
        for name in names:
            try:
                d = json.loads((folder / f"{name}.{kind}.json").read_text())
            except (OSError, ValueError):
                continue
            if isinstance(d, dict):
                into[name] = d
    return out


# ---- the run

def finished_session(now: dt.datetime) -> str:
    """The latest session whose close is final at `now` (UTC, no zone attached, as the engine keeps its times)."""
    d = (now - dt.timedelta(hours=5)).date().isoformat()
    finished = d if lv.is_session(d) else lv.prev_session(d)
    if now < lv.close_final_utc(finished):
        finished = lv.prev_session(finished)
    return finished


def nothing_new(now: dt.datetime, built: Callable[[str], bool]) -> bool:
    """True on a day with no session of its own (weekend, holiday) when the next session's levels already exist."""
    finished = finished_session(now)
    today_ny = (now - dt.timedelta(hours=5)).date().isoformat()
    return not lv.is_session(today_ny) and finished != today_ny and built(lv.next_session(finished))


def _jsonable(got: lv.LevelSet) -> dict[str, Any]:
    out: dict[str, Any] = dict(got)
    out["levels"] = [{k: (round(v, 4) if isinstance(v, float) else v) for k, v in vars(x).items() if v is not None}
                     for x in got["levels"]]
    out["atr14"] = round(got["atr14"], 4)
    out["zones"] = [{k: (round(v, 4) if isinstance(v, float) else v) for k, v in z.items()} for z in got["zones"]]
    return out


@dataclass
class Run:
    finished: str
    session: str
    stamp: str
    tickers: dict[str, dict[str, Any]] = field(default_factory=dict)
    problems: dict[str, list[str]] = field(default_factory=dict)
    iv_rows: list[dict[str, Any]] = field(default_factory=list)
    scorecard_rows: list[dict[str, Any]] = field(default_factory=list)

    @property
    def levels_doc(self) -> dict[str, Any] | None:
        if not self.tickers:
            return None
        return {"schema": LEVELS_SCHEMA, "version": 0, "session": self.session, "built_from": self.finished,
                "built_at": self.stamp, "source": SOURCE, "tickers": self.tickers, "problems": self.problems}

    @property
    def failed(self) -> list[str]:
        """Names with nothing written for them: a data problem that should fail the run."""
        return [t for t in self.problems if t not in self.tickers]


def run(names: Sequence[str], daily: Pulls, hourly: Pulls, snaps: Pulls, now: dt.datetime) -> Run:
    """Everything one after-close run works out, from the pulls alone."""
    finished = finished_session(now)
    nxt = lv.next_session(finished)
    since = (dt.date.fromisoformat(finished) - dt.timedelta(days=HISTORY_DAYS)).isoformat()
    out = Run(finished, nxt, now.strftime("%Y-%m-%dT%H:%MZ"))
    for t in names:
        p: list[str] = []
        if t not in daily:
            out.problems[t] = ["no daily bars in transcript"]
            continue
        ld = lv.load_ibkr(daily[t], since=since, now_utc=now)
        p += ld.problems
        if not ld.bars or ld.bars[-1].d != finished:
            p.append(f"last final daily bar is {ld.bars[-1].d if ld.bars else 'none'}, expected {finished}")
        if p:
            out.problems[t] = p
            continue
        got = lv.levels_for(ld.bars, nxt)
        entry = _jsonable(got) | {"widened_bars": ld.widened,
                                  "recent": [[b.d, b.o, b.h, b.l, b.c] for b in ld.bars[-RECENT_BARS:]]}
        out.tickers[t] = entry

        s = snaps.get(t)
        if s and s.get("implied-vol-underlying", {}).get("is_valid"):
            iv, ivp = s["implied-vol-underlying"], s.get("implied-volatility-percentile", {})
            hv = s.get("historical-vol", {})
            tv, av = s.get("underlying-today-option-volume", {}), s.get("underlying-avg-option-volume", {})
            out.iv_rows.append({
                "session": finished, "ticker": t, "last": s.get("last", {}).get("price"),
                "daily_iv": iv.get("daily_iv"), "annual_iv": iv.get("annual_iv"),
                "ivp_13w": ivp.get("high_13w"), "ivp_26w": ivp.get("high_26w"), "ivp_52w": ivp.get("high_52w"),
                "hv_annual": hv.get("annual_pct"), "call_vol": tv.get("callVolume"), "put_vol": tv.get("putVolume"),
                "avg_call_vol": av.get("avgCallVolume"), "avg_put_vol": av.get("avgPutVolume"),
                "snap_ts": s.get("last", {}).get("ts")})
            ann = iv.get("annual_iv")
            px = got["last"]["close"]
            entry["expected_move"] = {"annual_iv": ann, "day": round(lv.expected_move(px, ann, 1), 2),
                                      "week": round(lv.expected_move(px, ann, 5), 2), "from": "IBKR implied vol"}
        else:
            entry["expected_move"] = None
            out.problems.setdefault(t, []).append("no valid implied-vol snapshot (levels still written)")

        h = hourly.get(t)
        if h:
            hb = [(ts, h["open"][i], h["high"][i], h["low"][i], h["close"][i])
                  for i, ts in enumerate(h["time"]) if ts[:10] == finished]
            if len(hb) >= MIN_HOURLY:
                for x in rules.probation_triggers(hb, lv.levels_for(ld.bars, finished)):
                    out.scorecard_rows.append({"session": finished, "ticker": t, **x, "logged_at": out.stamp})
            else:
                out.problems.setdefault(t, []).append(f"only {len(hb)} hourly bars for {finished}; scorecard skipped")
        else:
            out.problems.setdefault(t, []).append("no hourly bars; scorecard skipped")
    return out


# ---- the two logs

def read_csv(path: Path) -> list[dict[str, str]]:
    if not path.exists():
        return []
    with path.open(newline="") as f:
        return list(csv.DictReader(f))


def append_unique(path: Path, fields: Sequence[str], rows: Sequence[Mapping[str, Any]], key: Sequence[str]) -> int:
    """Append the rows whose key is not in the file yet, so a second run of the same session adds nothing."""
    have = {tuple(r[k] for k in key) for r in read_csv(path)}
    new = [r for r in rows if tuple(str(r[k]) for k in key) not in have]
    if new:
        exists = path.exists()
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", newline="") as f:
            w = csv.DictWriter(f, fieldnames=list(fields))
            if not exists:
                w.writeheader()
            w.writerows(new)
    return len(new)


# ---- the edition

def _rnd(x: Any, p: int = 2) -> float | None:
    return None if x is None or x == "" else round(float(x), p)


def _ticker(sym: str, t: Mapping[str, Any], iv_row: Mapping[str, Any] | None, problems: Sequence[Any]) -> dict[str, Any]:
    em = t.get("expected_move")
    ivp = iv_row.get("ivp_52w") if iv_row else None
    return {
        "symbol": sym,
        "from_bar": t.get("from_bar"),
        "half_day": bool(t.get("half_day")),
        "last": {k: _rnd(t["last"][k]) for k in ("open", "high", "low", "close")} if t.get("last") else None,
        "atr14": _rnd(t.get("atr14")),
        "close_strength": {"pos": _rnd(t["close_strength"]["pos"], 3), "chip": t["close_strength"]["chip"]}
        if t.get("close_strength") else None,
        "expected_move": {"annual_iv": _rnd(em.get("annual_iv"), 4),
                          "iv_pct_52w": _rnd(ivp, 3) if ivp not in (None, "") else None,
                          "day": _rnd(em.get("day")), "week": _rnd(em.get("week")), "from": em.get("from")}
        if em else None,
        "levels": [{k: (_rnd(x[k], 2) if k in ("price", "lo", "hi") else x[k]) for k in LEVEL_KEYS if x.get(k) is not None}
                   for x in t.get("levels", [])],
        "zones": [{k: (_rnd(z[k], 2) if k in ("lo", "hi") else z[k]) for k in ZONE_KEYS if z.get(k) is not None}
                  for z in t.get("zones", [])],
        "bars": [{"d": r[0], "o": _rnd(r[1]), "h": _rnd(r[2]), "l": _rnd(r[3]), "c": _rnd(r[4])}
                 for r in t.get("recent", [])][-BARS_MAX:],
        "problems": [str(p)[:200] for p in problems][:20],
    }


def build_edition(levels_doc: Mapping[str, Any], iv_history: Sequence[Mapping[str, Any]],
                  scorecard: Sequence[Mapping[str, Any]], rules_doc: Mapping[str, Any], now: dt.datetime) -> dict[str, Any]:
    """The `stocksdelta/options` edition from one levels document, the whole volatility log and the whole
    scorecard. `rules_doc` carries the four rules' labels, status and backtest figures."""
    iv = {(r["session"], r["ticker"]): r for r in iv_history}
    probs = levels_doc.get("problems") or {}
    tickers = [_ticker(sym, t, iv.get((levels_doc.get("built_from"), sym)), probs.get(sym, []))
               for sym, t in levels_doc["tickers"].items()]
    out_rules = []
    for r in rules_doc["rules"]:
        rs = [float(x["r"]) for x in scorecard if x["rule"] == r["id"] and x.get("r") not in (None, "")]
        out_rules.append({**r, "live": {"n": len(rs), "avg_r": round(sum(rs) / len(rs), 3) if rs else None,
                                        "wins": sum(1 for v in rs if v > 0)}})
    paper = [{"session": x["session"], "symbol": x["ticker"], "rule": x["rule"], "side": x["side"] or None,
              "entry": _rnd(x["entry"]), "stop": _rnd(x["stop"]), "target": _rnd(x["target"]),
              "exit": x["exit"] or None, "r": _rnd(x["r"], 3)}
             for x in sorted(scorecard, key=lambda x: (x["session"], x["trigger_bar"]), reverse=True)[:PAPER_MAX]]
    now = now.replace(microsecond=0)
    return {
        "schema": EDITION_SCHEMA, "schema_version": EDITION_VERSION,
        "run_id": f"options-{levels_doc['session']}-{now.strftime('%Y%m%dT%H%M%S')}", "as_of": now.isoformat(),
        "session": levels_doc["session"], "built_from": levels_doc.get("built_from"), "source": levels_doc.get("source"),
        "tickers": tickers, "rules": out_rules, "paper": paper,
        "expected_move_check": rules_doc.get("expected_move_check"),
    }
