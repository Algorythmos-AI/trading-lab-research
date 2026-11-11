"""deploy/oci/bin/wt-alert (systemd OnFailure) posts to the public ntfy topic: fixed words and a safe unit name only."""
from __future__ import annotations

import os
import socket
import subprocess
from pathlib import Path

import pytest

from wt.ops.alerts import PAGE_CHARS

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "deploy" / "oci" / "bin" / "wt-alert"
HOSTILE = ["SPY broke 123.45 $1,234.56", "x$(touch pwned)", "a;rm -rf /", "unit@host.example", "../../etc/passwd",
           "https://lab.example/x", "Z" * 200, "wt-paper-b.service\nInjected: header", ""]


def run(tmp_path: Path, unit: str | None) -> tuple[list[str], str]:
    bin_ = tmp_path / "bin"
    bin_.mkdir(exist_ok=True)
    out = tmp_path / "curl-args"
    curl = bin_ / "curl"
    curl.write_text(f'#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "{out}"\n')       # records, sends nothing
    curl.chmod(0o755)
    paging = tmp_path / "paging"
    paging.write_text("NTFY_TOPIC=test-topic\nNTFY_SERVER=https://ntfy.invalid\n")
    env = {**os.environ, "PATH": f"{bin_}:{os.environ['PATH']}", "WT_PAGING_FILE": str(paging)}
    args = ["bash", str(SCRIPT)] + ([] if unit is None else [unit])
    r = subprocess.run(args, env=env, capture_output=True, text=True, timeout=30, cwd=tmp_path)
    assert r.returncode == 0
    return (out.read_text().splitlines() if out.exists() else []), r.stderr


def page(argv: list[str]) -> tuple[str, str]:
    title = next(a for a in argv if a.startswith("Title: "))[len("Title: "):]
    body = argv[argv.index("-d") + 1]
    return title, body


def test_the_script_never_names_the_host():
    assert "hostname" not in SCRIPT.read_text()


@pytest.mark.parametrize("unit", ["wt-paper-b.service", "wt-backup.service", None, *HOSTILE])
def test_every_page_keeps_to_the_allowlist(tmp_path, unit):
    argv, _ = run(tmp_path, unit)
    title, body = page(argv)
    host = socket.gethostname().split(".")[0]
    for text in (title, body):
        assert PAGE_CHARS.fullmatch(text), text
        assert host not in text or host in ("wt", "a")
        for bad in ("123.45", "$", "@", "pwned", "passwd", "https", "Z" * 20, "Injected"):
            assert bad not in text
    assert not (tmp_path / "pwned").exists()
    if unit and unit.startswith("wt-") and "\n" not in unit:
        assert title == f"Trading host: {unit.removesuffix('.service')} failed" and unit in body
    else:
        assert "a unit" in title and "a unit" in body


def test_paper_b_pages_at_priority_five(tmp_path):
    argv, _ = run(tmp_path, "wt-paper-b.service")
    assert "Priority: 5" in argv
    argv, _ = run(tmp_path, "wt-backup.service")
    assert "Priority: 4" in argv
