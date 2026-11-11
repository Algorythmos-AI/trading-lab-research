"""Every alert the code can send, found in the code itself (tests/unit/test_alert_allowlist.py).

A *sink* is a call `x.fire(key, title, message, ...)`, `x.once_per_day(...)`, `x.resolve(...)` or
`x.notify(title, message, ...)` anywhere under src/ or scripts/ (wt.ops.alerts itself excepted: it is the sender).
When a sink's title and message come only from its function's own parameters, that function is a *wrapper*
(runner_o's `page`, jobs' `refuse`, the scripts' `page`) and each call of it is followed instead, as far as it goes.
Each place where the text is finally made is one *site*; its id is `file::function::first two arguments`.
"""
from __future__ import annotations

import ast
import builtins
import importlib
import importlib.util
import sys
from dataclasses import dataclass, field
from pathlib import Path
from types import ModuleType
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
SENDER = ROOT / "src" / "wt" / "ops" / "alerts.py"
SINKS = {"fire": (1, 2), "once_per_day": (1, 2), "resolve": (1, 2), "notify": (0, 1)}
# Functions whose sinks use their parameters but are not pass-through wrappers: the text is judged where it is made,
# with hostile values for those parameters, instead of at every caller.
NOT_WRAPPERS = frozenset({"src/wt/ops/jobs.py::run_job", "src/wt/live/runner_b.py::_session.adopt_orphan",
                          "src/wt/ops/evidence.py::run", "src/wt/ops/visibility.py::page"})
Func = ast.FunctionDef | ast.AsyncFunctionDef


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return path.name                 # a file outside the repository (a test's probe)


def source_files() -> list[Path]:
    return sorted(p for p in [*(ROOT / "src").rglob("*.py"), *(ROOT / "scripts").glob("*.py")] if p != SENDER)


def _names(*nodes: ast.AST) -> set[str]:
    return {n.id for node in nodes for n in ast.walk(node) if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load)}


def _params(f: Func) -> list[str]:
    a = f.args
    return [x.arg for x in (*a.posonlyargs, *a.args, *a.kwonlyargs)]


def _module_names(tree: ast.Module) -> set[str]:
    out: set[str] = set()
    for node in tree.body:
        if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef):
            out.add(node.name)
        elif isinstance(node, ast.Import | ast.ImportFrom):
            out |= {(a.asname or a.name).split(".")[0] for a in node.names}
        elif isinstance(node, ast.Assign | ast.AnnAssign | ast.AugAssign):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            out |= {n.id for t in targets for n in ast.walk(t) if isinstance(n, ast.Name)}
        elif isinstance(node, ast.If | ast.Try):            # guarded imports and constants
            out |= _module_names(ast.Module(body=[*getattr(node, "body", []), *getattr(node, "orelse", []),
                                                  *[s for h in getattr(node, "handlers", []) for s in h.body]],
                                            type_ignores=[]))
    return out


@dataclass
class Level:
    call: ast.Call
    func: Func | None            # the function the call is in (None: module level)
    title: ast.expr
    message: ast.expr


@dataclass
class Site:
    file: Path
    qualname: str
    chain: list[Level]           # chain[0]: where the text is made; chain[-1]: the sink
    wrappers: list[Func] = field(default_factory=list)   # the wrapper each level after the first calls into
    id: str = ""

    @property
    def rel(self) -> str:
        return rel(self.file)


class _Index(ast.NodeVisitor):
    def __init__(self) -> None:
        self.stack: list[ast.AST] = []
        self.calls: list[tuple[ast.Call, Func | None, str]] = []
        self.funcs: dict[str, list[tuple[Func, str]]] = {}

    def _qual(self) -> str:
        return ".".join(getattr(n, "name", "?") for n in self.stack) or "<module>"

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        self._func(node)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        self._func(node)

    def _func(self, node: Func) -> None:
        self.stack.append(node)
        self.funcs.setdefault(node.name, []).append((node, self._qual()))
        self.generic_visit(node)
        self.stack.pop()

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        self.stack.append(node)
        self.generic_visit(node)
        self.stack.pop()

    def visit_Call(self, node: ast.Call) -> None:
        f = next((n for n in reversed(self.stack) if isinstance(n, ast.FunctionDef | ast.AsyncFunctionDef)), None)
        self.calls.append((node, f, self._qual()))
        self.generic_visit(node)


def _arg_for(call: ast.Call, wrapper: Func, param: str, method: bool) -> ast.expr | None:
    """The expression a call passes for one of the wrapper's parameters (None: its default)."""
    for kw in call.keywords:
        if kw.arg == param:
            return kw.value
    params = [x.arg for x in (*wrapper.args.posonlyargs, *wrapper.args.args)]
    if method and params and params[0] in ("self", "cls"):
        params = params[1:]
    if param in params and params.index(param) < len(call.args):
        return call.args[params.index(param)]
    return None


