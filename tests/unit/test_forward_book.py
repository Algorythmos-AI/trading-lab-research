"""Books per registered trial (wt.analytics.forward_book, DEC-0023): a view of the forward ledger and nothing more."""
import copy

from wt.analytics import forward_book as fb


def marker(session, name, n, hyp=None):
    rec = {"session": session, "strategy": name, "strategy_marker": True, "n_trades": n}
    return {**rec, "hyp": hyp, "equity": 600.0} if hyp else rec


def trade(session, name, r, entry="2026-10-05T14:01:00+00:00"):
    return {"session": session, "strategy": name, "symbol": "ZZZA", "entry_time": entry, "R": r}


LEDGER = [
    {"session": "2026-10-05", "session_started": True},
    trade("2026-10-05", "r3:F:GG-1", 1.5), trade("2026-10-05", "r3:F:GG-1", -1.0, entry="2026-10-05T15:00:00+00:00"),
    marker("2026-10-05", "r3:F:GG-1", 2, "HYP-0010"), marker("2026-10-05", "r3:MP-1", 0, "HYP-0018"),
    marker("2026-10-05", "B_qqq_qqqm", 0),
    trade("2026-10-05", "watchlist_bull_flag_atr_M1", 9.0), marker("2026-10-05", "watchlist_bull_flag_atr_M1", 1),
    {"session": "2026-10-05", "session_marker": True, "n_trades": 3},
    {"session": "2026-10-06", "strategy": "r3:F:GG-1,r3:F:GG-2", "error": "ScanFailed('...')"},
    trade("2026-10-06", "r3:F:GG-1", -1.0), trade("2026-10-06", "r3:F:GG-1", -0.5, entry="2026-10-06T15:00:00+00:00"),
    marker("2026-10-06", "r3:F:GG-1", 2, "HYP-0010"), marker("2026-10-06", "r3:MP-1", 0, "HYP-0018"),
    trade("2026-10-06", "B_qqq_qqqm", 0.4), marker("2026-10-06", "B_qqq_qqqm", 1),
    trade("2026-10-07", "r3:F:GG-1", 2.0), marker("2026-10-07", "r3:F:GG-1", 1, "HYP-0010"),
]
FUNNELS = [
    {"session": "2026-10-05", "parts": {"set_F": {"trials": {"GG-1": {"candidates": 3, "admitted": 2, "admission_skips": {"unfunded": 1}}}},
                                        "MP-1": {"candidates": 0, "admitted": 0, "admission_skips": {}}}},
    {"session": "2026-10-06", "parts": {"set_F": {"trials": {"GG-1": {"candidates": 2, "admitted": 2, "admission_skips": {}}}}}},
]


def test_a_book_is_the_ledger_read_by_trial():
    by = {b.strategy: b for b in fb.books(LEDGER, FUNNELS)}
    g = by["r3:F:GG-1"]
    assert (g.hyp, g.sessions, g.first, g.last, g.trades, g.last_trade) == ("HYP-0010", 3, "2026-10-05", "2026-10-07", 5, "2026-10-07")
    assert g.total_r == 1.0 and g.max_dd_r == 2.5                      # +1.5, -1.0, -1.0, -0.5, +2.0: high 1.5, low -1.0
    assert g.risk_usd == 6.0 and g.nominal_usd == 6.0                  # 1% of the US$600 the markers state: no compounding
    assert g.errors == 1 and (g.signals, g.refused) == (5, 1)


def test_a_trial_with_sessions_and_no_trade_is_listed_with_zeros():
    m = next(b for b in fb.books(LEDGER, FUNNELS) if b.strategy == "r3:MP-1")
    assert (m.sessions, m.trades, m.total_r, m.max_dd_r, m.nominal_usd, m.last_trade) == (2, 0, 0.0, 0.0, 0.0, None)
    assert (m.signals, m.refused) == (0, 0)


def test_the_legacy_strategies_get_no_book_and_are_never_pooled():
    names = [b.strategy for b in fb.books(LEDGER, FUNNELS)]
    assert names == ["r3:F:GG-1", "r3:MP-1", "B_qqq_qqqm"]             # by hypothesis id, then B
    assert sum(b.total_r for b in fb.books(LEDGER)) == 1.4              # the legacy +9.0 is in no total
    b = fb.books(LEDGER, FUNNELS)[-1]
    assert (b.hyp, b.sessions, b.trades, b.total_r, b.nominal_usd, b.signals) == (None, 2, 1, 0.4, None, None)


