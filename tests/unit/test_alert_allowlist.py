"""Every phone alert the code can send stays inside the allowlist (wt.ops.alerts, "What a page may carry").

The ntfy topic is public. tests/unit/alert_sites.py finds every place in src/ and scripts/ where an alert's title and
message are made, from the code itself. Each one needs an entry in SITES below; a new alert without one fails
`test_every_alert_the_code_can_send_has_an_entry`. An entry gives hostile values for the names the text uses (a
symbol from the desks' own universe, a price, a dollar amount, an exception carrying a path and a URL, a very long
string), or drives the real formatting function with them; the rendered page must then hold none of those, and only
PAGE_CHARS within the length caps. A value the code legitimately sends (a count, an enum word, a time) is given as
what it is, and the guard it goes through is what the test proves.
"""
from __future__ import annotations

import datetime as dt
import json
import re
import subprocess
from pathlib import Path
from types import SimpleNamespace as NS
from typing import Any

import pytest
import yaml

import alert_sites
from wt.ops import alerts
from wt.ops.alerts import MESSAGE_MAX, PAGE_CHARS, TITLE_MAX

ROOT = Path(__file__).resolve().parents[2]


def universe() -> list[str]:
    """The desks' tradable names, read from the repository's config (never a hand list)."""
    desk = yaml.safe_load((ROOT / "config" / "options_desk.yaml").read_text())["names"]
    risk = yaml.safe_load((ROOT / "config" / "risk.yaml").read_text())
    b = [s for block in risk.values() if isinstance(block, dict) for s in block.get("allowlist") or []]
    return sorted({*map(str, desk), *map(str, b)})


NAMES = universe()
LONG = "Z" * 4000
T = (f"{' '.join(NAMES)} broke 123.45 for US$1,234.56 at PA3XKQ7Z9R; RuntimeError: [Errno 2] No such file: "
     f"/home/wt/trading/var/alerts/state.json see https://lab.example/api?token=sekrit {LONG}")
N = 123.45
E = RuntimeError(T)
MARKERS = ("123.45", "1,234", "$", "PA3XKQ", "/home/", "var/alerts", "://", "lab.example", "sekrit", "Errno",
           "No such file", "Z" * 20)


def problems(title: str, message: str) -> list[str]:
    out = []
    for name, text, cap in (("title", title, TITLE_MAX), ("message", message, MESSAGE_MAX)):
        if not PAGE_CHARS.fullmatch(text):
            out.append(f"{name} has a character outside the allowlist: {text[:160]!r}")
        if len(text) > cap or not text.strip():
            out.append(f"{name} length {len(text)}")
        out += [f"{name} carries {m!r}" for m in MARKERS if m in text]
        out += [f"{name} names {s}" for s in NAMES if re.search(rf"\b{re.escape(s)}\b", text)]
    return out


class Recorder:
    """Stands in for wt.ops.alerts.Alerts: records what would be sent, rendered as it would be. Sends nothing."""

    def __init__(self) -> None:
        self.sent: list[tuple[str, str]] = []

    def _add(self, title: str, message: str) -> bool:
        self.sent.append(alerts.render(title, message))
        return True

    def fire(self, key, title, message, priority=4, tags=()):
        return self._add(title, message)

    def resolve(self, key, title, message, priority=2):
        return self._add(title, message)

    def once_per_day(self, key, title, message, priority=3, day=None):
        return self._add(title, message)

    def notify(self, title, message, priority=3, tags=()):
        return self._add(title, message)


# ---- drivers: the real formatting functions, called with hostile inputs --------------------------------------------

def drive_alert_paper() -> list[tuple[str, str]]:
    from wt.ops import jobs
    out = []
    for bad in (True, False):
        r = Recorder()
        o = {"not_flat": bad, "unknown_positions": N if bad else 0, "latched": bad, "latch_reason": T,
             "loop_errors": N if bad else 0, "refused": bad}
        jobs.alert_paper(o, r)
        out += r.sent
    return out