def _calls_of(idx: _Index, wrapper: Func) -> list[tuple[ast.Call, Func | None, str, bool]]:
    out = []
    for call, f, q in idx.calls:
        fn = call.func
        if isinstance(fn, ast.Name) and fn.id == wrapper.name:
            out.append((call, f, q, False))
        elif isinstance(fn, ast.Attribute) and fn.attr == wrapper.name and isinstance(fn.value, ast.Name) \
                and fn.value.id == "self":
            out.append((call, f, q, True))
    return out


def sites(files: list[Path] | None = None) -> list[Site]:
    found: list[Site] = []
    for path in source_files() if files is None else files:
        tree = ast.parse(path.read_text())
        idx = _Index()
        idx.visit(tree)
        globals_ = _module_names(tree) | set(dir(builtins))
        todo: list[Site] = []
        for call, f, q in idx.calls:
            fn = call.func
            if not (isinstance(fn, ast.Attribute) and fn.attr in SINKS):
                continue
            ti, mi = SINKS[fn.attr]
            if len(call.args) <= mi:
                continue
            todo.append(Site(path, q, [Level(call, f, call.args[ti], call.args[mi])]))
        while todo:
            site = todo.pop()
            top = site.chain[0]
            locals_ = _names(top.title, top.message) - globals_
            f = top.func
            qual = next((q for fn, q in idx.funcs.get(f.name, []) if fn is f), "") if f is not None else ""
            follow = f"{rel(path)}::{qual}" not in NOT_WRAPPERS
            if f is not None and follow and locals_ and locals_ <= set(_params(f)) and _calls_of(idx, f):
                for call, g, q, method in _calls_of(idx, f):
                    t = _arg_for(call, f, "title", method) if "title" in locals_ else None
                    # The next level's text is what the caller passes for the parameters the text uses.
                    used = [p for p in _params(f) if p in locals_]
                    exprs = [e for p in used if (e := _arg_for(call, f, p, method)) is not None]
                    title = t if t is not None else (exprs[0] if exprs else ast.Constant(""))
                    message = ast.Tuple(elts=exprs, ctx=ast.Load()) if exprs else ast.Constant("")
                    todo.append(Site(path, q, [Level(call, g, title, message), *site.chain], [f, *site.wrappers]))
                continue
            found.append(site)
    seen: dict[str, int] = {}
    for s in sorted(found, key=lambda s: (s.rel, s.chain[0].call.lineno)):
        call = s.chain[0].call
        head = " | ".join(ast.unparse(a)[:50] for a in call.args[:2])
        base = f"{s.rel}::{s.qualname}::{head}"
        seen[base] = seen.get(base, 0) + 1
        s.id = base if seen[base] == 1 else f"{base}#{seen[base]}"
    return sorted(found, key=lambda s: s.id)


# ---- evaluating a site's real text with chosen values -----------------------------------------------------------

_MODULES: dict[Path, ModuleType] = {}


def module_of(path: Path) -> ModuleType:
    if path not in _MODULES:
        rel = path.relative_to(ROOT)
        if rel.parts[0] == "src":
            _MODULES[path] = importlib.import_module(".".join(rel.with_suffix("").parts[1:]))
        else:
            sys.path.insert(0, str(path.parent))
            spec = importlib.util.spec_from_file_location(f"alert_site_{path.stem}", path)
            assert spec and spec.loader
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            _MODULES[path] = mod
    return _MODULES[path]


def _eval(node: ast.expr, ns: dict[str, Any]) -> Any:
    return eval(compile(ast.Expression(body=node), "<alert site>", "eval"), ns)  # noqa: S307 — the repo's own code


def render(site: Site, bindings: dict[str, Any]) -> tuple[str, str]:
    """The title and the message this site sends with `bindings` for its free names, as wt.ops.alerts sends them."""
    mod = module_of(site.file)
    ns: dict[str, Any] = {**vars(mod), **bindings}
    for level, wrapper in zip(site.chain[:-1], site.wrappers, strict=True):
        method = isinstance(level.call.func, ast.Attribute)
        values: dict[str, Any] = {}
        defaults = wrapper.args.defaults
        positional = [x.arg for x in (*wrapper.args.posonlyargs, *wrapper.args.args)]
        for p, d in zip(positional[len(positional) - len(defaults):], defaults, strict=True):
            values[p] = _eval(d, dict(vars(mod)))
        for p in _params(wrapper):
            if p in ("self", "cls"):
                values[p] = bindings.get("self")
                continue
            e = _arg_for(level.call, wrapper, p, method)
            if e is not None:
                try:
                    values[p] = _eval(e, ns)
                except NameError:
                    pass                    # an argument the text never uses (alerts, log, ...)
        ns = {**vars(mod), **values}
    sink = site.chain[-1]
    from wt.ops.alerts import render as sent
    return sent(str(_eval(sink.title, ns)), str(_eval(sink.message, ns)))


def free_names(site: Site) -> set[str]:
    """The names a site's text needs that its module does not define (the values a test must choose)."""
    mod_names = _module_names(ast.parse(site.file.read_text())) | set(dir(builtins))
    top = site.chain[0]
    return _names(top.title, top.message) - mod_names
