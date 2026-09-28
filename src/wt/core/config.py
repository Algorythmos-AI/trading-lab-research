"""Configuration loading. Secrets come only from .env; tunables from config/*.yaml."""
from __future__ import annotations

import os
from pathlib import Path

import yaml
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[3]
load_dotenv(ROOT / ".env")

DATA_DIR = ROOT / "data"
CONFIG_DIR = ROOT / "config"


def env(name: str, default: str | None = None) -> str:
    val = os.environ.get(name, default)
    if val is None:
        raise KeyError(f"missing required env var {name}")
    return val


def load_yaml(name: str) -> dict:
    with open(CONFIG_DIR / name) as f:
        return yaml.safe_load(f)
