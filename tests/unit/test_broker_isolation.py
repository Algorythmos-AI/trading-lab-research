"""R6: only the runner (wt.live) and the cancel-only wrapper may import the full paper broker, and rollback gets a
handle that can't place or replace orders."""
import ast
from pathlib import Path

import pytest

from wt.brokers.cancel_only import CancelOnlyClient, connect
from wt.ops import deploy

ROOT = Path(__file__).resolve().parents[2]
PAPER_BROKER_OK = {"src/wt/live/runner_b.py", "src/wt/brokers/cancel_only.py", "src/wt/brokers/alpaca_paper.py"}
TRADING_SDK_OK = {"src/wt/brokers/alpaca_paper.py", "src/wt/brokers/alpaca_read.py"}   # alpaca_read: account reads
ORDER_CALLS = {"submit_order", "replace_order_by_id", "cancel_order_by_id", "cancel_orders", "close_position",
               "close_all_positions", "exercise_options_position"}
ORDER_CALLS_OK = {"src/wt/brokers/alpaca_paper.py"}


def _module_of(rel: str) -> str:
    parts = rel.removeprefix("src/").removesuffix(".py").split("/")
    return ".".join(parts[:-1] if parts[-1] == "__init__" else parts)


def _absolute(node: ast.ImportFrom, rel: str) -> str:
    """The absolute module an ImportFrom names, resolving `from .x import y` against the file's package."""
    if not node.level:
        return node.module or ""
    pkg = _module_of(rel).split(".")
    base = pkg[: len(pkg) - node.level + (1 if rel.endswith("__init__.py") else 0)]
    return ".".join([*base, node.module] if node.module else base)


def violations(rel: str, tree: ast.AST) -> list[str]:
    """Every way `rel` could get an order-capable broker handle it isn't allowed."""
    out = []
    for node in ast.walk(tree):
        names: list[str] = []
        if isinstance(node, ast.Import):
            names = [a.name for a in node.names]
        elif isinstance(node, ast.ImportFrom):
            mod = _absolute(node, rel)
            names = [mod] + [f"{mod}.{a.name}" for a in node.names]
        elif isinstance(node, ast.Call):
            fn = node.func
            called = fn.attr if isinstance(fn, ast.Attribute) else fn.id if isinstance(fn, ast.Name) else ""
            if called in ("import_module", "__import__") and node.args and isinstance(node.args[0], ast.Constant):
                names = [str(node.args[0].value)]
            if called in ORDER_CALLS and rel not in ORDER_CALLS_OK:
                out.append(f"{rel}: calls {called}()")
        elif isinstance(node, ast.Attribute) and node.attr == "_CancelOnlyClient__b":
            out.append(f"{rel}: reaches inside CancelOnlyClient")
        for n in names:
            if (n == "wt.brokers.alpaca_paper" or n.startswith("wt.brokers.alpaca_paper.")) and rel not in PAPER_BROKER_OK:
                out.append(f"{rel}: imports the paper broker ({n})")
            if (n == "alpaca.trading" or n.startswith("alpaca.trading.")) and rel not in TRADING_SDK_OK:
                out.append(f"{rel}: imports the Alpaca trading SDK ({n})")
    return out


def test_no_order_capable_handle_outside_the_runner_and_the_adapters():
    found = []
    for base in ("src", "scripts"):
        for f in sorted((ROOT / base).rglob("*.py")):
            rel = f.relative_to(ROOT).as_posix()
            found += violations(rel, ast.parse(f.read_text(), rel))
    assert found == []


@pytest.mark.parametrize("src", [
    "from wt.brokers.alpaca_paper import AlpacaPaperBroker",
    "import wt.brokers.alpaca_paper",
    "from wt.brokers import alpaca_paper",
    "from . import alpaca_paper",
    "from .alpaca_paper import AlpacaPaperBroker",
    "import importlib; importlib.import_module('wt.brokers.alpaca_paper')",
    "__import__('wt.brokers.alpaca_paper')",
    "from alpaca.trading.client import TradingClient",
    "import alpaca.trading.client",
    "reader._c.submit_order(req)",
    "client._CancelOnlyClient__b.place(o)",
])
def test_the_scan_catches_each_way_around_it(src):
    assert violations("src/wt/brokers/sneaky.py", ast.parse(src))


def test_the_allowed_files_pass():
    assert violations("src/wt/live/runner_b.py", ast.parse("from wt.brokers.alpaca_paper import AlpacaPaperBroker")) == []
    assert violations("src/wt/brokers/alpaca_read.py", ast.parse("from alpaca.trading.client import TradingClient")) == []


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
    # Name mangling hides the slot from code that means well; the scan above flags any use of the mangled name.
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
