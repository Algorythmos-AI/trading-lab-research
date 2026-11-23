"""wt.risk.cost_haircut (DEC-0074): Gap Hunter's paper R beside its H1 and H2 cost haircut. Constructed journal rows
only; the scorecard's lines are checked here too."""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

from wt.live import setups_live
from wt.risk import cost_haircut as ch

ROOT = Path(__file__).resolve().parents[2]
SYM = "ZQXW"


def filled(tid: str, nbbo: object = (3.99, 4.01)) -> dict:
    return {"event": "entry_filled", "trade_id": tid, "symbol": SYM, "qty": 100, "price": 4.0,
            "nbbo": list(nbbo) if isinstance(nbbo, tuple) else nbbo}


def closed(tid: str, day: str = "2026-11-24", entry: float = 4.0, stop: float = 3.88, qty: int = 100,
           r: float | None = -1.0, **kw: object) -> dict:
    return {"event": "trade_closed", "trial": "HYP-0071", "origin": "entry", "symbol": SYM, "trade_id": tid,
            "day": day, "entry": entry, "stop": stop, "qty": qty, "R": r, "exit_price_estimated": False, **kw}


def one(rows: list[dict]) -> ch.Haircut:
    hs, _ = ch.haircuts(rows)
    assert len(hs) == 1
    return hs[0]


def test_the_trial_is_gap_hunters():
    assert ch.TRIAL == setups_live.GAP_TRIAL


def test_the_records_worked_example_a_full_stop_out():
    tid = f"2026-11-24-S-{SYM}-0"
    h = one([filled(tid), closed(tid, stop_fill=3.88, stop_price=3.88, partial_qty=0)])
    assert h.c == pytest.approx(0.01)
    assert h.h1_usd == pytest.approx(3.0)                       # 0.01 bought + 0.02 sold by the stop, x 100
    assert h.r - h.h1_r == pytest.approx(0.25)
    assert h.r - h.h2_r == pytest.approx(0.50)
    assert h.h2_usd == pytest.approx(6.0)


def test_a_partial_at_the_target_then_the_rest_stopped():
    tid = "t-partial"
    h = one([filled(tid), closed(tid, r=0.2, stop_fill=3.88, partial_qty=40)])
    # 100 bought at c, 40 sold by the limit at c, 60 sold by the stop at 2c
    assert h.h1_usd == pytest.approx(0.01 * 100 + 0.01 * 40 + 0.02 * 60)
    assert h.h1_r == pytest.approx(0.2 - 2.6 / 12)


def test_a_trade_with_no_stop_fill_sells_every_share_at_c():
    tid = "t-target"
    h = one([filled(tid, (3.98, 4.04)), closed(tid, r=1.5, partial_qty=50)])
    assert h.c == pytest.approx(0.03)
    assert h.h1_usd == pytest.approx(0.03 * 200)
    assert h.h1_r == pytest.approx(1.5 - 6.0 / 12)


def test_a_missing_nbbo_charges_the_unknown_unit():
    for rows in ([closed("a")], [filled("a", None), closed("a")], [filled("a", [4.0]), closed("a")],
                 [filled("a", (0.0, 4.01)), closed("a")]):
        h = one(rows)
        assert h.c == ch.UNKNOWN_UNIT_USD and not h.nbbo_known
        assert h.h1_usd == pytest.approx(0.025 * 200)


def test_a_crossed_nbbo_charges_the_unknown_unit_and_a_locked_one_the_floor():
    assert one([filled("a", (4.02, 4.00)), closed("a")]).c == ch.UNKNOWN_UNIT_USD
    assert one([filled("a", (4.00, 4.00)), closed("a")]).c == pytest.approx(ch.MIN_UNIT_USD)


def test_the_first_entry_fill_row_gives_the_nbbo():
    h = one([filled("a", (3.99, 4.01)), filled("a", (3.90, 4.10)), closed("a")])
    assert h.c == pytest.approx(0.01)


