"""wt.ops.visibility: the one answer to "is the repository private?", its record, and when it pages."""
from __future__ import annotations

import datetime as dt
import json
import re
import subprocess

import pytest

from wt.ops import visibility as v
from wt.ops.visibility import Probe, State

T0 = dt.datetime(2026, 11, 6, 21, 0, tzinfo=dt.UTC)
PAGE = re.compile(r"[A-Za-z0-9 .,:;()'+%/_>?-]*")


class FakeAlerts:
    def __init__(self):
        self.sent: list[tuple[str, str, str, str]] = []

    def fire(self, key, title, message, priority=4, tags=()):
        self.sent.append(("fire", key, title, message))
        return True

    def resolve(self, key, title, message, priority=2):
        self.sent.append(("resolve", key, title, message))
        return True


def run_seq(tmp_path, answers, causes=None):
    """Feed answers one week apart through check(); return the events paged, per run."""
    path, a, out = tmp_path / "vis.json", FakeAlerts(), []
    for i, ans in enumerate(answers):
        cause = (causes or {}).get(i, "ok" if ans != "unknown" else "error")
        before = len(a.sent)
        answer = Probe(ans, cause)
        v.check("t", a, path=path, now=T0 + dt.timedelta(days=7 * i), ask=lambda t, p=answer: p)
        out.append([(kind, key) for kind, key, _, _ in a.sent[before:]])
    return out, a, path


# ---- the state-change edge, both ways -----------------------------------------------------------------------------

def test_first_run_private_pages_nothing(tmp_path):
    out, _, _ = run_seq(tmp_path, ["private"])
    assert out == [[]]


def test_first_run_public_pages_once_then_stays_quiet(tmp_path):
    out, _, _ = run_seq(tmp_path, ["public", "public", "public"])
    assert out == [[("fire", v.KEY_NOT_PRIVATE)], [], []]


def test_private_to_public_pages_and_public_to_private_resolves(tmp_path):
    out, _, _ = run_seq(tmp_path, ["private", "public", "public", "private", "private", "public"])
    assert out == [[], [("fire", v.KEY_NOT_PRIVATE)], [], [("resolve", v.KEY_NOT_PRIVATE)], [],
                   [("fire", v.KEY_NOT_PRIVATE)]]


def test_public_to_internal_is_not_paged(tmp_path):
    out, _, path = run_seq(tmp_path, ["public", "internal"])
    assert out == [[("fire", v.KEY_NOT_PRIVATE)], []]
    assert v.line(v.load(path)).startswith("repo visibility: internal (last confirmed internal on 2026-11-13")


# ---- unknown: never private, never an alarm alone; the third in a row pages once -------------------------------

def test_two_unknowns_are_quiet_the_third_pages_once_and_a_known_answer_resolves(tmp_path):
    out, a, path = run_seq(tmp_path, ["private", "unknown", "unknown", "unknown", "unknown", "private"],
                           causes={3: "timeout"})
    assert out == [[], [], [], [("fire", v.KEY_UNKNOWN)], [], [("resolve", v.KEY_UNKNOWN)]]
    fired = next(m for kind, key, _, m in a.sent if key == v.KEY_UNKNOWN and kind == "fire")
    assert fired.startswith("3 checks in a row") and "last cause: timeout" in fired
    assert v.load(path).unknown_streak == 0


def test_the_streak_restarts_after_a_known_answer(tmp_path):
    out, _, _ = run_seq(tmp_path, ["unknown", "unknown", "public", "unknown", "unknown"])
    assert [e for e in out if (("fire", v.KEY_UNKNOWN) in e)] == []


def test_unknown_keeps_the_last_confirmed_answer_and_says_so(tmp_path):
    _, _, path = run_seq(tmp_path, ["public", "unknown", "unknown"])
    st = v.load(path)
    assert st.confirmed == "public" and st.last == "unknown" and st.unknown_streak == 2
    assert v.line(st) == ("repo visibility: unknown (last confirmed public on 2026-11-06; 2 unknown answer(s) in a "
                          "row, last cause error)")


def test_unknown_is_never_private():
    assert v.decide(State(confirmed="private"), Probe("unknown", "timeout"), T0)[0].last == "unknown"
    assert v.decide(State(), Probe("Private", "ok"), T0)[0].last == "unknown"      # not an exact answer
    assert v.decide(State(), Probe("", "ok"), T0)[0].last == "unknown"


def test_gh_missing_pages_once_does_not_count_and_resolves_when_back(tmp_path):
    out, _, path = run_seq(tmp_path, ["unknown", "unknown", "unknown", "private"],
                           causes={0: "gh-missing", 1: "gh-missing", 2: "error"})
    assert out == [[("fire", v.KEY_NO_GH)], [], [("resolve", v.KEY_NO_GH)], []]
    assert v.load(path).unknown_streak == 0


# ---- probe ----------------------------------------------------------------------------------------------------------

