"""Status dashboard collector: parsers, failure handling, safety guards and document limits."""
import datetime as dt
import importlib.util
import json
import os
import shutil
import threading
from pathlib import Path

import pytest
import yaml

from wt.ops import assemble, safeio, status
from wt.ops.safeio import SourceError

ROOT = Path(__file__).resolve().parents[2]
FIX = ROOT / "tests/fixtures/status"
spec = importlib.util.spec_from_file_location("status_dashboard", ROOT / "scripts/status_dashboard.py")
sd = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sd)
CFG = yaml.safe_load((ROOT / "config/dashboard.yaml").read_text())
NOW = dt.datetime(2026, 9, 28, 13, 45, tzinfo=dt.UTC)


def ctx(tmp_path, **kw):
    base = dict(cfg=CFG, root=ROOT, deployed=tmp_path / "deployed", org=tmp_path / "org", old=tmp_path / "old",
                out=tmp_path / "out", now=NOW, github=False, deadline=10**12)
    base.update(kw)
    (tmp_path / "out").mkdir(exist_ok=True)
    return status.Ctx(**base)


# ------------------------------------------------------------------ safeio


def test_read_json_retries_a_file_caught_mid_write(tmp_path):
    p = tmp_path / "stage.json"
    p.write_text('{"stage": "tier')
    threading.Timer(0.2, lambda: p.write_text('{"stage": "tier1"}')).start()
    assert safeio.read_json(p, retry_delay=0.5) == {"stage": "tier1"}


def test_read_json_gives_up_cleanly_and_respects_the_size_cap(tmp_path):
    p = tmp_path / "bad.json"
    p.write_text("{not json")
    with pytest.raises(SourceError, match="not valid JSON"):
        safeio.read_json(p, retry_delay=0)
    big = tmp_path / "big.json"
    big.write_text("[" + "0," * 2000 + "0]")
    with pytest.raises(SourceError, match="over the"):
        safeio.read_json(big, max_bytes=100)
    with pytest.raises(SourceError, match="missing"):
        safeio.read_json(tmp_path / "absent.json")


def test_read_jsonl_drops_a_torn_last_line_and_counts_bad_middle_lines(tmp_path):
    p = tmp_path / "j.jsonl"
    p.write_text('{"a": 1}\nnot json\n{"a": 2}\n{"a": 3, "b"')
    rows, bad = safeio.read_jsonl(p)
    assert [r["a"] for r in rows] == [1, 2] and bad == 1
    assert safeio.read_jsonl(tmp_path / "missing.jsonl") == ([], 0)


def test_tail_decodes_non_utf8_and_starts_on_a_line_boundary(tmp_path):
    p = tmp_path / "x.log"
    p.write_bytes(b"first line\n" + b"\xff\xfe broken bytes\n" + b"x" * 200 + b"\nlast line\n")
    t = safeio.tail(p, 100)
    assert t.endswith("last line\n") and "first line" not in t
    assert "�" in safeio.tail(p, 10_000)


def test_run_timeout_and_missing_binary_raise_source_error():
    with pytest.raises(SourceError, match="timed out"):
        safeio.run(["sleep", "5"], timeout=1)
    with pytest.raises(SourceError, match="not available"):
        safeio.run(["definitely-not-a-binary-xyz"])
    with pytest.raises(SourceError, match="exited 1"):
        safeio.run(["false"])


def test_writes_are_confined_to_the_output_root(tmp_path):
    root = tmp_path / "out"
    root.mkdir()
    safeio.atomic_write(root / "docs/a.json", "{}", root)
    assert (root / "docs/a.json").read_text() == "{}"
    with pytest.raises(PermissionError):
        safeio.atomic_write(tmp_path / "escape.json", "{}", root)
    with pytest.raises(PermissionError):
        safeio.atomic_write(root / "../escape.json", "{}", root)
    assert not (tmp_path / "escape.json").exists()


def test_output_directory_inside_the_live_checkout_is_refused(tmp_path):
    live = tmp_path / "trading"
    (live / "build").mkdir(parents=True)
    with pytest.raises(PermissionError, match="must never be written"):
        safeio.guard_out_dir(live / "build/dashboard", [live])
    assert safeio.guard_out_dir(tmp_path / "elsewhere", [live]) == (tmp_path / "elsewhere").resolve()


def test_main_refuses_an_output_inside_the_live_checkout(tmp_path, capsys):
    live = tmp_path / "trading"
    live.mkdir()
    cfg = dict(CFG, paths=dict(CFG["paths"], deployed_root=str(live)))
    c = tmp_path / "cfg.yaml"
    c.write_text(yaml.safe_dump(cfg))
    assert sd.main(["--config", str(c), "--out", str(live / "build"), "--no-github"]) == 2
    assert not (live / "build").exists()