def test_without_funnel_records_the_counts_are_unknown_not_zero():
    assert all(b.signals is None and b.refused is None for b in fb.books(LEDGER))


def test_the_view_changes_nothing_it_reads_and_is_plain_data():
    ledger, funnels = copy.deepcopy(LEDGER), copy.deepcopy(FUNNELS)
    out = fb.view(ledger, funnels)
    assert ledger == LEDGER and funnels == FUNNELS
    assert fb.view(reversed(LEDGER), FUNNELS)[0]["trades"] == 5 and out == fb.view(LEDGER, FUNNELS)
    assert set(out[0]) == {"strategy", "hyp", "sessions", "errors", "first", "last", "trades", "total_r", "max_dd_r",
                           "last_trade", "risk_usd", "nominal_usd", "signals", "refused", "shadow_resolved"}
    assert not any(k in out[0] for k in ("setup", "symbol", "entry"))


def test_the_sealed_outcomes_are_counted_and_never_read():
    shadow = [{**FUNNELS[0], "shadow": {"set_F": {"r3:F:GG-1": {"refused": 1, "resolved": 1}, "git_sha": "abc"},
                                        "MP-1": {"r3:MP-1": {"refused": 2, "resolved": 0}, "git_sha": "abc"}}},
              {**FUNNELS[1], "shadow": {"set_F": {"r3:F:GG-1": {"refused": 3, "resolved": 2}}}}]
    by = {b.strategy: b for b in fb.books(LEDGER, shadow)}
    assert by["r3:F:GG-1"].shadow_resolved == 3 and by["r3:MP-1"].shadow_resolved == 0
    assert by["B_qqq_qqqm"].shadow_resolved is None                     # B has no admission step and no shadow
    assert all(b.shadow_resolved is None for b in fb.books(LEDGER, FUNNELS))      # records from before the counts
    assert by["r3:F:GG-1"].total_r == 1.0 and by["r3:F:GG-1"].refused == 1        # nothing else moves


def test_drawdown_is_the_deepest_fall_from_a_high():
    assert fb.drawdown([]) == 0 and fb.drawdown([1, 1, 1]) == 0 and fb.drawdown([-1, -1]) == 2
    assert fb.drawdown([2, -1, 3, -4, 1]) == 4


# ---- from the ledger on disk to the published snapshot ----------------------------------------------------------

def test_the_collector_reads_the_books_from_the_ledger_and_the_funnel_records(tmp_path):
    import json

    from wt.ops import status
    fwd = tmp_path / "var" / "forward"
    (fwd / "funnel").mkdir(parents=True)
    (fwd / "forward_trades.jsonl").write_text("".join(json.dumps(r) + "\n" for r in LEDGER))
    for f in FUNNELS:
        (fwd / "funnel" / f"{f['session']}.json").write_text(json.dumps(f))
    (fwd / "funnel" / "2026-10-07.json").write_text("{ torn")             # an unreadable record costs only its counts
    import datetime as dt
    ctx = status.Ctx(cfg={}, root=tmp_path, deployed=tmp_path, org=tmp_path, old=tmp_path, out=tmp_path,
                     now=dt.datetime(2026, 10, 8, tzinfo=dt.UTC))
    out = status.src_forward(ctx)
    assert [b["strategy"] for b in out["books"]] == ["r3:F:GG-1", "r3:MP-1", "B_qqq_qqqm"]
    assert out["books"][0]["signals"] == 5 and out["books"][0]["total_r"] == 1.0


def test_the_snapshot_carries_a_book_and_drops_anything_else_put_in_one():
    from test_publish import NOW, sanitizer

    from wt.ops.publish import build, validate
    row = {**fb.view(LEDGER, FUNNELS)[0], "setup": "a setup name", "symbol": "ZZZA", "headlines": ["news"]}
    snap = build({"meta": {}, "ops": {"forward": {"exists": True, "sessions": 3, "books": [row]}}}, {}, sanitizer(), "run-1", NOW)
    assert validate(snap) == []
    book = snap["ops"]["forward"]["books"][0]
    assert book == fb.view(LEDGER, FUNNELS)[0]                           # every field of the view, and only those
    assert not {"setup", "symbol", "headlines"} & set(book)
