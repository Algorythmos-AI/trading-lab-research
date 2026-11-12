"""The static scan behind tests/unit/test_feed_named.py: every Alpaca market-data request in the source names its feed.

Per call, not per function. A call is a data request when one of its arguments is a URL (or path) that reaches a
feed-taking data path: with or without the leading slash, written in one piece or several (`DATA + "/v2/" +
"stocks/bars"`), straight or through a name assigned in the same function or at module level. A data base (the data
host's name in a literal, or a name such as DATA, DATA_HOST, DATA_URL) followed by a piece the scan cannot read counts
as a data request too. For each such call, the feed must be named in that call: in a dict literal or `dict(...)`
argument, in a dict assigned to the argument's name in the same scope (spreads followed), or in the URL's query.
Only calls to request-like callees count (`get`, `_get`, `_paged`, `_alpaca_get`, `request`, `urlopen`, `fetch...`),
and only positional arguments and `params=` are read as the params (`headers=` never names a feed).
Flagged: `"feed": None` or `""` (also through a name assigned None or ""), a feed set only under a condition (a
`p["feed"] = ...` counts when it is in the same block as the request, before it, or in a block that contains it), a
`**spread` after the feed key, and a later `.pop("feed")`, `del p["feed"]`, `.clear()`, `p |= ...` or
`.update(...)` that may drop or blank it. alpaca-py data request classes (aliases followed, `.model_validate` and
`.model_construct` too) and streams must name `feed=` with a value other than None.

Limits (not caught here): a URL name assigned twice in a function (the scan cannot tell which value is sent, so it
reads neither); a params dict reassigned under a condition (each assignment is read as if it always happened); a data
base under a name the scan does not know as one (anything but DATA, DATA_HOST, ...DATA_URL or the host literal) is
caught only when the piece beside it is a whole path (`v2/stocks/...`, `v1beta1/options/...`), not a bare
`stocks/bars`; a URL or params from another function or module, or anything dynamic. `AlpacaREST.get` refuses at
run time any such request sent through it.
"""
from __future__ import annotations

import ast
import re
from collections.abc import Iterable

STOCK_OR_OPTION = r"(?:v2/)?stocks/(?!meta/)|(?:v1beta1/)?options/(?:snapshots|(?:quotes|trades|bars)/latest)"
# Without a visible data base the path itself must be whole: v2/stocks/... or v1beta1/options/..., slash optional.
WHOLE_PATH = re.compile(r"(?:^|/|\})v2/stocks/(?!meta/)|(?:^|/|\})v1beta1/options/(?:snapshots|(?:quotes|trades|bars)/latest)")
AFTER_BASE = re.compile(rf"^/?(?:{STOCK_OR_OPTION}|\{{\?\}})")
BASE_NAME = re.compile(r"^(?:DATA|DATA_HOST|[A-Z_]*DATA_URL)$")
HOST = "data.alpaca.markets"
BASE = "\x00BASE\x00"            # a data base in a flattened URL
UNKNOWN = "{?}"                  # a piece the scan cannot read
REQUEST_CALLEE = re.compile(r"(?:^|_)(?:get|request|paged|urlopen|fetch)(?:$|_)", re.I)
HOW = ("name the feed in a dict literal in this call, in a dict assigned in this function, or in the URL's query; "
       "or add the site to KNOWN_IMPLICIT with the owner's decision")


def _id(n: ast.AST) -> str | None:
    if isinstance(n, ast.Name):
        return n.id
    if isinstance(n, ast.Attribute):
        return n.attr
    return None


class Scope:
    def __init__(self, node: ast.AST, qual: str, module: Scope | None) -> None:
        self.node, self.qual, self.module = node, qual, module
        self.own: list[ast.AST] = []
        self.assigned: dict[str, list[ast.expr]] = {}

    def values(self, name: str) -> list[ast.expr]:
        got = self.assigned.get(name, [])
        return got if got or self.module is None or self.module is self else self.module.values(name)


