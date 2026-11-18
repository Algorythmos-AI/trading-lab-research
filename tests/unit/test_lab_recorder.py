"""The lab's tape recorder (DEC-0060 section 2): a simulated clock and a synthetic Alpaca; no network, no sleeping."""
from __future__ import annotations

import datetime as dt
import json
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import pyarrow.parquet as pq
import pytest

from wt.core.config import ROOT
from wt.data.feeds import require_feed
from wt.lab import focus, manifest, recorder, tiers
from wt.lab.probe import Answer

CAL = ("2026-11-18", "2026-11-19", "2026-11-20", "2026-11-23", "2026-11-24", "2026-11-25", "2026-11-27")
DAY = dt.date(2026, 11, 19)
START = dt.datetime(2026, 11, 19, 14, 30, tzinfo=dt.UTC)          # 09:30 New York


class Clock:
    def __init__(self, t: dt.datetime) -> None:
        self.t = t

    def now(self) -> dt.datetime:
        return self.t

    def sleep(self, seconds: float) -> None:
        if seconds > 0:
            self.t += dt.timedelta(seconds=seconds)


class Alpaca:
    """Two names, AAA and BBB, at 100: same-day calls and next-week puts at strikes mid-5..mid+5. Every option
    quote changes every second sweep. Hooks make chosen calls fail, read low, run slow or raise."""

    def __init__(self, clock: Clock, mids: dict[str, list[float]] | None = None, fail_tier1: set[int] | None = None,
                 remaining: list[str] | None = None, step: float = 0.01, chain_fail: dict[str, int] | None = None,
                 stock_raise: set[int] | None = None, exit_at_stock: int | None = None) -> None:
        self.clock, self.mids = clock, mids or {}
        self.calls: list[tuple[str, dict[str, str]]] = []
        self.n_stock, self.n_sweep, self.n_chain = 0, 0, {"AAA": 0, "BBB": 0}
        self.fail_tier1, self.remaining, self.step = fail_tier1 or set(), remaining or ["9000"], step
        self.chain_fail, self.stock_raise, self.exit_at_stock = chain_fail or {}, stock_raise or set(), exit_at_stock

    def mid(self, name: str) -> float:
        seq = self.mids.get(name, [100.0])
        return seq[min(max(self.n_stock - 1, 0), len(seq) - 1)]

    def headers(self) -> dict[str, str]:
        i = len(self.calls) - 1
        return {"X-RateLimit-Limit": "10000", "X-RateLimit-Remaining": self.remaining[min(i, len(self.remaining) - 1)]}

    def __call__(self, url: str, params: Mapping[str, str], headers: Mapping[str, str], timeout: float) -> Answer:
        require_feed(url, params)
        self.calls.append((url, dict(params)))
        self.clock.t += dt.timedelta(seconds=self.step)
        h = self.headers()
        if url.endswith("/v2/stocks/snapshots"):
            self.n_stock += 1
            if self.exit_at_stock is not None and self.n_stock == self.exit_at_stock:
                recorder.TERM.set()                     # what the SIGTERM handler does
            if self.n_stock in self.stock_raise:
                raise ValueError("a malformed answer")
            return Answer(200, h, {s: {"latestQuote": {"bp": self.mid(s) - 0.01, "ap": self.mid(s) + 0.01,
                                                        "bs": 3, "as": 4, "t": f"q{self.n_stock}"}}
                                   for s in params["symbols"].split(",")}, self.step)
        if "/v1beta1/options/snapshots/" in url:
            root = url.rsplit("/", 1)[1]
            self.n_chain[root] += 1
            if self.n_chain[root] <= self.chain_fail.get(root, 0):
                return Answer(503, h, None, self.step)
            mid = self.mid(root)
            lo, hi = int(mid) - 5, int(mid) + 6
            snaps = {f"{root}261119C{k * 1000:08d}": {"latestQuote": {"ap": 1.0, "bp": 0.9}} for k in range(lo, hi)}
            snaps |= {f"{root}261127P{k * 1000:08d}": {"latestQuote": {"ap": 0.5, "bp": 0.0}} for k in range(lo, hi)}
            snaps["ZZZ261119C00100000"] = {"latestQuote": {"ap": 1.0, "bp": 0.9}}     # another root: never kept
            return Answer(200, h, {"snapshots": snaps}, self.step)
        if url.endswith("/v1beta1/options/snapshots"):
            self.n_sweep += 1
            syms = params["symbols"].split(",")
            if self.n_sweep in self.fail_tier1:
                return Answer(503, h, None, self.step)
            v = 1.0 + (self.n_sweep // 2) * 0.01
            return Answer(200, h, {"snapshots": {s: {"latestQuote": {"bp": 0.0 if s[9] == "P" else v - 0.1, "ap": v,
                                                                     "bs": 1, "as": 2, "t": f"t{self.n_sweep // 2}"},
                                                     "greeks": {"delta": 0.5, "gamma": 0.1}, "dailyBar": {"v": 10}}
                                                 for s in syms}}, self.step)
        return Answer(404, {}, None, 0.0)


@pytest.fixture(autouse=True)
def calendar(monkeypatch: pytest.MonkeyPatch) -> Any:
    monkeypatch.setattr(tiers, "sessions", lambda path=None: CAL)
    recorder.TERM.clear()
    yield
    recorder.TERM.clear()


def make(tmp_path: Path, clock: Clock, api: Alpaca, **kw: Any) -> recorder.Recorder:
    return recorder.Recorder(api, {"APCA-API-KEY-ID": "k", "APCA-API-SECRET-KEY": "s"}, ["AAA", "BBB"], DAY,
                             tmp_path / "tape" / DAY.isoformat(), clock, kw.pop("settings", recorder.Settings()),
                             cal=CAL, off_file=tmp_path / "OFF", free_gb=kw.pop("free_gb", lambda: 40.0),
                             memory_mb=kw.pop("memory_mb", lambda: 100.0), inline_minute=kw.pop("inline", True))


def rows(folder: Path, stream: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for p in sorted(folder.glob(f"{stream}-*.parquet")):
        out += pq.read_table(p).to_pylist()
    return out


def session(tmp_path: Path, minutes: float = 2, **kw: Any) -> tuple[recorder.Recorder, dict[str, Any], Alpaca]:
    clock = Clock(START - dt.timedelta(seconds=30))
    api = kw.pop("api", None) or Alpaca(clock)
    api.clock = clock
    rec = make(tmp_path, clock, api, **kw)
    rec.run(START, START + dt.timedelta(minutes=minutes))
    return rec, rec.finish({"focus_sha256": "f" * 64}), api


def reasons(rec: recorder.Recorder) -> list[str]:
    return [g["reason"] for g in rows(rec.folder, "gap")]


# ---------------------------------------------------------------- a normal session
def test_a_clean_session_has_full_coverage_change_only_rows_and_a_valid_manifest(tmp_path: Path) -> None:
    rec, doc, api = session(tmp_path)
    assert doc["ticks_run"] == 24 and doc["stopped"] is None and doc["freeze_tick"] == 0
    assert len(doc["opening_tier1"]) == 28 and doc["opening_complete"] is True   # 7 calls and 7 puts a name
    assert doc["samples_expected"] == 28 * 23 and doc["samples_taken"] == 28 * 23 and doc["coverage"] == 1.0
    t1 = [r for r in rows(rec.folder, "option") if r["tier"] == 1]
    assert 28 * 23 / 2 <= len(t1) < 28 * 23                       # only changed quotes are written
    assert {r["gamma"] for r in t1} == {0.1}                      # every greek is kept
    assert manifest.verify(rec.folder) == [] and doc["previous_manifest_sha256"] is None
    assert not any(s.startswith("ZZZ") for v in rec.tier1.values() for s in v) and "ZZZ261119C00100000" not in rec.tier2


def test_only_the_focus_names_contracts_are_ever_requested(tmp_path: Path) -> None:
    _, _, api = session(tmp_path)
    seen = set()
    for url, params in api.calls:
        assert params["feed"] in ("opra", "sip")
        if url.endswith("/v1beta1/options/snapshots"):
            seen |= {s[:3] for s in params["symbols"].split(",")}
        elif "/options/snapshots/" in url:
            seen.add(url.rsplit("/", 1)[1])
        else:
            seen |= set(params["symbols"].split(","))
    assert seen == {"AAA", "BBB"}


def test_zero_bids_are_kept_as_zero(tmp_path: Path) -> None:
    rec, _, _ = session(tmp_path)
    puts = [r for r in rows(rec.folder, "option") if r["symbol"][9] == "P"]
    assert puts and all(r["bid"] == 0.0 for r in puts)


def test_tiers_only_grow_and_coverage_stays_on_the_opening_set(tmp_path: Path) -> None:
    clock = Clock(START)
    rec, doc, _ = session(tmp_path, minutes=3, api=Alpaca(clock, mids={"AAA": [100.0] * 13 + [110.0] * 60}))
    opening_a = {s for s in doc["opening_tier1"] if s.startswith("AAA")}
    assert len(opening_a) == 14 and opening_a <= set(rec.tier1["AAA"]) and len(rec.tier1["AAA"]) == 28
    assert all(len(v) <= tiers.RULES.t1_max_per_name for v in rec.tier1.values()) and doc["coverage"] == 1.0


def test_the_minute_work_on_its_worker_thread_gives_the_same_session(tmp_path: Path) -> None:
    _, doc, _ = session(tmp_path, inline=False)
    assert doc["stopped"] is None and len(doc["opening_tier1"]) == 28 and doc["coverage"] > 0.95


# ---------------------------------------------------------------- what goes wrong
def test_a_name_whose_chain_fails_holds_the_freeze_then_is_written_down(tmp_path: Path) -> None:
    clock = Clock(START)
    rec, doc, _ = session(tmp_path, api=Alpaca(clock, chain_fail={"BBB": 99}),
                          settings=recorder.Settings(freeze_by_ticks=12))
    assert doc["freeze_tick"] == 12 and doc["opening_missing"] == ["BBB"] and doc["opening_complete"] is False
    assert any(r.startswith("status 503 BBB") for r in reasons(rec))
    clock2 = Clock(START)
    _, doc2, _ = session(tmp_path / "b", api=Alpaca(clock2, chain_fail={"BBB": 1}))
    assert doc2["opening_complete"] is True and doc2["freeze_tick"] == 12     # BBB joined at the next minute


def test_a_failed_tier_one_answer_is_a_gap_and_lowers_coverage(tmp_path: Path) -> None:
    clock = Clock(START)
    rec, doc, _ = session(tmp_path, api=Alpaca(clock, fail_tier1={6, 11}))
    assert "status 503" in reasons(rec) and 0.9 < doc["coverage"] < 1.0


def test_the_budget_skips_batches_and_says_so(tmp_path: Path) -> None:
    rec, doc, _ = session(tmp_path, settings=recorder.Settings(budget_per_min=20))
    assert any(r == "budget" or r.startswith("budget") for r in reasons(rec))
    assert doc["requests"] <= 20 * 3 and doc["coverage"] < 1.0


def test_a_low_reading_backs_off_for_a_minute_then_recording_resumes(tmp_path: Path) -> None:
    clock = Clock(START)
    rec, doc, _ = session(tmp_path, minutes=4, api=Alpaca(clock, remaining=["1000", "9000"]))
    assert any(r.startswith("budget") or r == "budget" for r in reasons(rec))
    assert doc["requests"] > 40 and doc["samples_taken"] > 0                 # not latched for the day


def test_one_bad_answer_costs_one_tick_and_a_run_of_them_stops_the_session(tmp_path: Path) -> None:
    clock = Clock(START)
    rec, doc, _ = session(tmp_path, api=Alpaca(clock, stock_raise={5}))
    assert "error ValueError" in reasons(rec) and doc["stopped"] is None and doc["tick_errors"] == 1
    clock2 = Clock(START)
    _, doc2, _ = session(tmp_path / "b", api=Alpaca(clock2, stock_raise=set(range(3, 400))),
                         settings=recorder.Settings(max_errors_in_a_row=5))
    assert doc2["stopped"] == "5 errors in a row"


@pytest.mark.parametrize(("kw", "why"), [
    ({"free_gb": lambda: 16.0}, "free disk under 17 GB"),
    ({"memory_mb": lambda: 900.0}, "memory limit"),
])
def test_it_stops_on_low_disk_or_memory_and_writes_why(tmp_path: Path, kw: dict[str, Any], why: str) -> None:
    rec, doc, _ = session(tmp_path, **kw)
    assert doc["stopped"] == why and doc["ticks_run"] == 0 and reasons(rec) == [why]


def test_the_off_switch_stops_it(tmp_path: Path) -> None:
    (tmp_path / "OFF").write_text("")
    assert session(tmp_path)[1]["stopped"] == "off switch"


def test_a_slow_answer_skips_ticks_counts_them_as_missed_and_says_how_many(tmp_path: Path) -> None:
    clock = Clock(START)
    rec, doc, _ = session(tmp_path, api=Alpaca(clock, step=2.0))
    late = [r for r in reasons(rec) if r.startswith("late")]
    assert late and all(int(r.split(", ")[1].split()[0]) >= 1 for r in late)
    assert doc["ticks_run"] < 24 and doc["coverage"] < 1.0


def test_parts_are_flushed_on_a_timer_not_only_at_the_close(tmp_path: Path) -> None:
    rec, _, _ = session(tmp_path, minutes=5, settings=recorder.Settings(flush_every_s=60))
    assert len(list(rec.folder.glob("option-*.parquet"))) >= 4 and len(list(rec.folder.glob("stock-*.parquet"))) >= 4


# ---------------------------------------------------------------- restarts and files
def test_a_restarted_recorder_resumes_from_now_with_the_same_opening_set(tmp_path: Path) -> None:
    clock = Clock(START - dt.timedelta(seconds=30))
    first = make(tmp_path, clock, Alpaca(clock))
    first.run(START, START + dt.timedelta(minutes=1))
    parts = {p.name: manifest.sha256_file(p) for p in first.folder.glob("*.parquet")}
    clock.t = START + dt.timedelta(minutes=3)                        # down for two minutes
    second = make(tmp_path, clock, Alpaca(clock))
    assert second.opening == first.opening and second.counts["restarts"] == 1
    second.run(START, START + dt.timedelta(minutes=4))
    doc = second.finish({})
    assert doc["ticks_run"] == 12 + 12 and doc["restarts"] == 1
    assert doc["samples_expected"] == 28 * 47 and doc["samples_taken"] == 28 * 23      # 2 minutes down: missed
    assert doc["coverage"] == round(23 / 47, 6)
    for name, sha in parts.items():
        assert manifest.sha256_file(first.folder / name) == sha     # nothing written before is touched
    assert manifest.verify(first.folder) == []


def test_manifests_chain_through_the_head_even_after_pruning(tmp_path: Path) -> None:
    prev = tmp_path / "tape" / "2026-11-18"
    prev.mkdir(parents=True)
    manifest.write(prev, {"recorded": False})
    sha = manifest.sha256_file(prev / manifest.NAME)
    for p in prev.iterdir():
        p.unlink()
    prev.rmdir()                                                     # pruned locally after upload
    rec, doc, _ = session(tmp_path, minutes=1)
    assert doc["previous_manifest_sha256"] == sha
    part = sorted(rec.folder.glob("option-*.parquet"))[0]
    part.write_bytes(part.read_bytes() + b"x")
    assert manifest.verify(rec.folder) == [f"changed {part.name}"]


def test_the_tape_may_not_live_inside_the_repository(tmp_path: Path) -> None:
    with pytest.raises(ValueError):
        recorder.tape_root({"WT_LAB_TAPE": str(ROOT / "lab-tape")})
    assert recorder.tape_root({}) == (ROOT.parent / "lab-tape").resolve()
    assert recorder.tape_root({"WT_LAB_TAPE": str(tmp_path)}) == tmp_path.resolve()


def test_only_one_recorder_runs_at_a_time(tmp_path: Path) -> None:
    with recorder.single(tmp_path) as a:
        with recorder.single(tmp_path) as b:
            assert a is True and b is False


# ---------------------------------------------------------------- main(): the day's rules
ENV = {"APCA_CLONE_KEY_ID": "k", "APCA_CLONE_SECRET_KEY": "s"}


def run_main(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, f: focus.Focus | None, clock: Clock,
             api: Alpaca | None = None) -> tuple[int, Path]:
    monkeypatch.setattr(focus, "read", lambda env=None, get=None, now=None: f)
    monkeypatch.setattr(recorder, "desk_names", lambda path=None: {"AAA", "BBB", "SPY"})
    monkeypatch.setattr(tiers, "close_time", lambda day, path=None: dt.time(9, 32))
    monkeypatch.setattr(recorder, "clock_offset_ms", lambda: 1.5)
    monkeypatch.setattr(recorder.shutil, "disk_usage", lambda p: type("U", (), {"free": 40e9})())
    monkeypatch.setattr(recorder, "rss_mb", lambda: 100.0)
    env = {**ENV, "WT_LAB_TAPE": str(tmp_path / "tape")}
    rec_file = tmp_path / "DEC-0060.md"
    rec_file.write_text("- **Status: ACCEPTED on 2026-11-20 (New York).**")
    rc = recorder.main(clock=clock, get=api or Alpaca(clock), env=env, inline_minute=True, record=rec_file)
    return rc, tmp_path / "tape" / clock.t.astimezone(recorder.NY).date().isoformat()


F = focus.Focus("2026-11-19", ("AAA", "ZZZ", "BBB"), "a" * 64)


def test_main_records_the_days_desk_focus_names(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    rc, folder = run_main(tmp_path, monkeypatch, F, Clock(START - dt.timedelta(minutes=10)))
    doc = json.loads((folder / manifest.NAME).read_text())
    assert rc == 0 and doc["recorded"] is True and doc["names"] == ["AAA", "BBB"] and doc["focus_sha256"] == "a" * 64
    assert doc["clock_offset_ms"] == 1.5 and doc["budget_per_min"] == 400 and doc["coverage"] == 1.0


@pytest.mark.parametrize("f", [None, focus.Focus("2026-11-18", ("AAA",), "b" * 64),
                               focus.Focus("2026-11-19", ("ZZZ",), "c" * 64)])
def test_main_records_nothing_without_todays_focus_list(tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
                                                        f: focus.Focus | None) -> None:
    rc, folder = run_main(tmp_path, monkeypatch, f, Clock(START - dt.timedelta(minutes=10)))
    doc = json.loads((folder / manifest.NAME).read_text())
    assert rc == 0 and doc["recorded"] is False and doc["files"] == [] and not list(folder.glob("*.parquet"))


def test_main_does_nothing_on_a_day_without_a_session(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    rc, folder = run_main(tmp_path, monkeypatch, F, Clock(dt.datetime(2026, 11, 21, 14, 0, tzinfo=dt.UTC)))
    assert rc == 0 and not folder.exists()


def test_main_stopped_mid_session_keeps_state_and_resumes_without_reading_focus_again(
        tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    clock = Clock(START - dt.timedelta(minutes=10))
    rc0, folder = run_main(tmp_path, monkeypatch, F, clock, Alpaca(clock, exit_at_stock=8))   # SIGTERM at 09:30:35
    assert rc0 == 143 and (folder / recorder.STATE).exists() and not (folder / manifest.NAME).exists()
    recorder.TERM.clear()
    clock.t = START + dt.timedelta(seconds=90)
    rc, _ = run_main(tmp_path, monkeypatch, None, clock)          # focus would now say nothing: it is not asked
    doc = json.loads((folder / manifest.NAME).read_text())
    assert rc == 0 and doc["recorded"] is True and doc["restarts"] == 1 and doc["names"] == ["AAA", "BBB"]
    rc2, _ = run_main(tmp_path, monkeypatch, F, clock)
    assert rc2 == 0 and json.loads((folder / manifest.NAME).read_text()) == doc          # never recorded twice


def test_main_after_a_stop_past_the_close_writes_the_manifest_with_what_it_has(
        tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    clock = Clock(START - dt.timedelta(minutes=10))
    assert run_main(tmp_path, monkeypatch, F, clock, Alpaca(clock, exit_at_stock=8))[0] == 143
    recorder.TERM.clear()
    clock.t = START + dt.timedelta(minutes=5)                      # restarted after the (patched) 09:32 close
    rc, folder = run_main(tmp_path, monkeypatch, None, clock)
    doc = json.loads((folder / manifest.NAME).read_text())
    assert rc == 0 and doc["recorded"] is True and doc["ticks_run"] < 24 and doc["restarts"] == 1


def test_archiving_never_fails_the_day_and_says_what_it_did(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    close = START + dt.timedelta(hours=6, minutes=30)
    assert recorder.archive_today(tmp_path, {}, close, Clock(close)).startswith("no lab bucket credentials")
    from wt.lab import archive
    monkeypatch.setattr(archive, "store_from_env", lambda env: object())
    assert recorder.archive_today(tmp_path, {}, close, Clock(close + dt.timedelta(hours=2))).startswith("past close")
    monkeypatch.setattr(archive, "upload_all", lambda *a, **k: [{"session": "2026-11-19", "verified": True},
                                                                {"session": "2026-11-18", "verified": False}])
    monkeypatch.setattr(archive, "prune", lambda root, keep=10: ["2026-11-01"])
    assert recorder.archive_today(tmp_path, {}, close, Clock(close)) == "1 uploaded, 1 not (2026-11-18), 1 pruned"

    def boom(*a: Any, **k: Any) -> Any:
        raise OSError("network")
    monkeypatch.setattr(archive, "upload_all", boom)
    assert recorder.archive_today(tmp_path, {}, close, Clock(close)) == "error OSError"


def test_an_early_stop_counts_every_tick_due_to_the_close_as_missed(tmp_path: Path) -> None:
    clock = Clock(START - dt.timedelta(seconds=30))
    api = Alpaca(clock)
    rec = make(tmp_path, clock, api)
    rec.run(START, START + dt.timedelta(minutes=1))                 # stopped after one of thirty minutes
    rec.scheduled = 360                                             # the session it belonged to: 30 minutes
    doc = rec.finish({})
    assert doc["samples_expected"] == 28 * 359 and doc["coverage"] < 0.05


def test_a_late_first_start_freezes_after_its_own_first_minute_not_an_empty_set(tmp_path: Path) -> None:
    clock = Clock(START + dt.timedelta(minutes=6))                  # first started at 09:36
    rec = make(tmp_path, clock, Alpaca(clock), inline=False)
    rec.run(START, START + dt.timedelta(minutes=9))
    doc = rec.finish({})
    assert len(doc["opening_tier1"]) == 28 and doc["opening_complete"] is True and doc["freeze_tick"] >= 72
    assert doc["coverage"] > 0.9


def test_a_bad_state_file_is_set_aside_not_fatal(tmp_path: Path) -> None:
    folder = tmp_path / "tape" / DAY.isoformat()
    folder.mkdir(parents=True)
    (folder / recorder.STATE).write_text("{not json")
    clock = Clock(START)
    rec = make(tmp_path, clock, Alpaca(clock))
    assert rec.counts["restarts"] == 1 and (folder / (recorder.STATE + ".bad")).exists() and rec.opening is None


def test_sigterm_stops_at_the_next_check_and_writes_no_manifest(tmp_path: Path) -> None:
    clock = Clock(START - dt.timedelta(seconds=30))
    rec = make(tmp_path, clock, Alpaca(clock, exit_at_stock=5))
    rec.run(START, START + dt.timedelta(minutes=2))
    assert rec.stopped == "sigterm" and rec.counts["ticks_run"] < 24
    assert (rec.folder / recorder.STATE).exists() and not (rec.folder / manifest.NAME).exists()


def test_nothing_is_recorded_until_dec_0060_is_accepted(tmp_path: Path, capsys: Any) -> None:
    proposed = tmp_path / "DEC-0060.md"
    proposed.write_text("- **Status: PROPOSED.** The owner approved the plan")
    clock = Clock(START - dt.timedelta(minutes=10))
    api = Alpaca(clock)
    rc = recorder.main(clock=clock, get=api, env={**ENV, "WT_LAB_TAPE": str(tmp_path / "tape")}, record=proposed)
    assert rc == 0 and api.calls == [] and not (tmp_path / "tape").exists()
    assert "not accepted" in capsys.readouterr().out
    assert recorder.accepted(tmp_path / "missing.md") is False
    assert recorder.accepted() is False                       # the record in this repository is still PROPOSED
