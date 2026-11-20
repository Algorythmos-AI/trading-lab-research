"""Which Alpaca key names are set, and which pair a Python tool will use: `make keys-check` (B9).

Offline and read only: it reads the environment it was started with and the env files, and prints names and
verdicts. It sends nothing anywhere, and never prints a value, a part of one or a hash of one; two values are
only compared with each other. It always exits 0: it is advice.

Why it exists: `wt.core.config` loads `.env` with python-dotenv's default `override=False`, then `WT_ENV_FILE` the
same way, so a name already in the environment wins over both files. A shell that exports an old key pair makes
every hand-run Python tool use that pair, and Alpaca answers 401. This module must not import `wt.core.config`:
the import loads `.env` into the environment and the check could no longer tell the two apart. The files are read
with python-dotenv's own parser, the one `load_dotenv` uses (`export ` prefixes, quotes and CRLF line ends alike).

    python -m wt.ops.keys_check [--env-file PATH]
"""
from __future__ import annotations

import argparse
import logging
import os
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import NoReturn

from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parents[3]


@dataclass(frozen=True)
class Pair:
    id_name: str
    secret_name: str
    who: str


PAIRS = (
    Pair("APCA_API_KEY_ID", "APCA_API_SECRET_KEY",
         "stocks paper account: runner B, the routine, the forward test, the pipeline check, research scripts; "
         "the site and make feed-agreement when the ALPACA_ pair is not set"),
    Pair("APCA_OPTIONS_KEY_ID", "APCA_OPTIONS_SECRET_KEY",
         "second paper account: options-live (Paper positions), and the options clone when the clone pair is not set"),
    Pair("APCA_CLONE_KEY_ID", "APCA_CLONE_SECRET_KEY", "the options clone's own paper account (wins over APCA_OPTIONS_)"),
    Pair("APCA_S_KEY_ID", "APCA_S_SECRET_KEY",
         "Robot B sleeve S's own paper account (DEC-0066): runner_s, for orders and market data; never APCA_API_"),
    Pair("ALPACA_API_KEY_ID", "ALPACA_API_SECRET_KEY",
         "the site (Vercel) and make feed-agreement: read before APCA_API_; no Python tool reads it"),
)


@dataclass(frozen=True)
class EnvFile:
    """One env file as `load_dotenv` would meet it. `status`: read, missing, not a file, or unreadable."""
    label: str
    path: Path
    status: str
    values: Mapping[str, str] | None = None


def read_env_file(label: str, path: Path) -> EnvFile:
    """The file read as `load_dotenv` reads it. Never raises; an error's text is never kept (it could carry an offset
    into the file). python-dotenv skips a path that is not a file and raises on one it cannot open or decode."""
    try:
        if not path.exists():
            return EnvFile(label, path, "missing")
        if not path.is_file():
            return EnvFile(label, path, "not a file")
        values, bad_lines = _parse_quietly(path)
        return EnvFile(label, path, "read, with lines that could not be parsed" if bad_lines else "read", values)
    except (OSError, UnicodeError, ValueError):
        return EnvFile(label, path, "unreadable")


class _Count(logging.Handler):
    def __init__(self) -> None:
        super().__init__(logging.DEBUG)
        self.n = 0

    def emit(self, record: logging.LogRecord) -> None:
        self.n += 1


def _parse_quietly(path: Path) -> tuple[dict[str, str], bool]:
    """dotenv_values, with python-dotenv's own warnings kept off stderr: "could not parse statement starting at line
    N" is a location inside a secrets file. They are only counted. The logger is restored afterwards."""
    lg = logging.getLogger("dotenv.main")
    count = _Count()
    saved = (lg.propagate, lg.level, lg.handlers[:])
    lg.handlers, lg.propagate = [count], False
    lg.setLevel(logging.DEBUG)
    try:
        values = {k: v for k, v in dotenv_values(path).items() if v is not None}
    finally:
        lg.propagate, lg.handlers = saved[0], saved[2]
        lg.setLevel(saved[1])
    return values, count.n > 0


STATUS_WORDS = {
    "read": "read",
    "read, with lines that could not be parsed": "read, with lines that could not be parsed",
    "missing": "not found; Python tools skip it",
    "not a file": "not a regular file; Python tools skip it",
    "unreadable": "exists but cannot be read; a Python tool that loads it fails before it uses any key",
}


def _where(name: str, env: Mapping[str, str]) -> str:
    if name not in env:
        return "unset"
    return "set" if env[name] else "set but empty"


def _pair_state(p: Pair, env: Mapping[str, str]) -> str:
    a, b = _where(p.id_name, env), _where(p.secret_name, env)
    if a == b:
        return {"unset": "neither name", "set": "both names", "set but empty": "both names, empty"}[a]
    return f"{p.id_name} {a}, {p.secret_name} {b}"


def _same(p: Pair, x: Mapping[str, str], y: Mapping[str, str]) -> bool:
    return x.get(p.id_name) == y.get(p.id_name) and x.get(p.secret_name) == y.get(p.secret_name)


