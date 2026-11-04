"""The options clone's review and verdict (DEC-0030, section 6)."""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

from wt.options import review

ROOT = Path(__file__).resolve().parents[2]


def script(name: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def row(day: int, n: int, rop: float, setup: str = "retest", counts: bool = True, state: str = "closed") -> dict:
    fill = 1.0
    return {"event": "trade_closed", "trade_id": f"2026-11-{day:02d}-O-{n}", "setup": setup, "state": state,
            "counts": counts, "fill": fill, "exit_fill": fill * (1 + rop), "best_bid": fill * (1 + max(rop, 0) + 0.2),
            "rop": rop, "pnl": round(rop * 100, 2), "exit_reason": "target" if rop > 0 else "premium"}


def book(n_days: int, per_day: int, rops: list[float], setup: str = "retest") -> list[dict]:
    out, k = [], 0
    for d in range(1, n_days + 1):
        for j in range(per_day):
            out.append(row(d, j + 1, rops[k % len(rops)], setup))
            k += 1
    return out


def test_too_few_trades_is_no_verdict():
    v, why = review.verdict(review.figures(book(10, 2, [0.5, -0.25])))
    assert v == "none" and "20 of 30 trades" in why[0]


def test_a_steady_edge_passes_and_a_flat_one_is_falsified():
    good = review.review(book(25, 2, [0.5, -0.25, 0.5]))
    assert good["retest"]["verdict"] == "passes" and good["retest"]["ci_session"][0] > 0
    flat = review.review(book(25, 2, [0.5, -0.25, -0.25]))
    assert flat["retest"]["verdict"] == "falsified" and "range-by-session-not-above-zero" in flat["retest"]["why"]


def test_a_good_first_half_and_a_bad_second_is_falsified():
    rows = book(12, 2, [0.6, 0.4]) + [row(13 + d, 1, -0.3) for d in range(12)] + [row(13 + d, 2, -0.2) for d in range(12)]
    f = review.figures(rows)
    assert f["first_half_mean"] > 0 >= f["second_half_mean"]
    assert review.verdict(f)[0] == "falsified" and "second-half-not-above-zero" in review.verdict(f)[1]


def test_unresolved_trades_are_counted_apart():
    rows = book(2, 1, [0.5]) + [row(3, 1, 0.9, counts=False, state="unresolved")]
    f = review.figures(rows)
    assert f["trades"] == 2 and f["unresolved"] == 1


def test_the_reported_figures():
    f = review.figures([row(1, 1, 0.5), row(1, 2, -0.25), row(2, 1, -0.25), row(2, 2, 0.5)])
    assert f["win_rate"] == 0.5 and f["mean_rop"] == pytest.approx(0.125) and f["profit_factor"] == 2.0
    assert f["max_drawdown_usd"] == -50.0 and f["longest_losing_streak"] == 2          # +50, -25, -25, +50
    assert f["exits"] == {"premium": 2, "target": 2}
    assert f["mfe_captured"] == pytest.approx((2 * 0.5 / 0.7 + 2 * -0.25 / 0.2) / 4, abs=1e-3)   # losers gave it back


def test_the_day_line_counts_bars_setups_refusals_and_entries():
    dec = [{"root": "SPY", "action": "no-setup", "signals": []},
           {"root": "SPY", "action": "signal-refused",
            "signals": [{"gates": {"trend": {"ok": False}, "room": {"ok": True}}}]},
           {"root": "SPY", "action": "entered", "signals": [{"gates": {"trend": {"ok": True}}}]},
           {"root": "QQQ", "action": "warming-up"}]
    got = review.day_line(dec)
    assert got["SPY"] == {"bars": 3, "setups": 2, "entered": 1, "refused_by": {"trend": 1},
                          "refused_for": {"unlogged": 1}}                 # a row from before reasons were logged
    assert got["QQQ"]["bars"] == 1


def test_the_day_line_counts_refusals_by_their_first_reason():
    dec = [{"root": "SPY", "action": "signal-refused",
            "signals": [{"gates": {"trend": {"ok": False}, "contract": {"ok": False}}, "reason": "trend"},
                        {"gates": {"contract": {"ok": False}}, "reason": "delta-below-floor"}]},
           {"root": "SPY", "action": "entry-refused",
            "signals": [{"gates": {"trend": {"ok": True}}, "reason": "guard-max-entries"}]},
           {"root": "SPY", "action": "entered", "signals": [{"gates": {"trend": {"ok": True}}, "reason": None}]}]
    got = review.day_line(dec)["SPY"]
    assert got["refused_for"] == {"trend": 1, "delta-below-floor": 1, "guard-max-entries": 1}
    assert got["entered"] == 1 and got["refused_by"] == {"trend": 1, "contract": 2}


def test_the_verdict_is_written_once(tmp_path):
    v = script("options_clone_verdict")
    j = tmp_path / "j.jsonl"
    j.write_text("\n".join(json.dumps(r) for r in book(10, 1, [0.5])))
    out = tmp_path / "exp"
    assert v.main(["--journal", str(j), "--out", str(out), "--rules", "spread5"]) == 0 and not out.exists()    # no verdict yet
    j.write_text("\n".join(json.dumps(r) for r in book(25, 2, [0.5, -0.25, 0.5])))
    assert v.main(["--journal", str(j), "--out", str(out), "--rules", "spread5"]) == 0
    assert "passes" in (out / "report.md").read_text() and json.loads((out / "result.json").read_text())["retest"]
    assert v.main(["--journal", str(j), "--out", str(out), "--rules", "spread5"]) == 1                         # never written over


def test_the_nightly_review_reads_the_journal_and_the_decisions(tmp_path):
    r = script("options_clone_review")
    j = tmp_path / "j.jsonl"
    j.write_text("\n".join(json.dumps(x) for x in [row(2, 1, 0.5), {"event": "verify_flat", "flat": True,
                                                                         "ts": "2026-11-02T20:20:00+00:00"}]))
    (tmp_path / "decisions").mkdir()
    (tmp_path / "decisions" / "2026-11-02.jsonl").write_text(json.dumps({"root": "SPY", "action": "entered"}))
    doc = r.build("2026-11-02", j, tmp_path)
    assert doc["today"]["trades"] == 1 and doc["today"]["flat"] is True and doc["names"]["SPY"]["entered"] == 1
    assert doc["setups"]["retest"]["trades"] == 0                                # 2 November is under the $15 cap
    assert doc["cap15"]["retest"]["trades"] == 1 and doc["cap15"]["retest"]["verdict"] == "none"
    assert doc["spread5"]["all"]["trades"] == 0                                  # 2 November is before the $5 spread cap


def test_a_trade_on_a_later_expiry_counts_toward_hyp_0031_only():
    """DEC-0034: a contract expiring on its own session counts toward its setup's trial; one expiring later counts
    toward `nearest`, both setups pooled, and never toward HYP-0029 or HYP-0030."""
    assert review.trial_of("retest", "SPY261102C00580000", "2026-11-02") == "retest"
    assert review.trial_of("rejection", "AMZN261106P00220000", "2026-11-02") == "nearest"
    assert review.trial_of("retest", "", "2026-11-02") == "retest"                       # an old row with no symbol
    same = [dict(row(2, 1, 0.5), symbol="SPY261102C00580000")]
    later = [dict(row(2, 2, -0.25, "retest"), symbol="AMZN261106C00220000"),
             dict(row(3, 1, 0.5, "rejection"), symbol="META261106P00700000")]
    got = review.review(same + later, review.TRIALS)
    assert (got["retest"]["trades"], got["rejection"]["trades"], got["nearest"]["trades"], got["all"]["trades"]) == (1, 0, 2, 3)
    assert set(review.review(same + later)) == {"retest", "rejection", "all"}          # the site's rows are unchanged


def test_the_nearest_trial_has_its_own_report(tmp_path):
    v = script("options_clone_verdict")
    rows = book(25, 2, [0.5, -0.25, 0.5])
    for r in rows:
        r["symbol"] = f"AMZN26{r['trade_id'][5:7]}{int(r['trade_id'][8:10]) + 1:02d}C00220000"   # the next day's expiry
    j = tmp_path / "j.jsonl"
    j.write_text("\n".join(json.dumps(r) for r in rows))
    same_day = tmp_path / "EXP-0024-x"
    assert v.main(["--journal", str(j), "--out", str(same_day), "--rules", "spread5"]) == 0 and not same_day.exists()   # none are same-day
    out = tmp_path / "EXP-0026-options-clone-nearest-expiry"
    assert v.main(["--journal", str(j), "--out", str(out), "--trials", "nearest", "--rules", "spread5"]) == 0
    text = (out / "report.md").read_text()
    assert text.startswith("# EXP-0026: the options clone on the nearest expiry") and "DEC-0034" in text
    assert json.loads((out / "result.json").read_text())["nearest"]["trades"] == 42    # 5 to 25 November
    assert v.main(["--journal", str(j), "--out", str(tmp_path / "y"), "--trials", "weekly"]) == 2


def test_the_two_caps_are_counted_apart():
    """DEC-0039: sessions to 2026-10-29 are the $2.00 cap's (EXP-0024, EXP-0026); from 2026-10-30 the $15.00 cap's
    (EXP-0028). No trade counts in both, and the new verdict starts from zero."""
    old = [dict(row(d, 1, 0.5), trade_id=f"2026-10-{d:02d}-O-1") for d in (23, 29)]
    new = [row(2, 1, 0.5), row(3, 1, -0.25)]
    assert [r["trade_id"][:10] for r in review.in_window(old + new, "old")] == ["2026-10-23", "2026-10-29"]
    assert [r["trade_id"][:10] for r in review.in_window(old + new, "cap15")] == ["2026-11-02", "2026-11-03"]
    assert review.review(review.in_window(old + new, "cap15"))["all"]["trades"] == 2


def test_the_cap15_report_counts_only_from_its_start(tmp_path):
    v = script("options_clone_verdict")
    rows = [dict(r, trade_id="2026-09" + r["trade_id"][7:]) for r in book(25, 2, [0.5, -0.25, 0.5])]   # all in September
    j = tmp_path / "j.jsonl"
    j.write_text("\n".join(json.dumps(r) for r in rows))
    out = tmp_path / "EXP-0028-options-clone-cap-15"
    assert v.main(["--journal", str(j), "--out", str(out), "--rules", "cap15"]) == 0 and not out.exists()
    old = tmp_path / "EXP-0024-x"
    assert v.main(["--journal", str(j), "--out", str(old)]) == 0 and (old / "report.md").exists()   # the old window
    j.write_text("\n".join(json.dumps(r) for r in rows + book(25, 2, [0.5, -0.25, 0.5])))
    assert v.main(["--journal", str(j), "--out", str(out), "--rules", "cap15"]) == 0 and not out.exists()  # closed 4 Nov
    assert review.review(review.in_window(rows + book(25, 2, [0.5]), "cap15"))["all"]["trades"] == 8


def test_the_spread_cap_window_starts_on_5_november():
    """DEC-0040: the $15.00 cap's window closes on 2026-11-04; from 2026-11-05 trades count toward EXP-0029 only."""
    rows = [row(d, 1, 0.5) for d in (3, 4, 5, 6)]
    assert [r["trade_id"][:10] for r in review.in_window(rows, "cap15")] == ["2026-11-03", "2026-11-04"]
    assert [r["trade_id"][:10] for r in review.in_window(rows, "spread5")] == ["2026-11-05", "2026-11-06"]


def test_the_spread5_report_is_exp_0029(tmp_path):
    v = script("options_clone_verdict")
    j = tmp_path / "j.jsonl"
    j.write_text("\n".join(json.dumps(r) for r in book(25, 2, [0.5, -0.25, 0.5])))
    out = tmp_path / "EXP-0029-options-clone-spread-5"
    assert v.main(["--journal", str(j), "--out", str(out), "--rules", "cap15"]) == 0 and not out.exists()   # 8 trades
    assert v.main(["--journal", str(j), "--out", str(out), "--rules", "spread5"]) == 0
    text = (out / "report.md").read_text()
    assert text.startswith("# EXP-0029: the options clone under the $5.00 spread cap") and "DEC-0040" in text
    assert json.loads((out / "result.json").read_text())["all"]["trades"] == 42