def test_r_none_or_an_estimated_exit_counts_from_minus_one():
    hs, _ = ch.haircuts([filled("a"), closed("a", r=None),
                         filled("b"), closed("b", r=0.8, exit_price_estimated=True)])
    assert [h.r for h in hs] == [-1.0, -1.0]
    assert hs[0].h1_r == pytest.approx(-1.0 - 2.0 / 12)


def test_rows_of_other_trials_or_origins_are_ignored_and_a_repeat_counts_once():
    rows = [filled("a"), closed("a", trial="HYP-0070"), closed("b", origin="orphan"), closed("c", trial=None),
            {**closed("d"), "event": "trade_opened"}, closed("e"), closed("e", r=3.0)]
    hs, skipped = ch.haircuts(rows)
    assert [h.trade_id for h in hs] == ["e"] and hs[0].r == -1.0
    assert sum(skipped.values()) == 0


def test_no_positive_risk_is_skipped_and_counted():
    hs, skipped = ch.haircuts([closed("a", entry=3.88, r=None), closed("b", entry=3.80, r=None),
                               closed("c", entry=0.0, r=None), closed("d", qty=0), closed("e")])
    assert [h.trade_id for h in hs] == ["e"]
    assert skipped == {"no_risk": 4}


def test_means_carry_a_session_resampled_interval_from_two_sessions():
    rows = [closed("a", r=1.0), closed("b", r=-1.0)]
    s = ch.summary(rows)
    assert s.n == 2 and s.sessions == 1 and s.paper.mean == pytest.approx(0.0) and s.paper.ci95 is None
    rows += [closed("c", day="2026-11-25", r=2.0)]
    s = ch.summary(rows)
    assert s.sessions == 2 and s.paper.ci95 is not None and s.h1.ci95 is not None and s.h2.ci95 is not None
    assert s.h2.mean < s.h1.mean < s.paper.mean
    assert s.realised_usd == pytest.approx((1.0 - 1.0 + 2.0) * 12)
    assert s.h2_usd == pytest.approx(2 * s.h1_usd)


def test_the_scorecard_lines_carry_counts_and_r_only(tmp_path, monkeypatch):
    spec = importlib.util.spec_from_file_location("sc_haircut", ROOT / "scripts/weekly_scorecard.py")
    sc = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(sc)
    journal = tmp_path / "smallcap_journal.jsonl"
    monkeypatch.setattr(sc, "JOURNAL_S", journal)
    assert sc.s_haircut_lines() == [
        "- Gap Hunter (HYP-0071) paper R and its cost haircut (DEC-0074, reported, gating nothing): no closed trade yet"]
    t1, t2, t3 = (f"2026-11-2{d}-S-{SYM}-0" for d in (4, 5, 6))
    rows = [filled(t1), closed(t1, day="2026-11-24", stop_fill=3.88, partial_qty=0),
            filled(t2), closed(t2, day="2026-11-25", r=1.5, partial_qty=50),
            closed(t3, day="2026-11-26", r=None, entry=3.88, setup="gap_and_go")]
    journal.write_text("".join(json.dumps(r) + "\n" for r in rows))
    out = sc.s_haircut_lines()
    text = "\n".join(out)
    assert SYM not in text and "gap_and_go" not in text and t1 not in text
    assert out[0].startswith("- Gap Hunter (HYP-0071) paper R and its cost haircut (DEC-0074, reported, gating "
                             "nothing): trades closed **2** on 2 session(s) · mean paper R +0.25R [")
    assert "H1 R +0.04R [" in out[0] and "H2 R -0.17R [" in out[0]
    assert out[1] == ("- Haircut total: H1 US$5.00 · H2 US$10.00, against realised paper US$+6.00 · entry NBBO "
                      "unknown (c = US$0.025): 0 · left out, no positive risk to charge in R: 1")


def test_a_broken_journal_costs_only_the_haircut_lines(monkeypatch):
    spec = importlib.util.spec_from_file_location("sc_haircut2", ROOT / "scripts/weekly_scorecard.py")
    sc = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(sc)

    def broken(_):
        raise RuntimeError("boom")
    monkeypatch.setattr(sc.cost_haircut, "summary", broken)
    assert sc.s_haircut_lines() == ["- Gap Hunter's cost haircut: not available this week (RuntimeError)."]
