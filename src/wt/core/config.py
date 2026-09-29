"""Configuration loading. Secrets come only from .env; tunables from config/*.yaml."""
from __future__ import annotations

import os
from pathlib import Path

import yaml
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[3]
load_dotenv(ROOT / ".env")
# On the Linux VM the secrets live in a tmpfs file written at boot (ADR 0004); systemd passes it as
# EnvironmentFile and names it here, so interactive commands (bin/wt) see the same values.
if os.environ.get("WT_ENV_FILE"):
    load_dotenv(os.environ["WT_ENV_FILE"], override=False)

DATA_DIR = ROOT / "data"
CONFIG_DIR = ROOT / "config"

# Runtime state written by the nightly jobs (ADR 0002). Git-ignored, so `git pull --ff-only` on the live checkout
# can never collide with a file a job is writing. Evidence reaches git only as immutable archive copies, via PRs.
STATE_DIR = Path(os.environ.get("WT_STATE") or ROOT / "var")
FORWARD_LEDGER = STATE_DIR / "forward" / "forward_trades.jsonl"
ROUTINE_DIR = STATE_DIR / "routine"
FORWARD_WATCHLIST_DIR = STATE_DIR / "watchlist"
SCORECARD_DIR = STATE_DIR / "scorecards"


def env(name: str, default: str | None = None) -> str:
    val = os.environ.get(name, default)
    if val is None:
        raise KeyError(f"missing required env var {name}")
    return val


def load_yaml(name: str) -> dict:
    with open(CONFIG_DIR / name) as f:
        return yaml.safe_load(f)
