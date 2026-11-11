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
import os
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

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
    Pair("ALPACA_API_KEY_ID", "ALPACA_API_SECRET_KEY",
         "the site (Vercel) and make feed-agreement: read before APCA_API_; no Python tool reads it"),
)


def read_env_file(path: Path) -> dict[str, str] | None:
    """The file's names and values as `load_dotenv` would read them, or None when it is missing or unreadable."""
    try:
        if not path.is_file():
            return None
        return {k: v for k, v in dotenv_values(path).items() if v is not None}
    except OSError:
        return None


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


def verdict(p: Pair, shell: Mapping[str, str], files: Sequence[tuple[str, Mapping[str, str] | None]]) -> list[str]:
    """What a Python tool started from this shell gets for `p`, in words. No value appears in the result."""
    names = (p.id_name, p.secret_name)
    out: list[str] = []
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
            out.append("only the shell defines the pair: Python tools use the shell's")
        if any(not shell[n] for n in names):
            out.append("the shell holds an empty value, and an empty name in the shell still wins over every file")
    elif len(in_shell) == 1:
        rest = next(n for n in names if n not in shell)
        src = next((label for label, f in defining if rest in f), None)
        out.append(f"the shell sets only {in_shell[0]}: Python tools mix it with {rest} from {src}, a mixed pair"
                   if src else f"the shell sets only {in_shell[0]} and no file defines {rest}: the pair is incomplete")
    else:
        if not defining:
            out.append("not set anywhere: a tool that needs this pair stops or does nothing")
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


def report(shell: Mapping[str, str], files: Sequence[tuple[str, Path | None]]) -> list[str]:
    """The whole report, as lines. `files`: (label, path) in the order `wt.core.config` loads them."""
    read = [(label, read_env_file(path) if path is not None else None) for label, path in files]
    lines = ["Alpaca keys by name only: no value, part or hash of a value is shown, and nothing is sent anywhere.",
             "Python tools: a name in the shell wins; otherwise the first file below that defines it.", ""]
    for (label, path), (_, f) in zip(files, read, strict=True):
        lines.append(f"{label}: {path if path is not None else 'not named'} ({'read' if f is not None else 'not found'})")
    for p in PAIRS:
        lines += ["", f"{p.id_name} / {p.secret_name}", f"  who reads it: {p.who}",
                  f"  shell: {_pair_state(p, shell)}"]
        for label, f in read:
            if f is not None:
                lines.append(f"  {label}: {_pair_state(p, f)}")
        lines += [f"  -> {v}" for v in verdict(p, shell, read)]
    lines += ["", "make feed-agreement reads its env file's pair first (ALPACA_API_, then APCA_API_), then the shell's.",
              "A reset of a paper account revokes its key pair for every consumer that shares it.",
              "To drop a stale exported pair from this shell: unset the names (the values are not shown here)."]
    return lines


def main(argv: Sequence[str] | None = None, environ: Mapping[str, str] | None = None, root: Path = ROOT) -> int:
    ap = argparse.ArgumentParser(prog="python -m wt.ops.keys_check", description=__doc__.split("\n")[0])
    ap.add_argument("--env-file", default=None, help="the env file to compare with (default: the checkout's .env)")
    a = ap.parse_args(argv)
    shell = dict(os.environ if environ is None else environ)
    first = Path(a.env_file) if a.env_file else root / ".env"
    files: list[tuple[str, Path | None]] = [(".env", first)]
    if shell.get("WT_ENV_FILE"):
        files.append(("WT_ENV_FILE", Path(shell["WT_ENV_FILE"])))
    for line in report(shell, files):
        print(line)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