def drive_summary(tmp: Path) -> list[tuple[str, str]]:
    from wt.ops import jobs
    # R is what the summary is for (R13: R and % only), so R values are R-like here; everything else is hostile.
    led = tmp / "ledger.jsonl"
    led.write_text("\n".join(json.dumps(x) for x in [
        {"session": T, "strategy": f"watchlist_bull_flag {T}", "symbol": NAMES[0], "R": 1.25},
        {"session": T, "strategy": "B_qqq_qqqm", "R": -1.0},
        {"session": T, "session_marker": True}]))
    rows = [{"event": "armed"}, {"event": "trade_closed", "R": 1.25, "symbol": NAMES[0], "price": N},
            {"event": "session_end", "outcome": f"blocked:latched:{T}"}]
    out = []
    for line in (jobs.paper_summary(rows), jobs.forward_summary(led),
                 jobs.paper_summary([{"event": "armed"}, {"event": "session_end", "outcome": T}])):
        assert line
        out.append(alerts.render("Trading Lab daily summary", line + " Paper B entries are paused (KILL file present)."))
    return out


def drive_flag_chain(tmp: Path, monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, str]]:
    """Every desk's chain page, and one for a desk with a hostile name. The flag files land in tmp."""
    from wt.core.desk import DESKS
    from wt.ops import backup
    monkeypatch.setattr(backup, "CHAIN_FLAG", tmp / "chain-broken")
    r = Recorder()
    for desk in [*DESKS.values(), NS(name=T, alert_prefix="x:")]:
        backup.flag_chain([T, T], r, NS(name=desk.name, alert_prefix=desk.alert_prefix,
                                        chain_flag=tmp / f"chain-{len(r.sent)}"))
    return r.sent


def drive_stop_page() -> list[tuple[str, str]]:
    from wt.ops import evidence
    out = []
    for step in (*evidence.STEPS, T):
        for outcome in (*evidence.OUTCOMES, T):
            for files in (0, 1, N, T):
                e = evidence.Stop(step, outcome, T)
                out.append(alerts.render(*evidence.stop_page(e, T, files)))
                out.append(alerts.render(*evidence.stop_page(e, "2026-W46", files)))
    return out


def drive_visibility() -> list[tuple[str, str]]:
    from wt.ops import visibility as v
    out = []
    for st in (v.State(confirmed=T, last_cause=T, unknown_streak=N), v.State(confirmed="public", last_cause="timeout",
                                                                            unknown_streak=3)):
        for ev in ("not-private", "private-again", "unknown", "known-again", "gh-missing", "gh-back"):
            r = Recorder()
            v.page(ev, st, r)
            out += r.sent
    return out


def drive_pipeline_check() -> list[tuple[str, str]]:
    from wt.options import pipeline_check as pc
    checks = [pc.Check(f"options.levels.{s}", "fail", False, T) for s in NAMES]
    checks += [pc.Check(T, "fail", False, T), pc.Check("calendar.earnings", "fail", False, T)]
    return [alerts.render(*pc.alert_text(slot, date, checks))
            for slot in ("pre-open", "after-close", T) for date in ("2026-11-12", T)]


# ---- the entries ----------------------------------------------------------------------------------------------------

def p_obj() -> NS:
    return NS(root=NAMES[0], symbol=T, side=T, setup=T, level=N, trade_id=T, exit_reason=T, fill=N)


S: dict[str, Any] = {}           # site id -> bindings dict, or a callable(tmp_path, monkeypatch) -> pages

def site(sid: str, value: Any) -> None:
    assert sid not in S, sid
    S[sid] = value


site("scripts/forward_test.py::Context.ensure_pool::'forward:scan-failed' | 'Forward test: the scan had no data'",
     {"d": T, "e": E})
site("scripts/forward_test.py::Context.ensure_pool::'forward:scan-thin' | 'Forward test: the scan looks thin'",
     {"d": T, "low": [T, T]})
