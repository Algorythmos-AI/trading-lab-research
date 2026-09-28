"""Shared synthetic-bar builders for SPEC-0001 tests. 2024-03-01 is in EST, so 09:30 ET = 14:30 UTC."""
import pandas as pd

DAY = "2024-03-01"


def minute_bars(rows, start_et="09:30", day=DAY):
    """rows: (o, h, l, c, v) at consecutive minutes from start_et (ET)."""
    t0 = pd.Timestamp(f"{day} {start_et}", tz="America/New_York").tz_convert("UTC")
    t = pd.date_range(t0, periods=len(rows), freq="1min")
    o, h, l, c, v = zip(*rows) if rows else ((), (), (), (), ())
    return pd.DataFrame({"t": t, "o": o, "h": h, "l": l, "c": c, "v": v})


def flat(n, px=5.0, v=50_000, spread=0.02):
    return [(px, px + spread, px - spread, px, v)] * n
