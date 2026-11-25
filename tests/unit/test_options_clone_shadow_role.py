"""The options clone on a shadow host (WT_ROLE=shadow) sends nothing, as Gap Hunter does (audit 2026-11-25): its broker
is wrapped in ShadowBroker and its session is exits-only. On any other role nothing changes."""
import datetime as dt

import pytest

from wt.brokers.shadow import ShadowBroker, ShadowRole
from wt.core.types import Order
from wt.live import runner_o


class OptionsAdapter:
    """What the options adapter offers beyond the base Broker: the reads the session uses by getattr/hasattr."""
    own_account = True

    def __init__(self, *a):
        self.placed = []

    def options_level(self):
        return 3

    def marks(self):
        return {"SPY261127C00600000": 1.25}

    def positions(self):
        return []

    def open_orders(self):
        return []

    def place(self, order):
        self.placed.append(order)
        return order


class Stop(Exception):
    pass


@pytest.fixture
def started(monkeypatch, tmp_path):
    """Run runner_o.run() up to the Runner's construction and keep what it was given."""
    import wt.brokers.alpaca_options_paper as aop
    seen: dict = {}
    events: list = []
    monkeypatch.setenv("MODE", "paper")
    monkeypatch.setattr("wt.ops.locks.LOCK_DIR", tmp_path / "locks")          # never the checkout's var/locks
    monkeypatch.setattr(runner_o.lv, "is_session", lambda d: True)
    monkeypatch.setattr(aop, "keys", lambda: ("k", "s", True))
    monkeypatch.setattr(aop, "AlpacaOptionsPaperBroker", OptionsAdapter)
    monkeypatch.setattr(runner_o, "ARM_AT", dt.time(0, 0))
    monkeypatch.setattr(runner_o, "write", lambda event, **kw: events.append((event, kw)) or True)
    monkeypatch.setattr(runner_o, "load_events", lambda: ([], []))
    monkeypatch.setattr(runner_o, "AlpacaFeeds", lambda *a, **k: None)
    monkeypatch.setattr(runner_o.clone_site, "publisher_from_env", lambda: None)

    def runner(day, cfg, lim, feeds, broker, *a, **kw):
        seen.update(broker=broker, exits_only=kw.get("exits_only"))
        raise Stop
    monkeypatch.setattr(runner_o, "Runner", runner)

    def go():
        with pytest.raises(Stop):
            runner_o.run(dt.date(2026, 11, 25))
        return seen, events
    return go


def test_a_shadow_host_wraps_the_clones_broker_and_turns_entries_off(started, monkeypatch):
    monkeypatch.setenv("WT_ROLE", "shadow")
    seen, events = started()
    b = seen["broker"]
    assert isinstance(b, ShadowBroker)
    assert seen["exits_only"] == "shadow host: this session never places orders"
    assert ("shadow_role", {"wrapped": "ShadowBroker"}) in events
    with pytest.raises(ShadowRole):
        b.place(Order("wt-O-20261125-aaaaaaaaaaaa", "SPY261127C00600000", "buy", 1, "limit", limit_price=1.0))
    with pytest.raises(ShadowRole):
        b.cancel("x")
    # the reads the session takes by getattr/hasattr still reach the adapter, so a shadow run checks what a primary does
    assert b.options_level() == 3 and b.own_account is True and b.marks() == {"SPY261127C00600000": 1.25}


@pytest.mark.parametrize("role", [None, "primary"])
def test_a_primary_host_is_unchanged(started, monkeypatch, role):
    if role is None:
        monkeypatch.delenv("WT_ROLE", raising=False)
    else:
        monkeypatch.setenv("WT_ROLE", role)
    monkeypatch.delenv("WT_EXITS_ONLY", raising=False)
    seen, events = started()
    assert isinstance(seen["broker"], OptionsAdapter) and seen["exits_only"] is None
    assert not any(e == "shadow_role" for e, _ in events)


def test_an_exits_only_launch_keeps_its_reason_on_a_primary_host(started, monkeypatch):
    monkeypatch.setenv("WT_EXITS_ONLY", "1")
    monkeypatch.delenv("WT_ROLE", raising=False)
    seen, _ = started()
    assert seen["exits_only"] == "exits-only launch"


def test_the_shadow_broker_passes_only_named_reads():
    b = ShadowBroker(OptionsAdapter())
    assert not hasattr(b, "placed")                   # not a listed read: the inner adapter's state stays hidden
    assert not hasattr(ShadowBroker(object()), "marks")   # an adapter without marks: hasattr stays False
    assert {"place", "cancel", "replace_stop"}.isdisjoint(ShadowBroker.READS)


@pytest.mark.parametrize("role", ["shdow", "Shadow", "", "secondary"])
def test_an_unknown_role_refuses_before_any_broker_is_built(monkeypatch, role):
    """Fail closed: a mistyped shadow role must not run as a primary host would."""
    import wt.brokers.alpaca_options_paper as aop
    monkeypatch.setenv("MODE", "paper")
    monkeypatch.setenv("WT_ROLE", role)
    monkeypatch.setattr(aop, "AlpacaOptionsPaperBroker", lambda *a: pytest.fail("no broker for an unknown role"))
    with pytest.raises(SystemExit, match="WT_ROLE must be one of primary, shadow"):
        runner_o.run(dt.date(2026, 11, 25))
