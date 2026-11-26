"""Who is the subject of a shared SEC deal filing (DEC-0081 point 4; R2 of the step-2 discovery note).

SC TO-T, SC TO-T/A, SC TO-C, 425 and SC 13E3 are listed in the submissions of both the filer and the subject, under
one accession, and the submissions JSON carries no role. The filing's index page does:

  <span class="companyName">ABIOMED INC (Subject)
   <acronym title="Central Index Key">CIK</acronym>: <a href="/cgi-bin/browse-edgar?CIK=0000815094&...">

`parse_roles` reads those pairs; `RoleCache` fetches a page only once (cached in `data/edgar/roles.json`), paced at
5 requests/s with the same generic User-Agent as the rest of wt.data.edgar, and answers "is this CIK the subject?"
with True, False, or None when the page could not be read (the caller then reads the name as unknown).
"""
from __future__ import annotations

import json
import os
import re
import time
from collections.abc import Callable
from pathlib import Path

import requests

from wt.core.config import DATA_DIR
from wt.data.edgar import UA

CACHE = DATA_DIR / "edgar" / "roles.json"
ARCHIVES = "https://www.sec.gov/Archives/edgar/data/"
MIN_INTERVAL = 0.2
_PAIR = re.compile(r'class="companyName">\s*(?P<name>.*?)\s*\((?P<role>[^()]*)\)\s*'
                   r'<acronym[^>]*>CIK</acronym>:\s*<a[^>]*?CIK=(?P<cik>\d+)', re.S)

Fetch = Callable[[str], "tuple[int, str]"]


def index_url(cik: int, accession: str) -> str:
    return f"{ARCHIVES}{int(cik)}/{accession.replace('-', '')}/{accession}-index.htm"


def parse_roles(html: str) -> list[tuple[int, str]]:
    """(cik, role) for every company block on an index page, e.g. (815094, "Subject"), (200406, "Filed by")."""
    return [(int(m["cik"]), m["role"].strip()) for m in _PAIR.finditer(html)]


class _Http:
    def __init__(self, sleep: Callable[[float], None] = time.sleep) -> None:
        self.s = requests.Session()
        self.s.headers.update(UA)
        self.sleep, self.last = sleep, -1e9

    def __call__(self, url: str) -> tuple[int, str]:
        for wait in (10.0, 30.0, 60.0, None):
            gap = self.last + MIN_INTERVAL - time.monotonic()
            if gap > 0:
                self.sleep(gap)
            self.last = time.monotonic()
            try:
                r = self.s.get(url, timeout=60)
            except requests.RequestException:
                if wait is None:
                    return 0, ""
                self.sleep(wait)
                continue
            if (r.status_code in (429, 403) or r.status_code >= 500) and wait is not None:
                self.sleep(wait)
                continue
            return r.status_code, r.text if r.status_code == 200 else ""
        return 0, ""


class RoleCache:
    """`cache[accession] = [[cik, role], ...]` for every page read; an unreadable page is not cached, so a later run
    tries it again."""

    def __init__(self, path: Path = CACHE, fetch: Fetch | None = None) -> None:
        self.path = path
        self.fetch = fetch or _Http()
        self.data: dict[str, list[list[object]]] = json.loads(path.read_text()) if path.exists() else {}
        self.fetched = 0
        self.unreadable = 0

    def roles(self, accession: str, cik: int) -> list[tuple[int, str]] | None:
        if accession not in self.data:
            status, html = self.fetch(index_url(cik, accession))
            self.fetched += 1
            pairs = parse_roles(html) if status == 200 else []
            if not pairs:
                self.unreadable += 1
                return None
            self.data[accession] = [[c, r] for c, r in pairs]
        return [(int(str(c)), str(r)) for c, r in self.data[accession]]

    def is_subject(self, accession: str, cik: int) -> bool | None:
        pairs = self.roles(accession, cik)
        if pairs is None:
            return None
        return any(c == int(cik) and r.lower() == "subject" for c, r in pairs)

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_name(f".{self.path.name}.tmp{os.getpid()}")
        tmp.write_text(json.dumps(self.data, sort_keys=True))
        os.replace(tmp, self.path)
