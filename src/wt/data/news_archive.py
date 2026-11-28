"""The archive of Alpaca news items (DEC-0003 amendment of 2026-11-26).

Alpaca dropped its Benzinga news history in 2026 (support ticket 402305, answered 2026-11-24): `/v1beta1/news` now
returns only fiscal.ai items, the earliest at 2026-04-29T02:31Z, and nothing before. News had only ever been read at
run time, so no copy of the old history exists. This module keeps one of what the API serves now, so the next change
of provider does not take the history with it.

The copy lives in the PRIVATE repository `Algorythmos-AI/trading-news-archive`, cloned (git-ignored) at
`data/archive/trading-news-archive` (`docs/runbooks/news-archive.md`). Headlines are RESTRICTED (AGENTS.md): they are
never written to this repository, which is public, and this module never prints or logs them. `publish` refuses any
remote other than that private repository.

Layout under the clone (`ROOT_IN_REPO`):
  alpaca-news/YYYY/MM/YYYY-MM-DD.jsonl   one JSON object per item whose `created_at` falls on that New York date,
                                         keys in COLUMNS order, sorted by (created_at, id); byte-identical on a rerun
  alpaca-news/_done/YYYY-MM-DD.json      written last, only when every page of a finished day was read; it carries
                                         the day's item count and the sha256 of its file

A day is fetched as one window (00:00 to 24:00 New York time, all symbols, ascending, 50 a page). Each item is filed
under the New York date of its own `created_at`, so an item the API returns in a neighbouring window still lands on
its own day. Files are merged by item id, keeping the copy with the latest `updated_at`, and written atomically.
"""
from __future__ import annotations

import base64
import datetime as dt
import hashlib
import json
import os
import re
import subprocess
from collections.abc import Callable, Iterable, Mapping
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import pandas as pd

from wt.core.clock import ET, et, to_utc_iso
from wt.core.config import DATA_DIR

NEWS_URL = "https://data.alpaca.markets/v1beta1/news"
FIRST_DAY = dt.date(2026, 4, 28)          # New York date of the earliest item, 2026-04-29T02:31:18Z (22:31 ET)
COLUMNS = ["id", "created_at", "updated_at", "symbols", "headline", "source", "url"]
PAGE = 50
MAX_PAGES = 2000                          # 100,000 items in one day: far above the ~7,600 seen; a loop guard
ARCHIVE_REPO = "Algorythmos-AI/trading-news-archive"
CLONE = DATA_DIR / "archive" / "trading-news-archive"
ROOT_IN_REPO = "alpaca-news"
DEFAULT_ROOT = CLONE / ROOT_IN_REPO

Getter = Callable[[str, dict[str, Any]], Any]
Row = dict[str, Any]


class ArchiveError(RuntimeError):
    """A day could not be read in full, or the archive cannot be published safely; nothing is marked or pushed."""


def day_window(day: dt.date) -> tuple[str, str]:
    """The UTC bounds of one New York calendar day (23 or 25 hours on a DST change)."""
    nxt = day + dt.timedelta(days=1)
    return to_utc_iso(et(day, "00:00")), to_utc_iso(et(nxt, "00:00"))


def _utc(ts: str) -> pd.Timestamp:
    return pd.Timestamp(ts).tz_convert("UTC") if pd.Timestamp(ts).tzinfo else pd.Timestamp(ts).tz_localize("UTC")


def et_date(ts: str) -> dt.date:
    d: dt.date = _utc(ts).tz_convert(ET).date()
    return d


def _row(item: Mapping[str, Any]) -> Row:
    if not isinstance(item, Mapping) or item.get("id") is None or not item.get("created_at"):
        raise ArchiveError("a news item without an id or a created_at")
    syms = item.get("symbols") or []
    if not isinstance(syms, list):
        raise ArchiveError("a news item whose symbols are not a list")
    return {"id": int(item["id"]), "created_at": str(item["created_at"]),
            "updated_at": str(item.get("updated_at") or item["created_at"]),
            "symbols": [str(s) for s in syms], "headline": str(item.get("headline") or ""),
            "source": str(item.get("source") or ""), "url": str(item.get("url") or "")}


