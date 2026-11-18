"""EXP-0042: Robot B audit diagnostics (DEC-0061). Reads committed evidence only; see the experiment's config.yaml.

Usage:
  python scripts/b_audit.py            run and write research/experiments/EXP-0042-b-audit-diagnostics/results.json
  python scripts/b_audit.py --check    fail if the committed results.json differs from a fresh run (byte for byte)

The run fails (exit 2) when a recorded figure named under `reconcile` in config.yaml does not reproduce.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from wt.research import b_audit as ba  # noqa: E402
from wt.research.trials import global_trial_count, trial_history  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
EXP = ROOT / "research/experiments/EXP-0042-b-audit-diagnostics"


class ReconcileError(RuntimeError):
    pass


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def paper_aggregate(text: str) -> dict[str, float | int]:
    """The published scorecard's paper line: sessions armed, trades closed, E[R], cumulative R."""
    armed = re.search(r"Sessions armed: \*\*(\d+)\*\*", text)
    line = re.search(r"trades closed: \*\*(\d+)\*\* · E\[R\] ([+-]?\d+\.\d+) · win \d+% · cum ([+-]?\d+\.\d+)R", text)
    if not armed or not line:
        raise ValueError("the scorecard's paper line was not found")
    return {"sessions_armed": int(armed.group(1)), "trades_closed": int(line.group(1)),
            "mean_R": float(line.group(2)), "cum_R": float(line.group(3))}


def _close(name: str, got: float, want: float, tol: float, misses: list[str]) -> None:
    if abs(got - want) > tol:
        misses.append(f"{name}: recomputed {got!r}, recorded {want!r}")