def _collect(node: ast.AST, qual: str, module: Scope | None, out: list[Scope]) -> Scope:
    s = Scope(node, qual, module)
    out.append(s)
    stack = list(ast.iter_child_nodes(node))
    while stack:
        n = stack.pop()
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
            _collect(n, f"{qual}.{getattr(n, 'name', 'lambda')}" if qual else getattr(n, "name", "lambda"),
                     module or s, out)
            continue
        if isinstance(n, ast.Expr) and isinstance(n.value, ast.Constant) and isinstance(n.value.value, str):
            continue                                    # a docstring or a bare string sends nothing
        s.own.append(n)
        if isinstance(n, ast.Assign):
            for t in n.targets:
                if isinstance(t, ast.Name):
                    s.assigned.setdefault(t.id, []).append(n.value)
        elif isinstance(n, (ast.AnnAssign, ast.AugAssign)) and isinstance(n.target, ast.Name) and n.value is not None:
            s.assigned.setdefault(n.target.id, []).append(n.value)
        stack.extend(ast.iter_child_nodes(n))
    return s


def flatten(e: ast.AST, scope: Scope, seen: frozenset[str] = frozenset()) -> str:
    """A URL expression as text: literals as they are, a data base as BASE, anything unreadable as UNKNOWN."""
    if isinstance(e, ast.Constant) and isinstance(e.value, str):
        return e.value.replace(f"https://{HOST}", BASE).replace(HOST, BASE)
    if isinstance(e, ast.JoinedStr):
        return "".join(flatten(v.value if isinstance(v, ast.FormattedValue) else v, scope, seen) for v in e.values)
    if isinstance(e, ast.BinOp) and isinstance(e.op, ast.Add):
        return flatten(e.left, scope, seen) + flatten(e.right, scope, seen)
    if (isinstance(e, ast.Call) and isinstance(e.func, ast.Attribute) and e.func.attr == "format"
            and isinstance(e.func.value, ast.Constant) and isinstance(e.func.value.value, str)):
        args = iter([flatten(a, scope, seen) for a in e.args])
        return re.sub(r"\{[^{}]*\}", lambda _m: next(args, UNKNOWN), flatten(e.func.value, scope, seen))
    if isinstance(e, ast.Call) and _id(e.func) in {"urljoin", "join"} and len(e.args) >= 2:
        return flatten(e.args[0], scope, seen) + "/" + flatten(e.args[1], scope, seen)
    name = _id(e)
    if name is not None:
        if BASE_NAME.match(name):
            return BASE
        if isinstance(e, ast.Name) and name not in seen:
            vals = [v for v in scope.values(name) if isinstance(v, (ast.Constant, ast.JoinedStr, ast.BinOp))]
            if len(vals) == 1:
                return flatten(vals[0], scope, seen | {name})
    return UNKNOWN


def is_data_url(text: str) -> bool:
    if WHOLE_PATH.search(text):
        return True
    i = text.find(BASE)
    return i >= 0 and bool(AFTER_BASE.match(text[i + len(BASE):]))


def _query_feed(text: str) -> bool | None:
    """True when the URL's query names a feed, False when it names `feed=None`, None when it names none."""
    m = re.search(r"[?&]feed=([^&]*)", text)
    if m is None:
        return None
    return m.group(1) not in ("", "None", "{None}")


def _block_of(stmt: ast.AST, parents: dict[int, ast.AST]) -> tuple[list[ast.AST], int] | None:
    """The statement list holding `stmt`, and its index there."""
    par = parents.get(id(stmt))
    if par is None:
        return None
    for _field, val in ast.iter_fields(par):
        if isinstance(val, list):
            for i, x in enumerate(val):
                if x is stmt:
                    return val, i
    return None