def fetch_day(get: Getter, day: dt.date) -> tuple[list[Row], int]:
    """Every item of one New York day, all pages. Raises ArchiveError on a malformed answer or a runaway loop."""
    start, end = day_window(day)
    params: dict[str, Any] = {"start": start, "end": end, "limit": PAGE, "sort": "asc",
                              "include_content": "false"}
    rows: list[Row] = []
    seen_tokens: set[str] = set()
    for pages in range(1, MAX_PAGES + 1):
        body = get(NEWS_URL, dict(params))
        if not isinstance(body, Mapping) or not isinstance(body.get("news"), list):
            raise ArchiveError("a news answer without a list of items")
        rows.extend(_row(i) for i in body["news"])
        token = body.get("next_page_token")
        if not token:
            return rows, pages
        if token in seen_tokens:
            raise ArchiveError("the API repeated a page token")
        seen_tokens.add(str(token))
        params["page_token"] = token
    raise ArchiveError(f"more than {MAX_PAGES} pages in one day")


def day_path(root: Path, day: dt.date) -> Path:
    return root / f"{day:%Y}" / f"{day:%m}" / f"{day.isoformat()}.jsonl"


def marker_path(root: Path, day: dt.date) -> Path:
    return root / "_done" / f"{day.isoformat()}.json"


