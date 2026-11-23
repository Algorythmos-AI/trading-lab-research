"""DEC-0073: how often each kill trigger of the stock desk can fire before its stop date, by simulation.

Inputs are counts only: the fill rate of EXP-0053 before_switch_on_counts.json (3 fills in 40 pools) and the NYSE
sessions from 2026-11-23 to 2027-03-31. The R of a trade is a stated model, not a measured one: no Gap Hunter trade
existed when this was written. Three outcomes: a loser near -1.05R (the stop and its slip), a scratch near +0.5R
(half at the first target, the rest at breakeven), a runner near +2.5R. Two ways to reach a given mean:

  reweight  the outcomes keep their values and their weights move (losers never lose more than the stop): the main case
  shift     the weights stay (0.50, 0.35, 0.15) and every value moves by the same amount: losers can lose more than
            the stop, so its loss lines fire more often; shown as the upper end of a range

Run: python research/experiments/EXP-0053-gap-hunter-paper-book/kill_power.py
"""
from __future__ import annotations

import datetime as dt

import numpy as np

HOLIDAYS = {dt.date(2026, 11, 26), dt.date(2026, 12, 25), dt.date(2027, 1, 1), dt.date(2027, 1, 18),
            dt.date(2027, 2, 15), dt.date(2027, 3, 26)}
VALUES = np.array([-1.05, 0.5, 2.5])            # loser, scratch, runner
SHIFT_P = np.array([0.50, 0.35, 0.15])
RATES = {"3 in 40 (the counts)": 3 / 40, "1 in 40 (low)": 1 / 40, "7.75 in 40 (95% upper bound of 3)": 7.75 / 40}
MEANS = (-0.5, -0.25, 0.0, 0.25)
SIMS = 4000


def sessions(start: dt.date = dt.date(2026, 11, 23), end: dt.date = dt.date(2027, 3, 31)) -> int:
    n, d = 0, start
    while d <= end:
        n += d.weekday() < 5 and d not in HOLIDAYS
        d += dt.timedelta(days=1)
    return n


def reweight_p(mu: float) -> np.ndarray:
    """Weights of the three outcomes with mean `mu`: the runner share moves with the mean, the loser share solves it."""
    pw = 0.15 + 0.2 * mu
    pl = (0.5 + 2.0 * pw - mu) / 1.55
    p = np.array([pl, 1 - pl - pw, pw])
    assert (p > 0).all() and abs(p @ VALUES - mu) < 1e-9
    return p


def draw(rng: np.random.Generator, model: str, mu: float, k: int) -> np.ndarray:
    if model == "reweight":
        return rng.choice(VALUES, size=k, p=reweight_p(mu))
    return rng.choice(VALUES, size=k, p=SHIFT_P) + (mu - float(SHIFT_P @ VALUES))


def sd(model: str, mu: float) -> float:
    p = reweight_p(mu) if model == "reweight" else SHIFT_P
    m = float(p @ VALUES)
    return float(np.sqrt(p @ (VALUES - m) ** 2))


def run(rng: np.random.Generator, model: str, mu: float, lam: float, n: int) -> dict[str, float]:
    s0 = sd(model, 0.0)
    a = np.log((1 - 0.2) / 0.05)                # SPRT, alpha 5%, power 80%: H0 mean 0 against H1 mean -0.5
    hits = {"trades": 0.0, "minus6": 0.0, "minus3": 0.0, "review30": 0.0, "sprt": 0.0}
    for _ in range(SIMS):
        k = int(rng.poisson(lam * n))
        hits["trades"] += k
        hits["review30"] += k >= 30
        if not k:
            continue
        r = draw(rng, model, mu, k)
        c = np.cumsum(r)
        hits["minus6"] += c.min() <= -6.0 + 1e-9
        hits["minus3"] += c.min() <= -3.0 + 1e-9
        llr = np.cumsum((r ** 2 - (r + 0.5) ** 2) / (2 * s0 * s0))
        hits["sprt"] += bool((llr >= a).any())
    return {k: v / SIMS for k, v in hits.items()}


def main() -> None:
    n = sessions()
    rng = np.random.default_rng(20261123)
    print(f"sessions 2026-11-23 to 2027-03-31: {n}")
    for name, lam in RATES.items():
        k = rng.poisson(lam * n, 100000)
        print(f"\nfill rate {name}: {lam:.3f} a session, trades by the date mean {lam * n:.1f} "
              f"(90% {np.percentile(k, 5):.0f} to {np.percentile(k, 95):.0f})")
        for mu in MEANS:
            rw, sh = run(rng, "reweight", mu, lam, n), run(rng, "shift", mu, lam, n)
            print(f"  mean {mu:+.2f}R | -6R fires {rw['minus6']:.2f} (shift {sh['minus6']:.2f}) | "
                  f"-3R would fire {rw['minus3']:.2f} (shift {sh['minus3']:.2f}) | 30-trade review reached "
                  f"{rw['review30']:.2f} | SPRT fires {rw['sprt']:.2f} (shift {sh['sprt']:.2f})")
    s0 = sd("reweight", 0.0)
    a = np.log((1 - 0.2) / 0.05)
    print(f"\nR sd at a mean of 0: {s0:.2f} (shift model {sd('shift', 0.0):.2f})")
    print(f"standard error of mean R at 6 trades: {s0 / np.sqrt(6):.2f}; trades for 0.15R: {(s0 / 0.15) ** 2:.0f}")
    print(f"SPRT average trades to decide when the mean is -0.5R (Wald): {a / (0.5 ** 2 / (2 * s0 * s0)):.0f}")


if __name__ == "__main__":
    main()
