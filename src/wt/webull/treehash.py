"""The fingerprint of the Webull package's code (ADR 0011): what the owner compares with the pull request.

    python -m wt.webull.treehash [DIR]        # default: this package's own directory

The pull job runs a root-owned copy of this package (/opt/wt-webull, made by `sudo wt-install-units`), never the
checkout `wt` can change. The fingerprint is the SHA-256 of a manifest with one line per top-level .py file, sorted by
name (byte order; a name starting with "." is left out, as the shell's *.py leaves it out), each line exactly as coreutils prints it: "<sha256 of the file>  <name>". So root can compute
it with `sha256sum` alone, without running any code from the checkout, and get the same value as this module:

    cd DIR && LC_ALL=C sha256sum -- $(printf '%s\\n' *.py | LC_ALL=C sort) | sha256sum

Standard library only; it runs on the owner's Mac, in the publisher, and in tests.
"""
from __future__ import annotations

import hashlib
import sys
from pathlib import Path


def manifest(root: Path) -> bytes:
    names = sorted((p.name for p in root.glob("*.py") if p.is_file() and not p.name.startswith(".")),
                   key=lambda n: n.encode())
    return b"".join(f"{hashlib.sha256((root / n).read_bytes()).hexdigest()}  {n}\n".encode() for n in names)


def tree_hash(root: Path) -> str | None:
    """The fingerprint of the .py files directly in `root`, or None when there are none (or it is unreadable)."""
    try:
        m = manifest(root)
    except OSError:
        return None
    return hashlib.sha256(m).hexdigest() if m else None


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    h = tree_hash(Path(args[0]) if args else Path(__file__).resolve().parent)
    if h is None:
        print("no .py files there", file=sys.stderr)
        return 1
    print(h)
    return 0


if __name__ == "__main__":
    sys.exit(main())