def verdict(p: Pair, shell: Mapping[str, str], env_files: Sequence[EnvFile]) -> list[str]:
    """What a Python tool started from this shell gets for `p`, in words. No value appears in the result."""
    names = (p.id_name, p.secret_name)
    out: list[str] = []
    broken = [e.label for e in env_files if e.status == "unreadable"]
    if broken:
        out.append(f"{', '.join(broken)} cannot be read: a Python tool that loads it would fail to start, whatever "
                   "the shell sets; the verdicts below ignore it")
    files = [(e.label, e.values) for e in env_files]
    in_shell = [n for n in names if n in shell]
    defining = [(label, f) for label, f in files if f is not None and any(n in f for n in names)]
    if p.id_name.startswith("ALPACA_"):
        out.append("no Python tool reads these names; for make feed-agreement the env file's pair wins over the shell's")
    if len(in_shell) == 2:
        for label, f in defining:
            if all(n in f for n in names):
                out.append(f"the shell's pair is the same as {label}'s" if _same(p, shell, f) else
                           f"the shell's pair differs from {label}'s: Python tools will use the shell's")
            else:
                out.append(f"{label} defines only part of the pair; Python tools use the shell's")
        if not defining:
            out.append("only the shell defines the pair: Python tools use the shell's" if not broken else
                       "no readable file defines the pair; the shell sets it")
        if any(not shell[n] for n in names):
            out.append("the shell holds an empty value, and an empty name in the shell still wins over every file")
    elif len(in_shell) == 1:
        rest = next(n for n in names if n not in shell)
        src = next((label for label, f in defining if rest in f), None)
        out.append(f"the shell sets only {in_shell[0]}: Python tools mix it with {rest} from {src}, a mixed pair"
                   if src else f"the shell sets only {in_shell[0]} and no file defines {rest}: the pair is incomplete")
    else:
        if not defining:
            out.append("not set anywhere: a tool that needs this pair stops or does nothing" if not broken else
                       "not set in the shell or in any readable file")
        else:
            label, f = defining[0]
            if all(n in f for n in names):
                out.append(f"the shell sets neither name: Python tools use {label}'s pair")
            else:
                out.append(f"{label} defines only part of the pair: the pair is incomplete")
            for other, g in defining[1:]:
                if all(n in g for n in names) and all(n in f for n in names):
                    out.append(f"{other}'s pair is the same as {label}'s" if _same(p, f, g) else
                               f"{other}'s pair differs from {label}'s; {label}'s wins (loaded first)")
    return out


def report(shell: Mapping[str, str], files: Sequence[tuple[str, Path]], compare_only: bool = False) -> list[str]:
    """The whole report, as lines. `files`: (label, path) in the order `wt.core.config` loads them."""
    env_files = [read_env_file(label, path) for label, path in files]
    lines = ["Alpaca keys by name only: no value, part or hash of a value is shown, and nothing is sent anywhere.",
             "Python tools: a name in the shell wins; otherwise the first file below that defines it.", ""]
    if compare_only:
        lines += ["The file named with --env-file (KEYS_ENV_FILE) is shown for comparison only: the tools in a checkout",
                  "load that checkout's .env, then WT_ENV_FILE.", ""]
    for e in env_files:
        name = str(e.path) if e.label == str(e.path) else f"{e.label}: {e.path}"
        lines.append(f"{name} ({STATUS_WORDS[e.status]})")
    for p in PAIRS:
        lines += ["", f"{p.id_name} / {p.secret_name}", f"  who reads it: {p.who}",
                  f"  shell: {_pair_state(p, shell)}"]
        for e in env_files:
            if e.values is not None:
                lines.append(f"  {e.label}: {_pair_state(p, e.values)}")
        lines += [f"  -> {v}" for v in verdict(p, shell, env_files)]
    lines += ["", "make feed-agreement reads its env file's pair first (ALPACA_API_, then APCA_API_), then the shell's.",
              "A reset of a paper account revokes its key pair for every consumer that shares it.",
              "To drop a stale exported pair from this shell: unset the names (the values are not shown here)."]
    return lines


class _Usage(Exception):
    pass


class _Parser(argparse.ArgumentParser):
    def error(self, message: str) -> NoReturn:          # never exit non-zero: it is advice
        raise _Usage


def _run(argv: Sequence[str] | None, environ: Mapping[str, str] | None, root: Path) -> None:
    ap = _Parser(prog="python -m wt.ops.keys_check", description="Which Alpaca key pair Python tools will use.")
    ap.add_argument("--env-file", default=None, help="another env file to compare with (default: the checkout's .env)")
    try:
        a = ap.parse_args(argv)
    except _Usage:
        print("usage: python -m wt.ops.keys_check [--env-file PATH]   (make keys-check [KEYS_ENV_FILE=PATH])")
        return
    shell = dict(os.environ if environ is None else environ)
    files: list[tuple[str, Path]] = [(a.env_file, Path(a.env_file)) if a.env_file else (".env", root / ".env")]
    if shell.get("WT_ENV_FILE"):
        files.append(("WT_ENV_FILE", Path(shell["WT_ENV_FILE"])))
    for line in report(shell, files, compare_only=bool(a.env_file)):
        print(line)


def main(argv: Sequence[str] | None = None, environ: Mapping[str, str] | None = None, root: Path = ROOT) -> int:
    """Always 0, and never a traceback: a failure prints one line with no exception text."""
    try:
        _run(argv, environ, root)
    except SystemExit:                                   # --help, or anything else that tries to exit
        pass
    except Exception:  # noqa: BLE001 — advice must not fail; the error's text could carry file content
        print("keys-check: the check could not finish (no detail is shown, so that no value can leak)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