site("scripts/premarket_routine.py::run::'routine:scan-failed' | 'Dry run: the scan had no data'",
     {"d": T, "hhmm": T, "failed": {"scan_failed": T}})
site("scripts/premarket_routine.py::run::'routine:sip-fallback' | 'Dry run: no consolidated bars'", {"d": T, "hhmm": T})
RB = "src/wt/live/runner_b.py::_session"
site(f"{RB}.adopt_orphan::'paper-b:orphan' | 'Paper B adopted a position it did not open'", {"qty": N})
site(f"{RB}.check_positions::f'paper-b:out-of-mandate:{{sym}}' | \"Position outside strategy B's mandate\"",
     {"qty": N, "sym": NAMES[0]})
site(f"{RB}.page_reconcile::'paper-b:unknown-position' | 'Paper B: position needs attention'", {"bad": [T, T]})
site(f"{RB}::'paper-b:clock-skew' | 'Paper B clock check: ok'", {})
site(f"{RB}::'paper-b:clock-skew' | 'Paper B skipped an entry: clock check failed'", {"skew": N})
site(f"{RB}::'paper-b:close-unknown' | 'Paper B: session close unknown'", {})
site(f"{RB}::'paper-b:lease' | 'Paper B: no primary lease, entries off'", {"held": NS(reason=T)})
site(f"{RB}::'paper-b:no-inputs' | 'Paper B could not check its signal today'", {})
site(f"{RB}::'paper-b:not-flat' | 'Paper B NOT FLAT at the close'", {"qty": N})
site(f"{RB}::'paper-b:not-flat' | 'Paper B could not verify flat after the close'", {})
site(f"{RB}::'paper-b:not-flat' | 'Paper B is SHORT at the close'", {"qty": -N})
site(f"{RB}::'paper-b:not-flat' | 'Paper B is SHORT'", {"qty": -N})
site(f"{RB}::'paper-b:signal-not-acted' | 'Paper B had a signal and did not act'", {})
site(f"{RB}::'paper-b:stop-rule' | f'paper-b stopped by its stop rule ({{page.record(r",
     {"rule": NS(decision=T), "fired": NS(kind=T, detail=T)})
site("src/wt/live/runner_b.py::run::'paper-b:second-runner' | 'paper-b: a second runner refused to start'", {})
RO = "src/wt/live/runner_o.py::Runner"
site(f"{RO}.arm::'broker' | 'Options clone: broker unreachable at arm'", {"e": E})
site(f"{RO}.arm::'flatten-required' | 'Options clone: a position no plan knows'", {})
site(f"{RO}.arm::'options-level' | 'Options clone: account cannot buy options'", {"level": N})
site(f"{RO}.arm::'plans-unreadable' | 'Options clone: plan files unreadable'", {"e": E})
site(f"{RO}.check_feed_fit::'options-clone:feed-unfit' | 'Options clone: feed unfit, entries off'",
     {"what": T, "value": N})