def test_run_lock_is_exclusive(tmp_path):
    root = tmp_path / "out"
    with safeio.run_lock(root / ".lock", root):
        with pytest.raises(safeio.Locked):
            with safeio.run_lock(root / ".lock", root):
                pass
    with safeio.run_lock(root / ".lock", root):
        pass


def test_redactor_scrubs_env_values_key_patterns_and_home(tmp_path):
    env = tmp_path / ".env"
    env.write_text("APCA_API_KEY_ID=PKTESTKEY1234567890AB\nAPCA_API_SECRET_KEY=s3cr3t-value-abcdef\nREGION=au\n# c=ignored-comment\n")
    vals = safeio.env_secret_values([env, tmp_path / "missing.env"])
    assert vals == {"PKTESTKEY1234567890AB", "s3cr3t-value-abcdef"}
    r = safeio.Redactor(vals, home="/Users/someone")
    doc = {"a": ["key s3cr3t-value-abcdef here", {"b": "id PKOTHERKEY9999999999ZZ"}],
           "c": "File \"/Users/someone/trading/x.py\"", "d": "api_key=abc123", "n": 3}
    out = json.dumps(r(doc))
    assert "s3cr3t" not in out and "PKOTHER" not in out and "abc123" not in out and "/Users/someone" not in out
    assert "~/trading/x.py" in out and '"n": 3' in out


def test_append_capped_keeps_the_newer_half(tmp_path):
    root = tmp_path / "out"
    root.mkdir()
    for i in range(400):
        safeio.append_capped(root / "refresh.log", f"line {i:04d} " + "x" * 40, root, max_bytes=4000)
    text = (root / "refresh.log").read_text()
    assert len(text.encode()) <= 4000 + 60 and "line 0399" in text and "line 0000" not in text


# ------------------------------------------------------------------ parsers


def test_parse_launchctl_list_reads_pid_status_and_missing_jobs():
    out = (FIX / "launchctl_list.txt").read_text()
    jobs = status.parse_launchctl_list(out, ["com.wt.routine", "com.wt.paper-b", "com.wt.absent"])
    assert jobs["com.wt.routine"] == {"loaded": True, "pid": 60193, "running": True, "last_exit": 1}
    assert jobs["com.wt.paper-b"]["last_exit"] == 0 and jobs["com.wt.paper-b"]["running"] is False
    assert jobs["com.wt.absent"]["loaded"] is False


def test_parse_pmset_repeat_and_wake_coverage():
    wakes = status.parse_pmset_repeat((FIX / "pmset_sched.txt").read_text())
    assert wakes == [{"kind": "wakepoweron", "time": "22:25", "days": "every day"}]
    cov = status.wake_coverage(wakes, ["21:25", "22:30"])
    assert [c["covered"] for c in cov] == [False, True]
    assert status.parse_pmset_repeat("Scheduled power events:\n [0] wake at 09/29/2026 05:30:12 by x\n") == []


def test_parse_swapusage():
    s = status.parse_swapusage("vm.swapusage: total = 8192.00M  used = 7890.62M  free = 301.38M  (encrypted)")
    assert s["total_gb"] == 8.0 and s["used_pct"] == pytest.approx(96.3, abs=0.1)
    assert status.parse_swapusage("garbage") is None


def test_classify_legacy_logs():
    assert status.classify_legacy("- **outcome**: safety-abort\n") == "safety_abort"
    assert status.classify_legacy("- **outcome**: no-candidates\n") == "no_candidates"
    assert status.classify_legacy("- **outcome**: no-trade (SNDQ never broke)\n") == "no_trade"
    assert status.classify_legacy("nothing useful") == "other"


def test_legacy_source_counts_orders_only_when_an_id_is_present(tmp_path):
    d = tmp_path / "org/decisions/2026-07"
    d.mkdir(parents=True)
    shutil.copy(FIX / "legacy_postopen.md", d / "2026-07-01-225320-postopen-scan.md")
    (d / "2026-07-02-225320-postopen-scan.md").write_text("- **outcome**: filled\n- **order_id**: abc-123\n")
    (d / "notes.md").write_text("ignored: no timestamped name")
    res = status.src_legacy(ctx(tmp_path))
    assert res["total"] == 2 and res["orders_placed"] == 1
    assert res["by_month"] == [{"month": "2026-07", "safety_abort": 1, "other": 1}]