def run() -> dict[str, Any]:
    cfg = yaml.safe_load((EXP / "config.yaml").read_text())
    inp = cfg["inputs"]
    paths = {k: ROOT / (v["file"] if isinstance(v, dict) else v) for k, v in inp.items()}
    start, end = (dt.date.fromisoformat(str(x)) for x in cfg["dev_span"])
    seed, draws = int(cfg["seed"]), int(cfg["bootstrap"]["draws"])

    dev = json.loads(paths["dev_results"].read_text())
    configs = {k: ba.in_span(ba.parse_trades(v["trades"]), start, end) for k, v in dev["results"].items()}
    family = {k: v for k, v in configs.items() if k.startswith(cfg["family_prefix"] + "|")}
    frozen = configs[cfg["frozen_rule"]]
    recorded_wf = json.loads(paths["dev_walkforward"].read_text())[cfg["family_prefix"]]
    holdout = json.loads(paths["holdout"].read_text())["summary"]
    controls = json.loads(paths["controls"].read_text())["results"]
    registry_trials = global_trial_count(paths["trial_registry"])
    paper = paper_aggregate(paths["paper_aggregate"].read_text())

    # ---- reconciliation
    rec, misses = cfg["reconcile"], []
    wf, picks = ba.walk_forward(family, start, end)
    wf_d = ba.distribution(wf, seed=seed, draws=draws)
    tol, tol_dsr = float(rec["tolerance_abs"]), float(rec["tolerance_dsr"])
    if wf_d["n"] != rec["walk_forward"]["n"]:
        misses.append(f"walk-forward n: recomputed {wf_d['n']}, recorded {rec['walk_forward']['n']}")
    _close("walk-forward expectancy", wf_d["expectancy_R"], rec["walk_forward"]["expectancy_R"], tol, misses)
    wf_dsr65 = ba.dsr(wf, int(rec["walk_forward"]["dsr_trials"]))
    _close("walk-forward DSR at 65", wf_dsr65, rec["walk_forward"]["dsr_prob"], tol_dsr, misses)
    recorded_picks = [(p[0], p[1]) for p in recorded_wf["fold_picks"]]
    if picks != recorded_picks:
        misses.append(f"fold picks differ: {picks} vs {recorded_picks}")
    if len(frozen) != rec["frozen_rule_dev"]["n"]:
        misses.append(f"frozen rule n: recomputed {len(frozen)}, recorded {rec['frozen_rule_dev']['n']}")
    if holdout["n"] != rec["holdout"]["n"]:
        misses.append(f"holdout n: {holdout['n']} vs {rec['holdout']['n']}")
    _close("holdout expectancy", holdout["expectancy_R"], rec["holdout"]["expectancy_R"], tol, misses)
    if misses:
        raise ReconcileError("; ".join(misses))
    pick_counts: dict[str, int] = {}
    for _, name in picks:
        pick_counts[name] = pick_counts.get(name, 0) + 1

    # ---- the frozen rule's development record
    dist = ba.distribution(frozen, seed=seed, draws=draws)
    tradable = [t for t in frozen if ba.runner_can_trade(t)]
    untradable = [t for t in frozen if ba.runner_can_trade(t) is False]
    sr_var = ba.sharpe_variance(configs)
    trials_at = {"65": int(rec["walk_forward"]["dsr_trials"]), "registry": registry_trials}
    dsr_tab = {f"{who}_trials_{k}": {"trials": n, "one_over_n": ba.dsr(t, n), "across_dev_variants": ba.dsr(t, n, sr_var)}
               for who, t in (("walk_forward", wf), ("frozen_rule", frozen), ("frozen_rule_runner_tradable", tradable))
               for k, n in trials_at.items()}

    names, dates, m = ba.daily_matrix(configs)
    fam_names, _, fam_m = ba.daily_matrix(family)
    pbo_all = ba.pbo_cscv(m, int(cfg["metrics"]["pbo"]["blocks"]))
    pbo_fam = ba.pbo_cscv(fam_m, int(cfg["metrics"]["pbo"]["blocks"])) | {"informative": False,
                                                                          "why": "two configurations only"}

    cost = json.loads(paths["cost_stress"].read_text())
    cost_pts = {float(k.rsplit("cost", 1)[1].rstrip("x")): float(v["E"]) for k, v in cost.items()
                if k.startswith(cfg["family_prefix"] + "|M3|")}
    traded = json.loads(paths["cost_stress_traded"].read_text())
    traded_pts = {float(k.rsplit("x", 1)[1]): float(v[1]) for k, v in traded.items() if k.startswith("QQQ ")}

    import numpy as np  # local: only the control comparison needs it here
    cm = np.array([x for k, c in controls.items() if k.startswith(cfg["family_prefix"]) for x in c["control_means"]])
    control_p = float((1 + (cm >= dist["expectancy_R"]).sum()) / (1 + len(cm))) if len(cm) else None

    # ---- what the paper record can show
    pw = cfg["metrics"]["power"]
    sd, edge = dist["sd_R"], dist["expectancy_R"]
    edges = {"frozen_rule_dev": edge, "half_frozen_rule_dev": edge / 2, "holdout": float(holdout["expectancy_R"])}
    rate = paper["trades_closed"] / paper["sessions_armed"]
    power = {}
    for k, e in edges.items():
        n_need = ba.trades_for_power(e, sd, float(pw["alpha_one_sided"]), float(pw["power"]))
        power[k] = {"edge_R": e, "trades_needed": n_need, "sessions_needed": n_need / rate,
                    "years_needed": n_need / rate / int(pw["sessions_per_year"]),
                    "power_at_g2b_trades": ba.power_at(int(pw["g2b_trades"]), e, sd, float(pw["alpha_one_sided"]))}
    mintrl = ba.min_track_record(dist["per_trade_sharpe"], dist["skew"], dist["kurtosis"],
                                 float(cfg["metrics"]["min_track_record"]["benchmark_sharpe"]),
                                 float(cfg["metrics"]["min_track_record"]["confidence"]))
    sp = cfg["metrics"]["sprt"]
    sprt = ba.sprt_design(edge / 2, sd, float(sp["alpha"]), float(sp["beta"]), float(sp["h0_mean_R"]))
    sprt["no_edge_boundary_at_trades"] = {str(n): ba.sprt_lower_at(sprt, n) for n in (10, 20, 30, 50, 100)}

    return {
        "experiment": cfg["experiment"], "evidence_label": cfg["evidence_label"], "trials_added": 0,
        "inputs_sha256": {k: sha256(p) for k, p in sorted(paths.items())},
        "registry": {"global_trials": registry_trials, "rows": len(trial_history(paths["trial_registry"]))},
        "reconcile": {"status": "reproduced", "walk_forward": {"n": wf_d["n"], "expectancy_R": wf_d["expectancy_R"],
                      "dsr_trials_65": wf_dsr65, "fold_pick_counts": pick_counts, "folds": len(picks)},
                      "frozen_rule_dev_n": len(frozen), "holdout": holdout},
        "walk_forward": wf_d,
        "frozen_rule": dist | {"splits": ba.splits(frozen), "exit_quality": ba.exit_quality(frozen),
                               "random_control_p": control_p, "control_draws": len(cm)},
        "runner_parity": {"tradable": ba.distribution(tradable, seed=seed, draws=draws),
                          "not_tradable_at_or_after_1530": ba.distribution(untradable, seed=seed, draws=draws),
                          "share_not_tradable": len(untradable) / len(frozen),
                          "share_of_total_R_not_tradable": (sum(t.r for t in untradable) / dist["total_R"])
                          if dist["total_R"] else None},
        "dsr": dsr_tab | {"sr_variance_across_dev_variants": sr_var, "dev_variants": len(configs)},
        "pbo": {"all_dev_configs": pbo_all | {"configs_named": names, "dates": len(dates)},
                "family": pbo_fam | {"configs_named": fam_names}},
        "cost": {"recorded_cost": ba.cost_slope(cost_pts) | {"points": cost_pts},
                 "traded_etf_cost": ba.cost_slope(traded_pts) | {"points": traded_pts}},
        "paper_aggregate": paper | {"trades_per_armed_session": rate},
        "power": power | {"alpha_one_sided": pw["alpha_one_sided"], "target_power": pw["power"], "sd_R": sd,
                          "g2b_trades": pw["g2b_trades"]},
        "min_track_record_trades": mintrl,
        "sprt_design": sprt,
    }


def dump(obj: Any) -> str:
    return json.dumps(obj, indent=1, sort_keys=True, default=str, allow_nan=True) + "\n"


def main(argv: list[str]) -> int:
    try:
        out = dump(run())
    except ReconcileError as e:
        print(f"RECONCILE FAILED: {e}", file=sys.stderr)
        return 2
    target = EXP / "results.json"
    if "--check" in argv:
        if not target.exists() or target.read_text() != out:
            print("results.json is missing or differs from a fresh run", file=sys.stderr)
            return 1
        print("results.json matches a fresh run")
        return 0
    target.write_text(out)
    from wt.research.manifest import write_manifest
    write_manifest(EXP, {"exp": "EXP-0042", "argv": argv}, [EXP / "config.yaml"], name="manifest_b_audit.json")
    print(f"wrote {target.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
