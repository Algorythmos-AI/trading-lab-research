"""R6: only the runner (wt.live) and the cancel-only wrapper may import the full paper broker, and rollback gets a
handle that can't place or replace orders."""
import ast
from pathlib import Path

import pytest

from wt.brokers.cancel_only import CancelOnlyClient, connect
from wt.ops import deploy

ROOT = Path(__file__).resolve().parents[2]
ALLOWED = {"src/wt/live/runner_b.py", "src/wt/brokers/cancel_only.py", "src/wt/brokers/alpaca_paper.py"}


def _imports_paper_broker(tree: ast.AST) -> bool:
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module == "wt.brokers.alpaca_paper":
            return True
        if isinstance(node, ast.Import) and any(a.name == "wt.brokers.alpaca_paper" for a in node.names):
            return True
        if isinstance(node, ast.ImportFrom) and node.module == "wt.brokers" and \
                any(a.name == "alpaca_paper" for a in node.names):
            return True
    return False


def test_only_the_runner_and_the_wrapper_import_the_paper_broker():
    offenders = []
    for base in ("src", "scripts"):
        for f in sorted((ROOT / base).rglob("*.py")):
            rel = f.relative_to(ROOT).as_posix()
            if rel not in ALLOWED and _imports_paper_broker(ast.parse(f.read_text(), rel)):
                offenders.append(rel)
    assert offenders == []


class FullBroker:
    def __init__(self):
        self.cancelled, self.placed = [], []

    def positions(self):
        return []

    def open_orders(self):
        return []

    def cancel(self, cid):
        self.cancelled.append(cid)

    def place(self, order):          # pragma: no cover - must never be reachable through the wrapper
        self.placed.append(order)

    def replace_stop(self, cid, stop):  # pragma: no cover
        raise AssertionError


def test_the_wrapper_exposes_look_and_cancel_only():
    b = FullBroker()
    c = connect(lambda: b)
    c.cancel("wt-1")
    assert b.cancelled == ["wt-1"]
    for name in ("place", "replace_stop", "get_order", "account", "_b", "b"):
        assert not hasattr(c, name), name
    with pytest.raises(AttributeError):
        c.extra = 1                   # __slots__: nothing can be attached either
    assert {n for n in dir(CancelOnlyClient) if not n.startswith("_")} == {"positions", "open_orders", "cancel"}


def test_rollback_cleanup_goes_through_the_wrapper(monkeypatch):
    seen = []
    import wt.brokers.cancel_only as co
    orig = co.connect

    def spy(factory=None):
        c = orig(factory)
        seen.append(type(c))
        return c

    monkeypatch.setattr(co, "connect", spy)
    assert deploy.broker_cleanup_before_rollback(lambda: FullBroker()) is None
    assert seen == [CancelOnlyClient]
