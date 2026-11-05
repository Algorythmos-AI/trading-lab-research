"""Build and summarise an external-trader post record (research/external/<source>/).

    python scripts/external_posts.py build research/external/desi-trade raw1.json [raw2.json ...]
    python scripts/external_posts.py code research/external/desi-trade codes.jsonl [more.jsonl ...]
    python scripts/external_posts.py stats research/external/desi-trade

``build`` merges collected batches (JSON arrays written by the record's collect.js) into posts/YYYY-MM.jsonl,
recomputing the mechanical fields and keeping every coded field. ``code`` writes coded fields (one JSON object per
line, keyed by ``id``) onto the posts. Every command then rewrites stats.md from the posts.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from wt.research import external_posts as ep  # noqa: E402


def main(argv: list[str]) -> int:
    if len(argv) < 2 or argv[0] not in {"build", "code", "stats"}:
        print(__doc__)
        return 2
    record = Path(argv[1])
    if argv[0] == "build":
        batches = [json.loads(Path(p).read_text(encoding="utf-8")) for p in argv[2:]]
        print(json.dumps(ep.build(record / "posts", batches)))
    if argv[0] == "code":
        codes = [json.loads(line) for p in argv[2:] for line in Path(p).read_text(encoding="utf-8").splitlines()
                 if line.strip()]
        print(json.dumps(ep.apply_codes(record / "posts", codes)))
    rows = ep.load(record / "posts")
    (record / "stats.md").write_text(ep.stats_markdown(rows), encoding="utf-8")
    print(f"stats.md: {len(rows)} posts")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
