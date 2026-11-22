"""The focus names the options clone may take: the desk's names only (DEC-0070 section 8).

The clone trades the desk's list (DEC-0030). After the Radar → Options switch (DEC-0048) the published focus may hold a
name the desk does not; this module leaves such a name out before `wt.options.session.names` ranks and caps the focus,
for the clone's runner and the pipeline check's copy of its choice alike. It lives apart from `wt.options.session`,
which EXP-0037's replay pins byte for byte (scripts/exp0037_replay.py ENGINE_FILES).
"""
from __future__ import annotations

from collections.abc import Collection, Mapping
from typing import Any

from wt.core.config import load_yaml


def desk_names(desk_cfg: Any) -> list[str]:
    """The desk's names from `config/options_desk.yaml`'s parsed content, upper-cased, in order, no repeats; empty
    when it holds no readable list (then no focus name is taken)."""
    raw = desk_cfg.get("names") if isinstance(desk_cfg, Mapping) else None
    return list(dict.fromkeys(str(x).upper() for x in raw if isinstance(x, str))) if isinstance(raw, list) else []


def read_desk() -> list[str]:
    """The desk's names from the repository's config; empty when the file cannot be read."""
    try:
        return desk_names(load_yaml("options_desk.yaml"))
    except (OSError, ValueError):
        return []


def on_desk(focus: Mapping[str, Any] | None, desk: Collection[str]) -> tuple[Mapping[str, Any] | None, list[str]]:
    """(the focus block with only the desk's names, the names left out in rank order). Items keep their own rank,
    so `session.names` orders what is left as before; a block with nothing left has no items (its fallback)."""
    if not isinstance(focus, Mapping) or not isinstance(focus.get("items"), list):
        return focus, []
    allowed = {str(x).upper() for x in desk}
    items = [i for i in focus["items"] if isinstance(i, Mapping)]
    keep = [i for i in items if isinstance(i.get("symbol"), str) and i["symbol"].upper() in allowed]
    out = [i for i in items if isinstance(i.get("symbol"), str) and i["symbol"].upper() not in allowed]
    out.sort(key=lambda i: int(i.get("rank") or 99))
    return {**focus, "items": keep}, list(dict.fromkeys(str(i["symbol"]).upper() for i in out))