def _before(stmt: ast.AST, call: ast.AST, parents: dict[int, ast.AST]) -> bool:
    """Whether `stmt` always runs before `call`: it sits in a block that holds `call` (or a statement around it)
    after it."""
    where = _block_of(stmt, parents)
    if where is None:
        return False
    block, i = where
    node: ast.AST | None = call
    while node is not None:
        for j, x in enumerate(block):
            if x is node:
                return j > i
        node = parents.get(id(node))
    return False


class DictState:
    def __init__(self, call: ast.AST | None = None, parents: dict[int, ast.AST] | None = None) -> None:
        self.named = False
        self.problems: list[str] = []
        self.call, self.parents = call, parents or {}


def _blank(v: ast.AST, scope: Scope) -> bool:
    """`None` or `""`, or a name whose only values in reach include one of them."""
    if isinstance(v, ast.Constant):
        return v.value is None or v.value == ""
    if isinstance(v, ast.Name):
        return any(isinstance(x, ast.Constant) and (x.value is None or x.value == "") for x in scope.values(v.id))
    return False


def _dict_names_feed(d: ast.AST, scope: Scope, seen: frozenset[str], st: DictState) -> None:
    if isinstance(d, ast.Dict):
        feed_at = None
        for i, (k, v) in enumerate(zip(d.keys, d.values, strict=True)):
            if k is None:
                if feed_at is not None:
                    st.problems.append("a **spread after the feed may replace it")
                if isinstance(v, ast.Name):
                    _name_names_feed(v.id, scope, seen, st)
            elif isinstance(k, ast.Constant) and k.value == "feed":
                feed_at = i
                if _blank(v, scope):
                    st.problems.append('"feed" is None or empty')
                else:
                    st.named = True
    elif isinstance(d, ast.Call) and _id(d.func) == "dict":
        for kw in d.keywords:
            if kw.arg == "feed":
                if _blank(kw.value, scope):
                    st.problems.append("feed=None or empty")
                else:
                    st.named = True
            elif kw.arg is None and isinstance(kw.value, ast.Name):
                _name_names_feed(kw.value.id, scope, seen, st)
        for a in d.args:
            _dict_names_feed(a, scope, seen, st)
    elif isinstance(d, ast.Name):
        _name_names_feed(d.id, scope, seen, st)


def _name_names_feed(name: str, scope: Scope, seen: frozenset[str], st: DictState) -> None:
    if name in seen:
        return
    seen = seen | {name}
    for v in scope.values(name):
        _dict_names_feed(v, scope, seen, st)
    for n in scope.own:
        # x["feed"] = ...: counts when it always runs before the request
        if isinstance(n, ast.Assign):
            for t in n.targets:
                if (isinstance(t, ast.Subscript) and isinstance(t.value, ast.Name) and t.value.id == name
                        and isinstance(t.slice, ast.Constant) and t.slice.value == "feed"):
                    if _blank(n.value, scope):
                        st.problems.append(f'{name}["feed"] is set to None or empty')
                    elif st.call is None or not _before(n, st.call, st.parents):
                        st.problems.append(f'{name}["feed"] set only under a condition')
                    else:
                        st.named = True
        elif (isinstance(n, ast.AugAssign) and isinstance(n.op, ast.BitOr) and isinstance(n.target, ast.Name)
              and n.target.id == name):
            st.problems.append(f"{name} |= ... may change the feed")
        elif isinstance(n, ast.Delete):
            for t in n.targets:
                if (isinstance(t, ast.Subscript) and isinstance(t.value, ast.Name) and t.value.id == name
                        and isinstance(t.slice, ast.Constant) and t.slice.value == "feed"):
                    st.problems.append(f'del {name}["feed"]')
        elif (isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and isinstance(n.func.value, ast.Name)
              and n.func.value.id == name):
            if n.func.attr in ("pop", "popitem") and (n.func.attr == "popitem" or any(
                    isinstance(a, ast.Constant) and a.value == "feed" for a in n.args)):
                st.problems.append(f"{name}.{n.func.attr}(...) drops the feed")
            elif n.func.attr == "clear":
                st.problems.append(f"{name}.clear()")
            elif n.func.attr in ("update", "setdefault", "__setitem__"):
                safe = (n.func.attr == "update" and not n.keywords and len(n.args) == 1
                        and isinstance(n.args[0], ast.Dict)
                        and not any(k is None or (isinstance(k, ast.Constant) and k.value == "feed")
                                    for k in n.args[0].keys))
                if not safe:
                    st.problems.append(f"{name}.{n.func.attr}(...) may change the feed")