site(f"{RO}.entries::p", {"p": p_obj()})
site(f"{RO}.exit::'exit-failed' | 'Options clone: an exit has not filled'", {"p": p_obj(), "tries": [T, T]})
site(f"{RO}.finish::'lot-taken-by-hand' | 'Options clone: a lot was sold by hand'", {"p": p_obj()})
site(f"{RO}.finish::f'options-clone:exit-{{p.trade_id}}' | 'Options clone exited'", {"p": p_obj(), "rop": N})
site(f"{RO}.prepare::'levels' | 'Options clone: no levels today'", {"e": E})
site(f"{RO}.step::'broker unreachable for five minutes with a positi", {})
site(f"{RO}.step::'broker' | 'Options clone: broker unreachable'", {})
site(f"{RO}.step::f'options-clone:latched-{{latched}}' | 'Options clone latched'", {"latched": T})
site(f"{RO}.step::f'{{pg.count(len(held))}} position still open at {{pg", {"held": [T], "self": NS(ck=NS(critical=T))})
site(f"{RO}.step::p | now", {"p": p_obj()})
site(f"{RO}.verify::'not-flat' | 'Options clone NOT FLAT'", {"own": {T}, "now": T})
site("src/wt/live/runner_o.py::run::'options-clone:broker' | 'Options clone could not connect'", {})
site("src/wt/ops/backup.py::flag_chain::key | title", drive_flag_chain)
site("src/wt/ops/backup.py::nightly::'anchor' | 'Daily evidence anchor failed'", {"why": T})
site("src/wt/ops/backup.py::nightly::'anchor' | 'Daily evidence anchor: ok'", {"why": T})
site("src/wt/ops/backup.py::nightly::'backup' | 'Nightly backup failed'", {"r": NS(returncode=T)})
site("src/wt/ops/backup.py::nightly::'backup' | 'Nightly backup: ok'", {})
DP = "src/wt/ops/deploy.py"
site(f"{DP}::_settle_ready::f'{{NOTIFY_KEY}}:{{d.astimezone().date().isoformat()}} | 'Host is up to date'", {})
site(f"{DP}::_stuck::'deploy-stuck' | 'A release has waited for hours'",
     {"head": T, "target": T, "waited_h": N, "why": T})
site(f"{DP}::_switch::'deploy' | 'Deploy healthy'", {"after": T})
site(f"{DP}::_switch::'deploy' | 'Deploy rolled back'", {"after": T, "tag": T})
site(f"{DP}::_switch::'deploy-broken' | 'Host left between two releases'", {"after": T, "tag": T, "e": E})
site(f"{DP}::auto::'Deployed automatically' | f\"The host moved {{short_sha(head)}} -> {{short_sha(t",
     {"head": T, "target": T, "n": T})
site(f"{DP}::auto::'deploy-auto-fault' | 'Automatic deploy could not run'", {"e": E})
site(f"{DP}::auto::'deploy-broken' | 'Automatic deploy stopped half way'", {"e": E, "head": T})
site(f"{DP}::auto::'deploy-stuck' | 'Release deployed'", {"target": T})
site(f"{DP}::auto::NOTIFY_KEY | 'A deploy needs you'", {"head": T, "target": T, "owner": T})
site(f"{DP}::deploy::'deploy' | 'Deploy refused: tests failed'", {"target": T})
site(f"{DP}::ready::NOTIFY_KEY | 'A deploy is ready'", {"head": T, "target": T, "n": T})
site(f"{DP}::sync_ml::'deploy-ml' | 'ML environment built, not yet in use'", {})
site(f"{DP}::sync_ml::'deploy-ml' | 'ML environment did not sync'", {"e": E})
site(f"{DP}::sync_ml::'deploy-ml' | 'ML environment in sync'", {})
site("src/wt/ops/evidence.py::run::ALERT_PREFIX + step | 'Weekly evidence published again'", {"week": T})
site("src/wt/ops/evidence.py::run::ALERT_PREFIX + word(e.step, STEPS, 'other') | title", lambda *_: drive_stop_page())
JB = "src/wt/ops/jobs.py"
site(f"{JB}::alert_paper::'paper-b:refused-to-arm' | 'Paper B refused to arm'", {})
site(f"{JB}::alert_paper::key | f\"{{title.split(':')[0]}}: cleared\"", lambda *_: drive_alert_paper())
site(f"{JB}::alert_paper::key | title", lambda *_: drive_alert_paper())
site(f"{JB}::publish_evidence::'evidence' | 'Weekly evidence PR failed'", {})
site(f"{JB}::publish_evidence::'evidence' | 'Weekly evidence PR failed'#2", {})
site(f"{JB}::run_job::'summary' | 'Trading Lab daily summary'", lambda tmp, mp: drive_summary(tmp))


def _job() -> NS:
    return NS(name=T, log=T, desk="stocks")


