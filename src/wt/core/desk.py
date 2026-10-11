"""Desks (ADR 0005): the things that differ between one desk and another, in one place.

A desk owns its runtime state, kill switch, journal, alert keys and snapshot. The host, the job runner, deploys,
alert delivery and backups are shared. `stocks` names the paths the lab has always used, so nothing moves.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from wt.core.config import DATA_DIR, FORWARD_LEDGER, ROOT, STATE_DIR

Session = Literal["us_equity", "always_open"]


@dataclass(frozen=True)
class Desk:
    name: str
    strategy: str                       # the key in config/risk.yaml and the tag in order ids
    state_dir: Path
    kill_file: Path                     # while it exists the desk makes no new entries; exits are still managed
    ledgers: tuple[tuple[str, Path], ...]   # (name in the backup anchor, hash-chained file); file names are unique
    chain_flag: Path                    # written by the backup when one of the ledgers' chains is broken
    session: Session
    alert_prefix: str | None            # alert keys that belong to this desk; None = every key no other desk owns
    snapshot_schema: str

    @property
    def journal(self) -> Path:
        return self.ledgers[-1][1]


DESKS: dict[str, Desk] = {d.name: d for d in (
    Desk("stocks", "B", STATE_DIR, ROOT / "KILL",
         (("forward", FORWARD_LEDGER), ("paper", DATA_DIR / "live" / "journal.jsonl")),
         STATE_DIR / "evidence" / "chain-broken", "us_equity", None, "trading-lab/snapshot"),
)}


@dataclass(frozen=True)
class Retired:
    """A desk that ran from this checkout and left for a repository of its own (ADR 0005, addendum).

    Nothing here runs it any more, so nothing here will ever resolve an alert it left firing or write over the
    last heartbeat of one of its jobs. Both would otherwise be read as the stocks desk's, which owns every key
    and every job no other desk claims. What is listed here is dropped instead of shown."""
    name: str
    alert_prefix: str                   # the keys the desk itself raised
    jobs: tuple[str, ...]               # its jobs: `job:<name>` and `refuse:<name>:<day>` keys, and heartbeats
    alert_keys: tuple[str, ...] = ()    # shared-layer keys that existed only for it


RETIRED: tuple[Retired, ...] = (
    # Left for Algorythmos-AI/crypto-lab (research/MOVED.md). `deploy-ml` was the deploy's notice about the
    # machine-learning environment, which only this desk used.
    Retired("crypto", "crypto:", ("crypto", "dashboard-crypto", "crypto-challengers", "crypto-learn"), ("deploy-ml",)),
)


def retired_job(name: str) -> bool:
    """Was this a job of a desk that has left?"""
    return any(name in r.jobs for r in RETIRED)


def retired_alert(key: str) -> bool:
    """Is this alert key a leftover of a desk that has left? Nothing in this checkout can resolve it."""
    return any(key.startswith(r.alert_prefix) or key in r.alert_keys
               or any(key == f"job:{j}" or key.startswith(f"refuse:{j}:") for j in r.jobs) for r in RETIRED)


def desk_of_alert(key: str) -> str | None:
    """The desk an alert key belongs to: the one whose prefix it carries, else `stocks`. None for a leftover of a
    desk that has left: it belongs to no desk here."""
    if retired_alert(key):
        return None
    for d in DESKS.values():
        if d.alert_prefix and key.startswith(d.alert_prefix):
            return d.name
    return "stocks"


def installed(desk: Desk) -> bool:
    """A desk exists on this host once its state directory does (a new desk before its first run does not)."""
    return desk.name == "stocks" or desk.state_dir.is_dir()