def _sdk_names(tree: ast.Module, classes: set[str]) -> set[str]:
    """The SDK class names as this module may spell them: the names themselves and their `import ... as` aliases."""
    out = set(classes)
    for n in ast.walk(tree):
        if isinstance(n, ast.ImportFrom):
            for a in n.names:
                if a.name in classes and a.asname:
                    out.add(a.asname)
    return out


def _sdk_call(n: ast.Call, names: set[str]) -> str | None:
    f = n.func
    if isinstance(f, ast.Attribute) and f.attr in ("model_validate", "model_construct", "parse_obj", "construct"):
        cls = _id(f.value)
        return cls if cls in names else None
    cls = _id(f)
    return cls if cls in names else None


def scan(rel: str, source: str, sdk_classes: Iterable[str], found: list[str] | None = None) -> list[str]:
    """Each data request in `source` that does not name its feed, as "rel:line: why". `found` collects every data
    request seen, as "rel:line", so a test can tell the scan is not passing for want of finding anything."""
    tree = ast.parse(source)
    parents = {id(c): p for p in ast.walk(tree) for c in ast.iter_child_nodes(p)}
    scopes: list[Scope] = []
    _collect(tree, "", None, scopes)
    names = _sdk_names(tree, set(sdk_classes))
    out: list[str] = []
    for s in scopes:
        for n in s.own:
            if not isinstance(n, ast.Call):
                continue
            cls = _sdk_call(n, names)
            if cls is not None:
                if found is not None:
                    found.append(f"{rel}:{n.lineno}")
                out += [f"{rel}:{n.lineno}: {cls} {w}" for w in _sdk_problems(n, s)]
                continue
            if not REQUEST_CALLEE.search(_id(n.func) or ""):
                continue
            args: list[ast.expr] = [*n.args, *(k.value for k in n.keywords if k.arg in ("url", "params", None))]
            urls = [(a, flatten(a, s)) for a in args]
            hits = [(a, t) for a, t in urls if is_data_url(t)]
            if not hits:
                continue
            if found is not None:
                found.append(f"{rel}:{n.lineno}")
            st = DictState(n, parents)
            for _a, t in hits:
                q = _query_feed(t)
                if q is True:
                    st.named = True
                elif q is False:
                    st.problems.append("feed=None in the query")
            for a in args:
                if all(a is not h for h, _ in hits):
                    _dict_names_feed(a, s, frozenset(), st)
            if st.problems:
                out += [f"{rel}:{n.lineno}: {p}: {HOW}" for p in st.problems]
            elif not st.named:
                out.append(f"{rel}:{n.lineno}: a data request names no feed ({s.qual or '<module>'}): {HOW}")
    return out


def _sdk_problems(n: ast.Call, scope: Scope) -> list[str]:
    for k in n.keywords:
        if k.arg == "feed":
            return ["with feed=None"] if isinstance(k.value, ast.Constant) and k.value.value is None else []
        if k.arg is None:
            return ["with **kwargs: the feed cannot be read"]
    if isinstance(n.func, ast.Attribute) and n.args:          # model_validate({...})
        st = DictState()
        _dict_names_feed(n.args[0], scope, frozenset(), st)
        return st.problems or ([] if st.named else ["without a feed"])
    return ["without feed="]