# ------------------------------------------------------------------ time


def test_dst_changes_are_found_for_both_zones():
    ch = status.next_dst_changes(NOW, {"Sydney": status.SYD, "New York": status.ET})
    assert [(c["zone"], c["local_date"], c["to_offset"]) for c in ch] == [
        ("Sydney", "2026-10-04", "UTC+11:00"), ("New York", "2026-11-01", "UTC-05:00")]


def test_schedule_check_across_both_dst_changes():
    jobs = CFG["host"]["jobs"]
    syd = lambda y, m, d, h=12: dt.datetime(y, m, d, h, tzinfo=status.SYD)
    rows = status.schedule_check(jobs, syd(2026, 9, 30, 12), "launchd", 40)
    by = {(r["job"], r["et_date"]): r for r in rows}
    assert by[("com.wt.routine", "2026-10-01")]["et"].startswith("Thu 01 Oct 07:30")   # AEST+10 vs EDT-4
    assert by[("com.wt.routine", "2026-10-05")]["et"].startswith("Mon 05 Oct 06:30")   # AEDT+11 vs EDT-4
    assert by[("com.wt.routine", "2026-11-02")]["et"].startswith("Mon 02 Nov 05:30")   # AEDT+11 vs EST-5
    assert all(r["ok"] for r in rows)
    late = status.schedule_check([dict(jobs[0], must_start_before_et="07:00")], syd(2026, 9, 28), "launchd", 1)
    assert late[0]["ok"] is False
    weekend = [r for r in status.schedule_check(jobs[:1], syd(2026, 10, 3, 12), "launchd", 1)
               if r["et_date"] == "2026-10-03"][0]
    assert weekend["session"] is False and weekend["ok"] is True


def test_schedule_lists_each_jobs_next_run_first():
    jobs = CFG["host"]["jobs"]
    now = dt.datetime(2026, 9, 30, 22, 0, tzinfo=status.SYD)         # Wednesday: the routine (21:30) has fired
    rows = status.schedule_check(jobs, now, "launchd", 10)
    first = {}
    for r in rows:
        first.setdefault(r["job"], r)
    assert first["com.wt.routine"]["local"].startswith("Thu 01 Oct 21:30")    # not today's slot, already gone
    assert first["com.wt.paper-b"]["local"].startswith("Wed 30 Sep 22:30")
    assert first["com.wt.weekly"]["local"].startswith("Sat 03 Oct 11:00")    # Saturdays only, never "today"
    assert [r["et_date"] for r in rows] == sorted(r["et_date"] for r in rows)   # in time order


def test_schedule_on_systemd_is_in_new_york_time():
    jobs = CFG["host"]["jobs"]
    now = dt.datetime(2026, 10, 2, 13, 0, tzinfo=status.ET)            # Friday afternoon ET
    rows = status.schedule_check(jobs, now, "systemd", 7)
    first = {}
    for r in rows:
        first.setdefault(r["job"], r)
    assert first["com.wt.routine"]["et"].startswith("Mon 05 Oct 07:30")
    assert first["com.wt.forward"]["et"].startswith("Mon 05 Oct 12:40")      # Friday 12:40 has passed
    assert first["com.wt.weekly"]["et"].startswith("Fri 02 Oct 20:00")
    assert first["com.wt.routine"]["local"] == first["com.wt.routine"]["et"]
    assert all(r["session"] for r in rows)                                # systemd jobs never fire on a weekend


def test_systemd_jobs_are_looked_up_by_job_key():
    seen = []

    class Ctx:
        def run(self, argv, timeout):
            seen.append(argv[2])
            return "LoadState=loaded\nActiveState=inactive\nExecMainStatus=0\n"
    got = status._systemd_jobs(Ctx(), CFG["host"]["jobs"])
    assert seen == ["wt-routine.service", "wt-paper-b.service", "wt-forward.service", "wt-weekly.service"]
    assert all(v["loaded"] and v["last_exit"] == 0 for v in got.values())


def test_market_state_phases():
    at = lambda h, m, day=28: status.market_state(dt.datetime(2026, 9, day, h, m, tzinfo=status.ET))["phase"]
    assert at(9, 29) == "pre-market" and at(9, 30) == "regular session" and at(16, 0) == "after-hours"
    assert at(3, 0) == "overnight" and at(12, 0, day=27) == "weekend"


# ------------------------------------------------------------------ sources and failure handling


