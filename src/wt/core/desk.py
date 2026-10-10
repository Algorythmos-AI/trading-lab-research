"""Desks (ADR 0005): the things that differ between the stocks desk and the crypto desk, in one place.

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


CRYPTO_DIR = STATE_DIR / "crypto"

DESKS: dict[str, Desk] = {d.name: d for d in (
    Desk("stocks", "B", STATE_DIR, ROOT / "KILL",
         (("forward", FORWARD_LEDGER), ("paper", DATA_DIR / "live" / "journal.jsonl")),
         STATE_DIR / "evidence" / "chain-broken", "us_equity", None, "trading-lab/snapshot"),
    # Its journal has its own file name: the restore test finds ledgers by name, and two `journal.jsonl` would
    # shadow each other. The data harvest's journal (DEC-0027, wt.crypto.harvest) is listed first so the backup
    # checks and anchors it too; the desk's own journal stays last, which is what `journal` returns.
    Desk("crypto", "C", CRYPTO_DIR, CRYPTO_DIR / "KILL",
         (("crypto-harvest", CRYPTO_DIR / "harvest" / "harvest_journal.jsonl"),
          ("crypto", CRYPTO_DIR / "crypto_journal.jsonl")),
         CRYPTO_DIR / "chain-broken", "always_open", "crypto:", "trading-lab/crypto-snapshot"),
)}


def desk_of_alert(key: str) -> str:
    """The desk an alert key belongs to: the one whose prefix it carries, else `stocks`."""
    for d in DESKS.values():
        if d.alert_prefix and key.startswith(d.alert_prefix):
            return d.name
    return "stocks"


def moved_marker(desk: Desk) -> Path:
    """The file that says a desk now runs from a repository of its own: `<state directory>.MOVED`, beside the state
    directory and not inside it, because the directory itself is moved away. For the crypto desk: `var/crypto.MOVED`."""
    return desk.state_dir.with_name(desk.state_dir.name + ".MOVED")


def moved(desk: Desk) -> bool:
    """Has this desk left this checkout? The stocks desk cannot: it is what this repository is."""
    return desk.name != "stocks" and moved_marker(desk).exists()


def installed(desk: Desk) -> bool:
    """A desk exists on this host once its state directory does (the crypto desk before its first run does not).
    A desk that has moved is not installed here, whatever is left of its directory."""
    return desk.name == "stocks" or (desk.state_dir.is_dir() and not moved(desk))