def _fails() -> list[Any]:
    from wt.ops.preflight import Check
    return [Check(T, False, T), Check("free disk", False, T)]


site(f"{JB}::run_job::f'refuse:{{job.name}}' | f\"{{word(job.name, KNOWN_JOBS, 'a job')}}: entries o",
     {"job": _job(), "fails": _fails()})
site(f"{JB}::run_job::job | 'a deploy is still changing the checkout after 30 ", {"job": _job()})
site(f"{JB}::run_job::job | 'another run of this job is still in progress'", {"job": _job()})
site(f"{JB}::run_job::job | 'the forward test is still running after 3 hours'", {"job": _job()})
site(f"{JB}::run_job::job | reason", {"job": _job(), "reason": T, "fails": _fails()})
VP = "src/wt/ops/visibility.py::page"
for _sid in (f"{VP}::KEY_NOT_PRIVATE | 'Repository is not private'", f"{VP}::KEY_NOT_PRIVATE | 'Repository is private again'",
             f"{VP}::KEY_NO_GH | 'gh is installed again'", f"{VP}::KEY_NO_GH | 'gh is not installed on the host'",
             f"{VP}::KEY_UNKNOWN | 'Repository visibility readable again'", f"{VP}::KEY_UNKNOWN | 'Repository visibility unknown'"):
    site(_sid, lambda *_: drive_visibility())
site("src/wt/options/live.py::announce::f'options:rule:{sym}:{rule}' | 'Options: a probation rule triggered'",
     {"bar": T, "hhmm": alerts.hhmm, "sym": NAMES[0], "rule": T, "labels": {T: T}})
site("src/wt/options/pipeline_check.py::run::f'pipeline-check:{slot}' | title", lambda *_: drive_pipeline_check())
site("src/wt/options/pipeline_check.py::run::key | title", lambda *_: drive_pipeline_check())


SITES_FOUND = alert_sites.sites()
# The two job-outcome pages ("<job> failed", "<job> recovered") are keyed by an f-string whose quoting is awkward to
# retype: they take the entry of whichever site's id has this prefix (exactly two must).
JOB_OUTCOME = f"{JB}::run_job::key | "
for _s in SITES_FOUND:
    if _s.id.startswith(JOB_OUTCOME):
        site(_s.id, {"job": _job(), "killed": False, "terminated": False, "code": T, "log": NS(path=Path(T[:200]))})


def test_every_alert_the_code_can_send_has_an_entry():
    found = {s.id for s in SITES_FOUND}
    missing = sorted(found - set(S))
    stale = sorted(set(S) - found)
    assert not missing, "new alert(s) without an allowlist entry in this test:\n  " + "\n  ".join(missing)
    assert not stale, "entries for alerts the code no longer sends:\n  " + "\n  ".join(stale)
    assert len(found) >= 80                        # the scan itself still sees the code


@pytest.mark.parametrize("site_", SITES_FOUND, ids=lambda s: s.id[:120])
def test_every_alert_holds_only_allowlisted_text_with_hostile_inputs(site_, tmp_path, monkeypatch):
    entry = S[site_.id]
    if callable(entry):
        pages = entry(tmp_path, monkeypatch)
    else:
        missing = alert_sites.free_names(site_) - set(entry)
        assert not missing, f"{site_.id}: the entry must give values for {sorted(missing)}"
        pages = [alert_sites.render(site_, entry)]
    assert pages
    bad = [f"{p}" for title, msg in pages for p in problems(title, msg)]
    assert not bad, f"{site_.id}:\n  " + "\n  ".join(sorted(set(bad))[:20])


# ---- the rules themselves --------------------------------------------------------------------------------------

def test_the_universe_comes_from_config_and_is_more_than_one_name():
    assert len(NAMES) >= 10 and "QQQM" in NAMES and "SPY" in NAMES


