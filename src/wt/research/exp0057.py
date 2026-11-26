"""EXP-0057 phase 1: agreement of the EDGAR proxy with classifier v3 on fiscal.ai headlines (DEC-0081 point 6).

Per (name, session) it pairs a pool's own catalyst columns (classifier v3 on the headlines, as the pool was built)
with the sidecar the annotator wrote, drops `unknown` name-days (counted), and reports:

  buyout_recall     share of v3 buyout_offer name-days the proxy reads as buyout       (pass: >= 0.80 on >= 20)
  earnings_recall   share of v3 earnings_release name-days the proxy reads as earnings (pass: >= 0.80 on >= 20)
  reported only     the two precisions, presence agreement (any headline vs any proxy filing), and the median lag in
                    minutes from the first qualifying headline to the earnings filing, on name-days where both agree

Each share comes with a Wilson 95% interval. This is agreement with classifier v3 (84% on Benzinga, EXP-0015a),
not accuracy. Counts only: the report has no price, entry, exit or result field, and `check_schema` enforces it.
"""
from __future__ import annotations

import math
import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Any

import pandas as pd

RECALL_MIN = 0.80
MIN_NAME_DAYS = 20
Z95 = 1.959963984540054
FORBIDDEN = re.compile(r"(^|_)(r|pnl|p_l|return|returns|profit|loss|price|entry|exit|equity)(_|$)", re.I)


@dataclass(frozen=True)
class Share:
    hits: int
    n: int

    @property
    def value(self) -> float | None:
        return self.hits / self.n if self.n else None

    def wilson(self) -> tuple[float, float] | None:
        if not self.n:
            return None
        p, n, z = self.hits / self.n, self.n, Z95
        mid = (p + z * z / (2 * n)) / (1 + z * z / n)
        half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / (1 + z * z / n)
        return max(0.0, mid - half), min(1.0, mid + half)

    def as_dict(self) -> dict[str, Any]:
        ci = self.wilson()
        return {"hits": self.hits, "n": self.n, "share": self.value,
                "wilson95": list(ci) if ci else None}


def pair(pool: pd.DataFrame, side: pd.DataFrame) -> pd.DataFrame:
    """One row per pool name with both readings; the pool's order and length are kept (a missing sidecar row is an
    error, never a silent drop)."""
    cols = ["symbol", "catalyst_status", "catalyst_category", "headlines_n", "first_catalyst_at"]
    m = pool[cols].merge(side[["symbol", "edgar_category", "edgar_first_at"]], on="symbol", how="left",
                         validate="one_to_one")
    if m.edgar_category.isna().any():
        raise ValueError("a pool name has no sidecar row: run the annotator on that day again")
    return m


def _minutes(later: object, earlier: object) -> float | None:
    if not later or not earlier or pd.isna(later) or pd.isna(earlier):
        return None
    return float((pd.Timestamp(str(later)) - pd.Timestamp(str(earlier))).total_seconds() / 60.0)


def measure(days: Iterable[pd.DataFrame]) -> dict[str, Any]:
    """The phase-1 report from paired days (each the output of `pair`)."""
    frames = list(days)
    cols = ["symbol", "catalyst_status", "catalyst_category", "headlines_n", "first_catalyst_at", "edgar_category",
            "edgar_first_at"]
    allrows = pd.concat(frames, ignore_index=True) if frames else pd.DataFrame(columns=cols)
    total = len(allrows)
    unknown = int((allrows.edgar_category == "unknown").sum())
    rows = allrows[allrows.edgar_category != "unknown"]
    v3_buy = rows.catalyst_category == "buyout_offer"
    v3_earn = rows.catalyst_category == "earnings_release"
    px_buy = rows.edgar_category == "buyout"
    px_earn = rows.edgar_category == "earnings"
    buyout_recall = Share(int((v3_buy & px_buy).sum()), int(v3_buy.sum()))
    earnings_recall = Share(int((v3_earn & px_earn).sum()), int(v3_earn.sum()))
    lags = [x for x in (_minutes(a, b) for a, b in
                        zip(rows.edgar_first_at[v3_earn & px_earn], rows.first_catalyst_at[v3_earn & px_earn], strict=True))
            if x is not None]
    presence = (rows.headlines_n > 0) == (rows.edgar_category != "none")
    report: dict[str, Any] = {
        "name_days": total, "unknown_name_days": unknown, "compared_name_days": int(len(rows)),
        "buyout_recall": buyout_recall.as_dict(),
        "earnings_recall": earnings_recall.as_dict(),
        "buyout_precision": Share(int((v3_buy & px_buy).sum()), int(px_buy.sum())).as_dict(),
        "earnings_precision": Share(int((v3_earn & px_earn).sum()), int(px_earn.sum())).as_dict(),
        "presence_agreement": Share(int(presence.sum()), int(len(rows))).as_dict(),
        "median_lag_minutes": float(pd.Series(lags).median()) if lags else None, "lag_n": len(lags),
        "verdict": verdict(buyout_recall, earnings_recall),
        "thresholds": {"recall_min": RECALL_MIN, "min_name_days": MIN_NAME_DAYS},
        "reference": "agreement with classifier v3 on fiscal.ai headlines, not accuracy",
    }
    check_schema(report)
    return report


def verdict(buyout: Share, earnings: Share) -> str:
    if buyout.n < MIN_NAME_DAYS or earnings.n < MIN_NAME_DAYS:
        return "not_decidable"
    ok = (buyout.value or 0.0) >= RECALL_MIN and (earnings.value or 0.0) >= RECALL_MIN
    return "pass" if ok else "fail"


def check_schema(obj: object, path: str = "") -> None:
    """Refuse any key that names a price or a result (AGENTS rule 2: this report carries counts only)."""
    if isinstance(obj, Mapping):
        for k, v in obj.items():
            if FORBIDDEN.search(str(k)):
                raise ValueError(f"a result-like field in a counts-only report: {path}{k}")
            check_schema(v, f"{path}{k}.")
    elif isinstance(obj, list):
        for v in obj:
            check_schema(v, path)


def accepted(decision_text: str) -> bool:
    """True when the record's status line reads ACCEPTED (DEC-0081: no count before acceptance)."""
    for line in decision_text.splitlines():
        if line.lstrip("- ").startswith("**Status:"):
            return "ACCEPTED" in line.split(".")[0]
    return False