class R:
    def __init__(self, code, out):
        self.returncode, self.stdout, self.stderr = code, out, ""


@pytest.mark.parametrize(("run", "want"), [
    (lambda *a, **k: R(0, "private\n"), Probe("private", "ok")),
    (lambda *a, **k: R(0, "public"), Probe("public", "ok")),
    (lambda *a, **k: R(0, "internal"), Probe("internal", "ok")),
    (lambda *a, **k: R(0, "secret"), Probe("unknown", "error")),
    (lambda *a, **k: R(0, ""), Probe("unknown", "error")),
    (lambda *a, **k: R(1, "private"), Probe("unknown", "error")),
])
def test_probe_answers(run, want):
    assert v.probe("t", run=run, which=lambda n: "/usr/bin/gh") == want


def test_probe_failures():
    def raise_(e):
        def run(*a, **k):
            raise e
        return run
    gh = lambda n: "/usr/bin/gh"  # noqa: E731
    assert v.probe("t", run=raise_(subprocess.TimeoutExpired(["gh"], 60)), which=gh) == Probe("unknown", "timeout")
    assert v.probe("t", run=raise_(FileNotFoundError("gh")), which=gh) == Probe("unknown", "gh-missing")
    assert v.probe("t", run=raise_(OSError("x")), which=gh) == Probe("unknown", "error")
    assert v.probe("t", run=lambda *a, **k: pytest.fail("not run"), which=lambda n: None) == Probe("unknown",
                                                                                                    "gh-missing")


def test_the_token_goes_in_the_environment_never_the_command():
    seen = {}

    def run(cmd, env, **k):
        seen.update(cmd=cmd, env=env)
        return R(0, "private")
    v.probe("ghp-secret", run=run, which=lambda n: "gh")
    assert "ghp-secret" not in " ".join(seen["cmd"]) and seen["env"]["GH_TOKEN"] == "ghp-secret"


# ---- the record and the line ------------------------------------------------------------------------------------

def test_missing_or_corrupt_records_start_again(tmp_path):
    p = tmp_path / "vis.json"
    assert v.load(p) == State()
    for bad in ("{not json", "[]", '{"last": "maybe"}', '{"unknown_streak": -1}', '{"unknown_streak": true}',
                '{"confirmed": "unknown"}', '{"last": 3}'):
        p.write_text(bad)
        assert v.load(p) == State(), bad


def test_the_record_holds_only_enum_words_dates_and_counts(tmp_path):
    _, _, path = run_seq(tmp_path, ["public", "unknown"])
    raw = json.loads(path.read_text())
    assert set(raw) == {"last", "last_at", "last_cause", "confirmed", "confirmed_at", "unknown_streak",
                        "unknown_alerted"}
    assert raw["last"] == "unknown" and raw["confirmed"] == "public" and raw["unknown_streak"] == 1


def test_line_before_any_check():
    assert v.line(State()).startswith("repo visibility: unknown (never checked")


def test_line_never_confirmed():
    st, _ = v.decide(State(), Probe("unknown", "timeout"), T0)
    assert v.line(st) == ("repo visibility: unknown (never confirmed; 1 unknown answer(s) in a row, last cause "
                          "timeout)")


def test_every_page_is_allowlist_clean():
    states = [State(confirmed=c, last_cause=k, unknown_streak=n)
              for c in (*v.KNOWN, None, "PA12345678 $5") for k in (*v.CAUSES, None, "https://x") for n in (0, 3)]
    for ev in ("not-private", "private-again", "unknown", "known-again", "gh-missing", "gh-back"):
        for st in states:
            a = FakeAlerts()
            v.page(ev, st, a)
            assert len(a.sent) == 1
            _, _, title, msg = a.sent[0]
            assert PAGE.fullmatch(title) and PAGE.fullmatch(msg), (ev, title, msg)
            assert "https" not in msg and "PA1" not in msg


def test_an_unwritable_record_still_answers_and_pages(tmp_path, capsys):
    blocker = tmp_path / "file"
    blocker.write_text("x")
    a = FakeAlerts()
    p = v.check("t", a, path=blocker / "sub" / "vis.json", now=T0, ask=lambda t: Probe("public", "ok"))
    assert p.answer == "public" and a.sent and "record not written" in capsys.readouterr().out


def test_status_reads_the_record_and_asks_nothing(tmp_path, monkeypatch, capsys):
    path = tmp_path / "vis.json"
    v.save(State(last="private", last_at="2026-11-12T01:00:00+00:00", last_cause="ok", confirmed="private",
                 confirmed_at="2026-11-12T01:00:00+00:00"), path)
    monkeypatch.setattr(v, "STATE", path)
    monkeypatch.setattr(v, "probe", lambda *a, **k: pytest.fail("status must not ask GitHub"))
    assert v.main(["status"]) == 0
    assert capsys.readouterr().out.strip() == "repo visibility: private (last confirmed private on 2026-11-12)"