def _atomic(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp{os.getpid()}")
    try:
        tmp.write_bytes(data)
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            tmp.unlink()


def encode(rows: Iterable[Row]) -> bytes:
    return "".join(json.dumps({k: r[k] for k in COLUMNS}, ensure_ascii=False, separators=(",", ":")) + "\n"
                   for r in rows).encode("utf-8")


def read_day(root: Path, day: dt.date) -> list[Row]:
    p = day_path(root, day)
    if not p.exists():
        return []
    return [json.loads(line) for line in p.read_text(encoding="utf-8").splitlines() if line.strip()]


def load(root: Path, start: dt.date, end: dt.date) -> pd.DataFrame:
    """Every archived item created from `start` to `end` (New York dates, inclusive), as one frame."""
    rows = [r for d in days(start, end) for r in read_day(root, d)]
    return pd.DataFrame(rows, columns=COLUMNS)


def merge(old: Iterable[Row], new: Iterable[Row]) -> list[Row]:
    """Union by id; for a repeated id the copy with the latest updated_at wins (the newest edit)."""
    best: dict[int, Row] = {}
    for r in [*old, *new]:
        cur = best.get(r["id"])
        if cur is None or _utc(r["updated_at"]) >= _utc(cur["updated_at"]):
            best[r["id"]] = r
    return sorted(best.values(), key=lambda r: (_utc(r["created_at"]), r["id"]))


def store(root: Path, rows: Iterable[Row]) -> dict[dt.date, int]:
    """File rows under the New York date of their created_at, merged into what is there. Returns rows per day."""
    by_day: dict[dt.date, list[Row]] = {}
    for r in rows:
        by_day.setdefault(et_date(r["created_at"]), []).append(r)
    counts: dict[dt.date, int] = {}
    for d, rs in sorted(by_day.items()):
        merged = merge(read_day(root, d), rs)
        _atomic(day_path(root, d), encode(merged))
        counts[d] = len(merged)
    return counts


def is_done(root: Path, day: dt.date) -> bool:
    return marker_path(root, day).exists()


def archive_day(get: Getter, root: Path, day: dt.date, now: dt.datetime) -> dict[str, Any]:
    """Fetch one day, store it, and mark it done when the day is over in New York. Returns the marker's content
    (counts only). A day still running (today, or later) is stored but never marked done."""
    rows, pages = fetch_day(get, day)
    touched = store(root, rows)
    finished = now.astimezone(ET).date() > day
    info: dict[str, Any] = {"day": day.isoformat(), "items_fetched": len(rows), "pages": pages,
                            "items_on_day": len(read_day(root, day)), "sha256": _sha(root, day),
                            "complete": finished, "fetched_at": to_utc_iso(now)}
    if finished:
        _write_marker(root, day, info)
    for other in touched:                 # an item filed on a neighbouring date changed that date's file too
        if other != day and is_done(root, other):
            refresh_marker(root, other)
    return info


def _sha(root: Path, day: dt.date) -> str | None:
    p = day_path(root, day)
    return hashlib.sha256(p.read_bytes()).hexdigest() if p.exists() else None


def _write_marker(root: Path, day: dt.date, info: Mapping[str, Any]) -> None:
    _atomic(marker_path(root, day), (json.dumps(dict(info), sort_keys=True, indent=1) + "\n").encode())


def refresh_marker(root: Path, day: dt.date) -> None:
    """Bring a done marker's count and checksum back in line with its day file, keeping the rest of the marker."""
    info = json.loads(marker_path(root, day).read_text())
    info["items_on_day"] = len(read_day(root, day))
    info["sha256"] = _sha(root, day)
    _write_marker(root, day, info)


def days(start: dt.date, end: dt.date) -> list[dt.date]:
    if end < start:
        raise ValueError("the range ends before it starts")
    return [start + dt.timedelta(days=i) for i in range((end - start).days + 1)]


def missing(root: Path, start: dt.date, end: dt.date) -> list[dt.date]:
    return [d for d in days(start, end) if not is_done(root, d)]


def catch_up_range(now: dt.datetime, n: int) -> tuple[dt.date, dt.date]:
    """The last n finished New York days, never before FIRST_DAY."""
    yesterday = now.astimezone(ET).date() - dt.timedelta(days=1)
    return max(FIRST_DAY, yesterday - dt.timedelta(days=n - 1)), yesterday


# ---- publishing to the private archive repository --------------------------------------------------------------------
Runner = Callable[[list[str], Path], str]


def _git(args: list[str], cwd: Path) -> str:
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout


TOKEN_ENV = "NEWS_ARCHIVE_TOKEN"          # host secret: a fine-grained token, contents read/write on ARCHIVE_REPO only
REMOTE = f"https://github.com/{ARCHIVE_REPO}.git"


def git_env(token: str | None, base: Mapping[str, str] | None = None) -> dict[str, str]:
    """The environment for git: with a token, an Authorization header for github.com, passed in GIT_CONFIG_* variables
    so it never appears on a command line (ps) or in the clone's config file; no prompt either way."""
    env = dict(os.environ if base is None else base)
    env.update({"GIT_TERMINAL_PROMPT": "0"})       # a set, not a read: git never waits on a prompt
    if token:
        basic = base64.b64encode(f"x-access-token:{token}".encode()).decode()
        env.update({"GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "http.https://github.com/.extraheader",
                    "GIT_CONFIG_VALUE_0": f"AUTHORIZATION: basic {basic}"})
    return env


def git_runner(token: str | None) -> Runner:
    """A Runner that authenticates with `token` when one is given (the host), and as the user's own git otherwise."""
    env = git_env(token)

    def run(args: list[str], cwd: Path) -> str:
        return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True, env=env).stdout

    return run


def ensure_clone(clone: Path, run: Runner) -> bool:
    """Clone the private archive repository at `clone` if no clone is there. Returns True when it cloned. Refuses a
    non-empty folder that is not a clone (its files would be lost or pushed by mistake)."""
    if (clone / ".git").exists():
        return False
    if clone.exists() and any(clone.iterdir()):
        raise ArchiveError("a folder that is not a clone of the archive is in the way; nothing cloned")
    clone.parent.mkdir(parents=True, exist_ok=True)
    run(["clone", "-q", REMOTE, str(clone)], clone.parent)
    return True


