"""Day-level portfolio admission for SPEC-0001 trials (RSK-01..RSK-07; plan D4, D5).

Two passes per trial per day:
  1. Each signal chain (a symbol's attempts) is simulated with the full account as the cash ceiling. This gives
     entry and exit times.
  2. Candidates are admitted in entry-time order. Ties go to the funnel priority (the primary first).
     A candidate is blocked if the trades that EXITED before its entry show 3 consecutive losers or a realised
     day R <= -2. Otherwise it is re-simulated with the settled cash still available: a cash account can't
     reuse today's sale proceeds before T+1, so every entry uses up its notional for the rest of the day. It
     is skipped (and counted) if that cash buys less than 1 share.
A chain's later attempt is dropped when its earlier attempt was not admitted, because the attempt only
exists after that trade.
Trades are simulated independently of each other; admission only decides which happen and at what size.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable


@dataclass
class Candidate:
    chain: str                          # e.g. "ACME" (one chain of attempts per symbol per trial)
    attempt: int                        # 1, 2
    priority: int                       # lower = funded first when entries coincide (tier-3 primary = 0)
    entry_time: object                  # comparable timestamp from pass 1
    resim: Callable[[float, float], tuple]   # (cash, risk_dollars) -> (Trade | None, R | None)


@dataclass
class DayResult:
    admitted: list = field(default_factory=list)          # (Candidate, Trade, R)
    skipped: list = field(default_factory=list)           # (Candidate, reason)


def admit_day(cands: list[Candidate], equity: float, max_consecutive_losers: int = 3,
              max_daily_loss_R: float = 2.0, risk_pct: float = 1.0) -> DayResult:
    res = DayResult()
    cash_used = 0.0
    admitted_chains: dict[str, int] = {}
    for cand in sorted(cands, key=lambda c: (c.entry_time, c.priority, c.chain, c.attempt)):
        if cand.attempt > 1 and admitted_chains.get(cand.chain, 0) < cand.attempt - 1:
            res.skipped.append((cand, "earlier_attempt_not_admitted"))
            continue
        done = sorted(((t.exits[-1][0], r) for _, t, r in res.admitted if t.exits and t.exits[-1][0] <= cand.entry_time),
                      key=lambda x: x[0])
        rs = [r for _, r in done]
        streak = 0
        for r in reversed(rs):
            if r < 0:
                streak += 1
            else:
                break
        if streak >= max_consecutive_losers:
            res.skipped.append((cand, "day_stop_consecutive_losers"))
            continue
        if sum(rs) <= -max_daily_loss_R:
            res.skipped.append((cand, "day_stop_loss_R"))
            continue
        avail = equity - cash_used
        tr, r = cand.resim(avail, equity * risk_pct / 100)
        if tr is None:
            res.skipped.append((cand, "unfunded"))
            continue
        cash_used += tr.qty * tr.entry
        admitted_chains[cand.chain] = admitted_chains.get(cand.chain, 0) + 1
        res.admitted.append((cand, tr, r))
    return res