def test_research_sources_read_the_real_registry(tmp_path):
    c = ctx(tmp_path)
    res = status.src_research(c)
    board = {r["label"]: r for r in res["scoreboard"]}
    b = board["B · QQQ signals, QQQM orders"]
    assert b["n"] == 415 and b["expectancy_r"] == pytest.approx(0.1173, abs=1e-3) and b["dsr"] == pytest.approx(0.707, abs=1e-3)
    assert board["S1 · Pre-market high break (gap-and-go)"]["expectancy_r"] == pytest.approx(-0.404, abs=1e-3)
    assert all(r["error"] is None for r in res["scoreboard"])
    stale = {h["id"] for h in res["hypotheses"] if h["stale"]}
    assert len(res["round3"]) == 10 and "HYP-0001" in stale              # closed by DEC-0007 but still "pre-registered"
    assert all(("draft" in h["status"]) == (h["id"] in stale) for h in res["hypotheses"] if h["id"] >= "HYP-0010")
    sp = status.src_spec(c)
    assert sp["total"] == 112 and sp["by_status"]["implemented"] >= 106
    cat = status.src_cat01(c)
    assert cat["target_pct"] == 85 and cat["verdicts_total"] == 19 and cat["review_url"].startswith("https://claude.ai/artifact/")


def test_cat01_counts_verdicts_mirrored_from_the_review_page(tmp_path):
    c = ctx(tmp_path)
    d = c.out / "inputs/review_labels/labels"
    d.mkdir(parents=True)
    (d / "H002.json").write_text(json.dumps({"id": "H002", "data": {"item_id": "H002", "part": "blind"}}))
    (d / "S2H004.json").write_text(json.dumps({"id": "S2H004", "data": {"item_id": "S2H004", "part": "disagreement", "owner_verdict": "x"}}))
    (d / "broken.json").write_text("{")
    cat = status.src_cat01(c)
    assert cat["verdicts_on_page"] == 1                                    # only the non-blind file counts
    assert cat["verdicts_done"] == max(cat["verdicts_in_repo"], 1)


def test_collect_falls_back_to_the_last_good_result_marked_stale(tmp_path):
    c = ctx(tmp_path)
    good = status.collect("demo", lambda _: {"x": 1}, c)
    assert good["ok"] and not good["stale"]

    def boom(_):
        raise SourceError("gh timed out after 25s")
    later = status.collect("demo", boom, c)
    assert later["ok"] and later["stale"] and later["data"] == {"x": 1} and "timed out" in later["error"]
    fresh = status.collect("never-worked", lambda _: 1 / 0, c)
    assert fresh["ok"] is False and fresh["data"] is None and "ZeroDivisionError" in fresh["error"]


def test_deadline_stops_further_subprocesses(tmp_path):
    c = ctx(tmp_path, deadline=0)
    with pytest.raises(SourceError, match="deadline"):
        c.run(["echo", "hi"])


def test_github_sources_are_skipped_offline(tmp_path):
    res = status.collect("org", status.src_org, ctx(tmp_path, github=False))
    assert res["ok"] is False and "no-github" in res["error"]


def test_deployed_source_never_writes_to_the_live_checkout(tmp_path):
    live = tmp_path / "deployed"
    live.mkdir()
    for cmd in (["git", "init", "-q"], ["git", "-c", "user.email=a@b", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]):
        safeio.run(["git", "-C", str(live), *cmd[1:]])
    (live / "new.txt").write_text("x")
    before = {p: p.stat().st_mtime_ns for p in live.rglob("*")}
    res = status.src_deployed(ctx(tmp_path))
    after = {p: p.stat().st_mtime_ns for p in live.rglob("*")}
    assert res["untracked"] == 1 and res["behind"] is None and "no-github" in res["compare_error"]
    assert before == after


# ------------------------------------------------------------------ documents


def _degraded_sources():
    return {name: {"ok": False, "stale": False, "as_of": None, "data": None, "error": "down"} for name in status.SOURCES}


def test_all_sources_failed_still_gives_valid_documents():
    docs = assemble.build_docs(_degraded_sources(), CFG, NOW, "run-test", 1.0, {})
    assert assemble.validate(docs) == []
    assert docs["overview"]["headline"].startswith("No proven edge")
    assert [a["id"] for a in docs["overview"]["needs_you"]] == [m["id"] for m in CFG["manual_actions"] if not m.get("done")]


def test_validation_rejects_malformed_documents():
    docs = assemble.build_docs(_degraded_sources(), CFG, NOW, "run-test", 1.0, {})
    docs["overview"]["kpis"] = [{"id": "x", "label": "y", "value": 3, "state": "purple"}]
    del docs["history"]
    problems = assemble.validate(docs)
    assert any(p.startswith("history: missing") for p in problems)
    assert any(p.startswith("overview: kpis/0") for p in problems)


