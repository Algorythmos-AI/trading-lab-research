"""Build the Trading Lab status dashboard: seven section documents plus a self-contained page.

Read-only by construction: it reads the research checkout, the live checkout (never written), the
org checkout, GitHub (gh), launchctl, pmset and disk usage, and writes only under --out.

Usage (from the research checkout):
  PYTHONDONTWRITEBYTECODE=1 ~/trading/.venv/bin/python scripts/status_dashboard.py [--no-github] [--with-account]

Writes var/dashboard/ (git-ignored runtime state):
  docs/<section>.json   the seven documents the published page reads from its database
  index.html            the page with the same data inlined (opens locally, no network needed)
  status.json           all documents together
  last_error.json       only after a failed run: {last_error, last_attempt}
  cache/, refresh.log   last good result per source; one line per run

Exit codes: 0 all sources fresh · 1 some sources failed or stale, documents still written ·
            2 fatal, nothing written · 3 another run holds the lock
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import shutil
import sys
import time
import traceback
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

import yaml  # noqa: E402

from wt.ops import assemble, safeio, status  # noqa: E402

TEMPLATE = ROOT / "src/wt/ops/dashboard.html"
PLACEHOLDER = "/*__SNAPSHOT__*/null"


def expand(p: str | Path) -> Path:
    q = Path(p).expanduser()
    return q if q.is_absolute() else ROOT / q


def render_page(docs: dict, template: Path = TEMPLATE) -> str:
    html = template.read_text(encoding="utf-8")
    if PLACEHOLDER not in html:
        raise ValueError("page template has no snapshot placeholder")
    blob = json.dumps(docs, ensure_ascii=False, separators=(",", ":"), default=str)
    blob = blob.replace("</", "<\\/").replace("<!--", "<\\u0021--")   # stays inside its <script> element
    return html.replace(PLACEHOLDER, blob, 1)


def collector_info() -> dict:
    info = {"branch": None, "sha": None, "dirty": None}
    try:
        info["sha"] = safeio.run(["git", "--no-optional-locks", "-C", str(ROOT), "rev-parse", "--short", "HEAD"], 10).strip()
        info["branch"] = safeio.run(["git", "--no-optional-locks", "-C", str(ROOT), "rev-parse", "--abbrev-ref", "HEAD"], 10).strip()
        info["dirty"] = bool(safeio.run(["git", "--no-optional-locks", "-C", str(ROOT), "status", "--porcelain", "--untracked-files=no"], 10).strip())
    except safeio.SourceError:
        pass
    return info


def build(args: argparse.Namespace, cfg: dict, out: Path, deployed: Path) -> int:
    t0 = time.monotonic()
    now = dt.datetime.now(dt.UTC).replace(microsecond=0)
    run_id = now.strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:6]
    paths = cfg["paths"]
    ctx = status.Ctx(cfg=cfg, root=expand(paths.get("research_root", ".")), deployed=deployed,
                     org=expand(paths["org_root"]), old=expand(paths["old_root"]), out=out, now=now,
                     github=not args.no_github, with_account=args.with_account, deadline=t0 + args.deadline)
    sources = {}
    for name, fn in status.SOURCES.items():
        if name == "account" and not args.with_account:
            continue
        sources[name] = status.collect(name, fn, ctx)
    # The refresh loop mirrors the review page's labels into inputs/ before each run; consume them once.
    shutil.rmtree(safeio.confined(out / "inputs/review_labels", out), ignore_errors=True)
    docs = assemble.build_docs(sources, cfg, now, run_id, time.monotonic() - t0, collector_info())
    redact = safeio.Redactor(safeio.env_secret_values([expand(f) for f in paths.get("env_files", [])]))
    docs = {k: assemble.shrink(redact(v)) for k, v in docs.items()}
    problems = assemble.validate(docs)
    if problems:
        raise ValueError("invalid documents: " + "; ".join(problems[:6]))
    code = 0 if all(s["ok"] and not s["stale"] for s in sources.values()) else 1
    docs["meta"]["exit_code"] = code
    for name, d in docs.items():
        safeio.atomic_write(out / "docs" / f"{name}.json", json.dumps(d, ensure_ascii=False, separators=(",", ":")), out)
    safeio.atomic_write(out / "status.json", json.dumps(docs, ensure_ascii=False, indent=1), out)
    safeio.atomic_write(out / "index.html", render_page(docs), out)
    err = out / "last_error.json"
    if err.exists():
        err.unlink()
    bad = {n: s["error"] for n, s in sources.items() if s.get("error")}
    line = f"{now.isoformat()} run={run_id} exit={code} {time.monotonic() - t0:.1f}s " + \
           (" ".join(f"{n}:{'stale' if sources[n]['stale'] else 'fail'}" for n in bad) or "all-fresh")
    safeio.append_capped(out / "refresh.log", line, out)
    print(line)
    for n, e in bad.items():
        print(f"  {n}: {e}")
    return code


def fail(out: Path | None, msg: str, code: int) -> int:
    print(msg, file=sys.stderr)
    if out is not None:
        now = dt.datetime.now(dt.UTC).replace(microsecond=0).isoformat()
        try:
            safeio.atomic_write(out / "last_error.json", json.dumps({"last_error": msg[:400], "last_attempt": now}), out)
            safeio.append_capped(out / "refresh.log", f"{now} exit={code} {msg[:300]}", out)
        except OSError:
            pass
    return code


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--config", default=str(ROOT / "config/dashboard.yaml"))
    ap.add_argument("--out", default="var/dashboard", help="default: var/dashboard (runtime state, ADR 0002)")
    ap.add_argument("--no-github", action="store_true", help="skip GitHub; those sources come from the cache")
    ap.add_argument("--with-account", action="store_true", help="include a read-only Alpaca paper account snapshot")
    ap.add_argument("--deadline", type=float, default=120.0, help="seconds for the whole run")
    args = ap.parse_args(argv)
    try:
        cfg = yaml.safe_load(Path(args.config).read_text())
        deployed = expand(cfg["paths"]["deployed_root"])
        out = safeio.guard_out_dir(expand(args.out), [deployed], allowed=[deployed / "var" / "dashboard"])
    except (OSError, yaml.YAMLError, KeyError, TypeError, PermissionError) as e:
        return fail(None, f"configuration error: {e}", 2)
    out.mkdir(parents=True, exist_ok=True)
    try:
        with safeio.run_lock(out / ".lock", out):
            return build(args, cfg, out, deployed)
    except safeio.Locked:
        print("another dashboard run holds the lock", file=sys.stderr)
        return 3
    except Exception as e:  # noqa: BLE001 - report, never leave a half-written output
        traceback.print_exc()
        return fail(out, f"{type(e).__name__}: {e}", 2)


if __name__ == "__main__":
    sys.exit(main())