_SCP = re.compile(r"git@github\.com:(?P<path>[^/]+/[^/]+)")


def check_remote(url: str) -> None:
    """Refuse every remote but the private archive repository (the headlines must never reach a public one): the host
    must be exactly github.com and the path exactly the archive repository, in https, ssh or scp-like form."""
    url = url.strip()
    m = _SCP.fullmatch(url)
    if m:
        path = m["path"]
    else:
        u = urlsplit(url)
        if u.scheme not in ("https", "ssh") or (u.hostname or "").lower() != "github.com" or u.port not in (None, 443, 22) \
                or u.query or u.fragment:
            raise ArchiveError("the archive's remote is not the private archive repository; nothing pushed")
        path = u.path.lstrip("/")
    path = path.removesuffix("/").removesuffix(".git")
    if path.lower() != ARCHIVE_REPO.lower():
        raise ArchiveError("the archive's remote is not the private archive repository; nothing pushed")


def _status_unauthenticated(url: str) -> int:
    import urllib.error
    import urllib.request

    req = urllib.request.Request(url, headers={"Accept": "application/vnd.github+json", "User-Agent": "wt-news-archive"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:  # noqa: S310 - fixed https URL
            return int(r.status)
    except urllib.error.HTTPError as e:
        return int(e.code)


def repo_is_public(status: Callable[[str], int] = _status_unauthenticated) -> bool:
    """Whether anyone can read the archive repository. Asked without credentials: GitHub answers 404 for a private
    repository and 200 for a public one. Anything else (rate limit, outage) raises, so a push waits for a clear answer.
    Alpaca's data may not be redistributed (DEC-0081, owner note 2026-11-28): a public archive would redistribute it."""
    try:
        code = status(f"https://api.github.com/repos/{ARCHIVE_REPO}")
    except OSError as e:
        raise ArchiveError(f"could not confirm the archive repository is private ({type(e).__name__})") from e
    if code == 404:
        return False
    if code == 200:
        return True
    raise ArchiveError(f"could not confirm the archive repository is private (HTTP {code})")


def publish(clone: Path, message: str, run: Runner = _git, folder: str = ROOT_IN_REPO,
            is_public: Callable[[], bool] | None = None) -> bool:
    """Commit one folder of the clone (the news archive by default) and push it. Returns False when there was nothing
    to commit (without asking GitHub). Refuses, before it commits anything, unless the archive repository is private (`repo_is_public` by default)."""
    if folder.startswith("/") or ".." in Path(folder).parts:
        raise ArchiveError("the folder must be a path inside the clone")
    if not (clone / ".git").exists():
        raise ArchiveError("no clone of the archive repository there (docs/runbooks/news-archive.md)")
    # Every URL git would fetch from or push to (pushurl wins over url for a push; insteadOf rules are applied).
    urls = [*run(["remote", "get-url", "--all", "origin"], clone).splitlines(),
            *run(["remote", "get-url", "--push", "--all", "origin"], clone).splitlines()]
    if not [u for u in urls if u.strip()]:
        raise ArchiveError("the archive clone has no origin; nothing pushed")
    for u in urls:
        if u.strip():
            check_remote(u)
    run(["add", "--", folder], clone)
    if not run(["status", "--porcelain", "--", folder], clone).strip():
        return False                                  # nothing to send, so no need to ask GitHub
    if (is_public or repo_is_public)():
        raise ArchiveError(f"{ARCHIVE_REPO} is public; nothing pushed (Alpaca data may not be redistributed)")
    who = ["-c", "user.name=skalaliya", "-c", "user.email=skalaliya@gmail.com"]   # the host's git has no identity
    run([*who, "commit", "-q", "-m", message, "--", folder], clone)
    run([*who, "pull", "-q", "--rebase", "origin", "main"], clone)   # another writer may have pushed first; a
    # rebase replays this commit, so it needs a committer identity too
    run(["push", "-q", "origin", "HEAD:main"], clone)
    return True