def test_shrink_halves_long_lists_until_the_document_fits():
    doc = {"doc": "ops", "errors": [{"line": "x" * 200} for _ in range(3000)], "keep": [1, 2]}
    small = assemble.shrink(doc, cap=20_000)
    assert len(json.dumps(small, separators=(",", ":"))) <= 20_000
    assert small["keep"] == [1, 2] and small["_truncated"]["errors"] > 2900
    with pytest.raises(ValueError):
        assemble.shrink({"doc": "x", "blob": "y" * 50_000}, cap=1000)


def test_owner_actions_are_detected_and_ranked():
    src = _degraded_sources()
    src["cat01"] = {"ok": True, "data": {"verdicts_done": 3, "verdicts_total": 19, "accuracy_pct": 84.0, "target_pct": 85.0, "review_url": "https://claude.ai/artifact/abc"}}
    src["deployed"] = {"ok": True, "data": {"behind": 3, "missing": [{"sha": "f19b938", "subject": "hybrid feed"}]}}
    src["host"] = {"ok": True, "data": {"disk_free_gb": 1.2, "disk_floor_gb": 3.0, "wake_coverage": [{"needed": "21:25", "covered": False}],
                                        "old_root_exists": False, "swap": {"used_pct": 96.0, "used_gb": 7.7, "total_gb": 8.0}, "swap_warn_pct": 85}}
    acts = assemble.owner_actions(src, CFG)
    ids = [a["id"] for a in acts]
    assert ids[:5] == ["cat01", "swap", "disk", "deployed", "wake"]
    assert "16 remaining" in acts[0]["title"] and acts[0]["severity"] == "blocker"
    assert acts[4]["command"] == "sudo pmset repeat wakeorpoweron MTWRFSU 21:25:00"
    assert [a["rank"] for a in acts] == list(range(1, len(acts) + 1))


def test_page_snapshot_cannot_break_out_of_its_script_element(tmp_path):
    docs = {"meta": {"x": "</script><script>alert(1)</script><!--"}}
    html = sd.render_page(docs)
    blob = html.split('id="snapshot">', 1)[1].split("</script>", 1)[0]
    assert json.loads(blob)["meta"]["x"] == "</script><script>alert(1)</script><!--"
    assert "/*__SNAPSHOT__*/" not in html


def test_end_to_end_offline_run_writes_valid_documents_and_no_secrets(tmp_path, monkeypatch):
    out = tmp_path / "out"
    live = tmp_path / "live"
    (live / "logs").mkdir(parents=True)
    (live / "logs/routine_20260928.log").write_text("ok\nERROR token=SHOULD_NOT_APPEAR\n")
    env = tmp_path / ".env"
    env.write_text("SECRET_VALUE=planted-secret-value-123\n")
    (live / "logs/paper_b_20260928.log").write_text("armed with planted-secret-value-123\n")
    cfg = dict(CFG, paths=dict(CFG["paths"], deployed_root=str(live), org_root=str(tmp_path / "org"),
                               old_root=str(tmp_path / "old"), env_files=[str(env)]))
    c = tmp_path / "cfg.yaml"
    c.write_text(yaml.safe_dump(cfg))
    mirrored = out / "inputs/review_labels/labels"
    mirrored.mkdir(parents=True)
    (mirrored / "S2H004.json").write_text(json.dumps({"item_id": "S2H004", "part": "disagreement"}))
    code = sd.main(["--config", str(c), "--out", str(out), "--no-github", "--deadline", "60"])
    assert code == 1                                     # offline and no live checkout: degraded, still written
    assert not (out / "inputs/review_labels").exists()   # mirrored labels are consumed once
    docs = {p.stem: json.loads(p.read_text()) for p in (out / "docs").glob("*.json")}
    assert set(docs) == set(status.DOC_NAMES) and assemble.validate(docs) == []
    blob = (out / "status.json").read_text() + (out / "index.html").read_text()
    assert "planted-secret-value-123" not in blob and "SHOULD_NOT_APPEAR" not in blob
    assert "refresh.log" in os.listdir(out) and not (out / "last_error.json").exists()
    # a second run is idempotent apart from time-derived fields
    assert sd.main(["--config", str(c), "--out", str(out), "--no-github", "--deadline", "60"]) == 1


def test_bad_config_path_exits_2_without_writing(tmp_path):
    assert sd.main(["--config", str(tmp_path / "missing.yaml"), "--out", str(tmp_path / "out")]) == 2
    assert not (tmp_path / "out").exists()
