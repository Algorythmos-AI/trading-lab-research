"""The options lab is walled off from trading (DEC-0060 section 2.6): wt.lab never reaches the order path, the account
readers, the options selection or the EXP-0037 replay, directly or through anything it imports from this repo; and
nothing outside wt.lab, its tests and its scripts imports wt.lab."""
from __future__ import annotations

import ast
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "src"
LAB = SRC / "wt" / "lab"
FORBIDDEN = ("wt.live", "wt.oms", "wt.brokers", "wt.owner", "wt.webull", "wt.options.select", "wt.options.variants",
             "wt.options.exp0037")


def module_file(name: str) -> Path | None:
    base = SRC.joinpath(*name.split("."))
    for p in (base.with_suffix(".py"), base / "__init__.py"):
        if p.exists():
            return p
    return None


def imports(path: Path) -> set[str]:
    """Every wt module `path` imports, absolute or relative, including `from X import Y` where Y is a module."""
    tree = ast.parse(path.read_text())
    pkg = ".".join(path.relative_to(SRC).with_suffix("").parts)
    if path.name == "__init__.py":
        pkg = pkg.rsplit(".", 1)[0] if pkg.endswith(".__init__") else pkg
    out: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            out |= {a.name for a in node.names}
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                base = pkg.split(".")[: -node.level] if path.name != "__init__.py" else pkg.split(".")[: len(pkg.split(".")) - node.level + 1]
                mod = ".".join(base + ([node.module] if node.module else []))
            else:
                mod = node.module or ""
            out.add(mod)
            out |= {f"{mod}.{a.name}" for a in node.names}
    return {m for m in out if m == "wt" or m.startswith("wt.")}


def closure(start: list[Path]) -> set[str]:
    seen: set[str] = set()
    todo = list(start)
    done: set[Path] = set()
    while todo:
        p = todo.pop()
        if p in done:
            continue
        done.add(p)
        for m in imports(p):
            if module_file(m) is None:
                continue
            seen.add(m)
            todo.append(module_file(m))       # type: ignore[arg-type]
    return seen


def test_the_lab_never_reaches_trading_code() -> None:
    files = sorted(LAB.rglob("*.py"))
    assert files, "no lab module found"
    reached = closure(files)
    bad = sorted(m for m in reached if any(m.startswith(f) for f in FORBIDDEN))
    assert not bad, f"the lab reaches {bad}"
    for p in files:                                    # imports the walk cannot see
        text = p.read_text()
        assert "import_module" not in text and "__import__" not in text, p


def test_nothing_outside_the_lab_imports_it() -> None:
    users = []
    for p in sorted((ROOT / "src").rglob("*.py")):
        if LAB in p.parents:
            continue
        if any(m == "wt.lab" or m.startswith("wt.lab.") for m in imports(p)):
            users.append(str(p.relative_to(ROOT)))
    assert not users, f"imported outside the lab: {users}"


def test_the_closure_walk_sees_through_an_intermediate_module() -> None:
    """The walk is transitive: the clone's focus reader imports the order path two hops away, and the walk sees it."""
    reached = closure([SRC / "wt" / "options" / "clone_site.py"])
    assert "wt.oms.options" in reached
    assert any(m.startswith("wt.brokers") for m in reached)            # through wt.ops.publish, not imported directly
    assert "wt.options.chain" in closure([LAB / "tiers.py"])
