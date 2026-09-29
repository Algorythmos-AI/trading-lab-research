"""Data-quality invariants every loader enforces (audit R-C1).

The ETF minute cache held 46,800 duplicated (symbol, t) rows: each month file also contained the first trading day
of the next month. Strategy B counts bars by position, so on those days signals fired at the wrong times and the
14-day sigma was wrong. Loaders now drop exact duplicates and then assert uniqueness. A duplicate that survives
is a bug and fails loudly, rather than silently biasing a backtest.
"""
from __future__ import annotations

import pandas as pd


class DataQualityError(ValueError):
    pass


def assert_unique(df: pd.DataFrame, keys: list[str], what: str = "frame") -> pd.DataFrame:
    """Raise if any key combination repeats. Returns df unchanged, so it can be used inline."""
    if len(df) and df.duplicated(subset=keys).any():
        dup = df[df.duplicated(subset=keys, keep=False)].sort_values(keys).head(6)
        raise DataQualityError(f"{what}: {int(df.duplicated(subset=keys).sum())} duplicate rows on {keys}; "
                               f"first: {dup[keys].to_dict(orient='records')}")
    return df


def dedupe(df: pd.DataFrame, keys: list[str], what: str = "frame", keep: str = "last") -> pd.DataFrame:
    """Drop rows repeated on `keys` (keeping `keep`), then assert uniqueness."""
    out = df.drop_duplicates(subset=keys, keep=keep)  # type: ignore[arg-type]
    return assert_unique(out, keys, what)