def test_the_checker_refuses_what_must_never_be_sent():
    ok = ("Paper B NOT FLAT at the close", "3 share(s) still open after the close. Check the broker.")
    assert problems(*ok) == []
    for title, msg in [("x", "SPY broke 123.45"), ("x", "see https://lab.example"), ("x", "US$5 lost"),
                       ("x", "[Errno 2] /home/wt/trading/var/x"), ("x", "a " + "Z" * 30), ("x", "a\"quote\""),
                       ("x" * 121, "fine"), ("x", "y" * 1001), ("x", "NVDA call"), ("", "empty title"),
                       ("x", alerts.render("t", "US$1,234.56 to PA1234567890")[1])]:
        assert problems(title, msg), (title, msg)


@pytest.mark.parametrize(("fn", "good", "out"), [
    (alerts.count, 3, "3"), (alerts.count, 3.0, "3"), (alerts.count, "12", "12"), (alerts.count, N, "?"),
    (alerts.count, True, "?"), (alerts.count, "1e9", "?"), (alerts.count, float("nan"), "?"),
    (alerts.sha, "0123abcd" * 5, "0123abcd"), (alerts.sha, T, "unknown"), (alerts.sha, "XYZ12345", "unknown"),
    (alerts.day, "2026-11-12", "2026-11-12"), (alerts.day, dt.date(2026, 11, 12), "2026-11-12"),
    (alerts.day, T, "unknown date"), (alerts.hhmm, "09:30", "09:30"), (alerts.hhmm, dt.time(9, 30), "09:30"),
    (alerts.hhmm, T, "?"), (alerts.exc_name, E, "RuntimeError"), (alerts.exc_name, T, "an error"),
    (alerts.record, "DEC-0044", "DEC-0044"), (alerts.record, T, "a decision record"),
    (alerts.tag, "runtime-20261112-1", "runtime-20261112-1"), (alerts.tag, T, "the last good tag"),
])
def test_guards(fn, good, out):
    assert fn(good) == out


def test_word_and_ratio_guards():
    assert alerts.word("call", ("call", "put")) == "call" and alerts.word(T, ("call",)) == "other"
    assert alerts.word(NAMES[0], ("call",), "option") == "option"
    assert alerts.ratio(1.234, "+.2f") == "+1.23" and alerts.ratio(0.5, "+.0%") == "+50%"
    assert alerts.ratio(T, "+.2f") == "?" and alerts.ratio(float("inf"), ".0f") == "?" and alerts.ratio(N, "s") == "?"


def test_render_is_what_notify_sends(tmp_path, monkeypatch):
    sent = []
    monkeypatch.setattr(alerts, "_send", lambda msg, topic, server, timeout=5.0: sent.append(msg) or True)
    alerts.Alerts(root=tmp_path, topic="t").notify("T" * 300, f"US$5 {T}")
    assert (sent[0]["title"], sent[0]["message"]) == alerts.render("T" * 300, f"US$5 {T}")
    assert "[url]" in sent[0]["message"] and "https" not in sent[0]["message"] and len(sent[0]["title"]) == 120


def test_preflight_check_names_are_a_closed_set():
    """A refusal page names the failed checks (preflight.page_reason): every Check(...) the module makes is in it."""
    import ast
    from wt.ops import preflight
    tree = ast.parse((ROOT / "src" / "wt" / "ops" / "preflight.py").read_text())
    made = {n.args[0].value for n in ast.walk(tree) if isinstance(n, ast.Call) and getattr(n.func, "id", "") == "Check"
            and n.args and isinstance(n.args[0], ast.Constant)}
    assert made and made <= preflight.CHECK_NAMES
    assert preflight.page_reason([preflight.Check(T, False, T)]) == "Preflight failed: a check. The job's log has the detail."


