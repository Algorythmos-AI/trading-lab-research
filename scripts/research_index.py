"""Every experiment in research/experiments, one line each, with what identifies it.

    python scripts/research_index.py            # or: make research-index

Printed, not committed: a file that every experiment would have to regenerate goes stale the first time someone
forgets. The identifiers are the ones the experiments already record (the decision, the span, the data hash) plus
a hash of the result file itself and the commit that added it, so a result can be told from a later edit of it.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
RESULTS = ("result.json", "results.json")


def _added(path: Path) -> str:
    try:
        r = subprocess.run(["git", "log", "--diff-filter=A", "--format=%h", "--", str(path.relative_to(ROOT))], cwd=ROOT,
                           capture_output=True, text=True, timeout=20)
        return r.stdout.split()[-1] if r.returncode == 0 and r.stdout.split() else "-"
    except (OSError, subprocess.TimeoutExpired):
        return "-"


def row(folder: Path) -> dict[str, Any]:
    f = next((folder / n for n in RESULTS if (folder / n).exists()), None)
    out: dict[str, Any] = {"id": folder.name.split("-")[0] + "-" + folder.name.split("-")[1], "folder": folder.name,
                           "decision": "-", "span": "-", "data": "-", "result": "-", "commit": "-",
                           "superseded": (folder / "SUPERSEDED.md").exists()}
    if f is None:
        return out
    body = f.read_bytes()
    out.update(result=hashlib.sha256(body).hexdigest()[:12], commit=_added(f))
    try:
        d = json.loads(body)
    except ValueError:
        return out
    if isinstance(d, dict):
        day = lambda t: dt.datetime.fromtimestamp(int(t), dt.UTC).date().isoformat()      # noqa: E731
        out["decision"] = str(d.get("decision") or "-")
        out["data"] = str(d.get("data_hash") or "-")
        if isinstance(d.get("start"), int) and isinstance(d.get("end"), int):
            out["span"] = f"{day(d['start'])} to {day(d['end'])}"
    return out


def index(root: Path = ROOT) -> list[dict[str, Any]]:
    return [row(p) for p in sorted((root / "research" / "experiments").glob("EXP-*")) if p.is_dir()]


def main() -> int:
    rows = index()
    print("| Experiment | Decision | Span | Data hash | Result hash | Added in | Note |\n|---|---|---|---|---|---|---|")
    for r in rows:
        print(f"| {r['folder']} | {r['decision']} | {r['span']} | {r['data']} | {r['result']} | {r['commit']} | "
              f"{'superseded' if r['superseded'] else ''} |")
    return 0


if __name__ == "__main__":
    sys.exit(main())