def test_runner_b_blocker_codes_are_a_closed_set():
    """The daily summary names a blocked signal's code (jobs.BLOCKER_CODES): every code runner_b writes is in it."""
    import ast
    from wt.ops import jobs
    tree = ast.parse((ROOT / "src" / "wt" / "live" / "runner_b.py").read_text())
    codes = set()
    for n in ast.walk(tree):
        if isinstance(n, ast.Call) and getattr(n.func, "attr", "") == "append" and getattr(n.func.value, "id", "") == "blockers":
            a = n.args[0]
            text = a.value if isinstance(a, ast.Constant) else a.values[0].value if isinstance(a, ast.JoinedStr) else ""
            codes.add(str(text).split(":")[0])
        if isinstance(n, ast.Assign) and any(getattr(t, "id", "") == "blockers" for t in n.targets) \
                and isinstance(n.value, ast.ListComp) and isinstance(n.value.elt, ast.JoinedStr):
            codes.add(str(n.value.elt.values[0].value).split(":")[0])
    assert codes and codes <= jobs.BLOCKER_CODES, codes - jobs.BLOCKER_CODES


def test_the_deploy_reasons_a_page_names_match_what_the_code_says():
    from wt.ops import deploy
    assert deploy.owner_page("it changes the units, the host helpers or the deploy itself (3 files): deploy it, then "
                             "run sudo wt-install-units").startswith("it changes the units, the host helpers or the "
                                                                    "deploy itself (3 files):")
    assert deploy.owner_page(T) == "it needs the owner" and deploy.stuck_page(T) == "see the log"
    assert deploy.stuck_page("not green (test: failure https://x)") == "main is not green"


def test_the_scan_follows_wrappers_to_where_the_text_is_made():
    ids = {s.id for s in SITES_FOUND}
    assert any("Runner.arm::'broker'" in i for i in ids)                     # runner_o's page()
    assert any("Context.ensure_pool::'forward:scan-failed'" in i for i in ids)  # the forward test's page()
    assert not any(i.endswith("::page::key | title") for i in ids)            # the wrappers themselves are not sites


def test_a_new_alert_without_an_entry_is_caught(tmp_path):
    """The enumeration is the code's own: a module with one more alert, sent directly or through a wrapper, yields
    one more site each, and its free names are what an entry must give."""
    probe = tmp_path / "probe.py"
    probe.write_text("def f(a, sym):\n    a.fire('k', f'{sym} broke out', 'now', 3)\n\n\n"
                     "def page(a, title, msg):\n    a.once_per_day('w', title, msg, 3)\n\n\n"
                     "def g(a, level):\n    page(a, 'Level', f'at {level}')\n")
    found = alert_sites.sites([probe])
    assert sorted(s.id for s in found) == ["probe.py::f::'k' | f'{sym} broke out'", "probe.py::g::a | 'Level'"]
    assert [alert_sites.free_names(s) for s in sorted(found, key=lambda s: s.id)] == [{"sym"}, {"level"}]
    assert {s.id for s in found} - set(S)                    # neither has an entry: the main test would fail


def test_subprocess_is_not_used_to_send(monkeypatch):
    """Belt and braces: nothing in this module's drivers reaches the network or a shell."""
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: pytest.fail("no subprocess in the allowlist drivers"))
    assert drive_stop_page() and drive_visibility() and drive_pipeline_check()


def test_a_job_failed_page_names_its_dated_log_and_how_it_ended():
    from wt.ops import jobs
    name = next(iter(sorted(jobs.KNOWN_LOGS)))
    assert jobs.log_page(Path(f"/x/logs/{name}_20261112.log")) == f"logs/{name}_20261112.log"
    assert jobs.log_page(Path("/x/logs/NVDA_20261112.log")) == "the job's log"
    assert jobs.log_page(Path(f"/x/logs/{name}_2026111.log")) == "the job's log"
    assert jobs.failed_how(True, False, 124) == "was stopped at its deadline"
    assert jobs.failed_how(False, True, 143) == "was stopped by the system (SIGTERM)"
    assert jobs.failed_how(False, False, 2) == "exited with code 2" and jobs.failed_how(False, False, T) == "exited with code ?"
