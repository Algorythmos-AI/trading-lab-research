// The Robot B page's logic (lib/robot-b.ts) and its evidence file: every state derived from data, the failure modes
// the page must survive, and the data-class guard on the committed evidence.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  axis,
  blockers,
  ciText,
  crossesZero,
  deskState,
  estimates,
  EVIDENCE,
  isEvidence,
  ladder,
  paperNow,
  rSigned,
  type Evidence,
} from "@/lib/robot-b";
import { findDenied } from "@/lib/validate";
import type { Snapshot } from "@/lib/types";

const here = fileURLToPath(new URL(".", import.meta.url));
const raw = JSON.parse(readFileSync(join(here, "../src/lib/robot-b-evidence.json"), "utf8")) as Evidence;
const NOW = new Date("2026-11-18T12:00:00Z");

function snap(over: { g2?: object; stop_rule?: object | null; virtual?: object; kill?: boolean; job?: string; as_of?: string; trades?: number; mean_r?: number; total_r?: number } = {}): Snapshot {
  return {
    as_of: over.as_of ?? "2026-11-18T11:00:00Z",
    kill: { on: over.kill ?? false },
    jobs: { last: { "paper-b": { status: over.job ?? "ok", ended: "2026-11-18T10:00:00Z" } } },
    ops: {
      paper: {
        trades: over.trades ?? 9,
        mean_r: over.mean_r ?? -0.365,
        total_r: over.total_r ?? -3.29,
        virtual: { equity: 586.27, start: 600, latched: false, ...(over.virtual ?? {}) },
        g2: {
          sessions: 30, sessions_needed: 30, incident_free_streak: 6, incident_free_needed: 20,
          agreement_level: "bar", agreement_days: 26, agreement_agree: 25, trades: 9, trades_needed: 50,
          ...(over.g2 ?? {}),
        },
        stop_rule: over.stop_rule === null ? undefined : { present: true, decision: "DEC-0037", cum_r: -3.29, cum_r_max_loss: -6, trades: 9, review_at_trades: 30, stop_date: "2027-01-30", fired: null, ...(over.stop_rule ?? {}) },
      },
    },
  } as unknown as Snapshot;
}

describe("the evidence file", () => {
  it("is valid, numbers only, and passes the dashboard's denylist", () => {
    expect(isEvidence(raw)).toBe(true);
    expect(EVIDENCE).not.toBeNull();
    expect(findDenied(raw)).toEqual([]);
    // No configuration or setup name leaks: nothing like "B|QQQ|noise|M3" anywhere in the file.
    expect(JSON.stringify(raw)).not.toMatch(/\|/);
    expect(JSON.stringify(raw)).not.toMatch(/noise|range_low|atr10/);
  });
  it("is rejected when its shape is wrong", () => {
    expect(isEvidence(null)).toBe(false);
    expect(isEvidence({ ...raw, schema: 2 })).toBe(false);
    expect(isEvidence({ ...raw, trail: [{ id: "not an id", kind: "x", status: "x", date: null }] })).toBe(false);
    expect(isEvidence({ ...raw, backtest: { ...raw.backtest, trades: Number.NaN } })).toBe(false);
  });
});

describe("formatting", () => {
  it("signs R with a true minus and never signs zero", () => {
    expect(rSigned(0.1151)).toBe("+0.115R");
    expect(rSigned(-0.365)).toBe("−0.365R");
    expect(rSigned(0)).toBe("0.000R");
    expect(rSigned(-0.0001)).toBe("0.000R");
    expect(rSigned(null)).toBe("—");
    expect(ciText([-0.1219, 0.3091])).toBe("[−0.122R, +0.309R]");
    expect(ciText(null)).toBe("—");
    expect(crossesZero([-0.1, 0.3])).toBe(true);
    expect(crossesZero([0.04, 0.19])).toBe(false);
    expect(crossesZero([null, 0.1])).toBeNull();
  });
});

describe("the ladder", () => {
  it("shows the recorded evidence as failed, paper as in progress, and real money as never", () => {
    const r = ladder(raw, snap());
    const st = Object.fromEntries(r.map((x) => [x.key, x.state]));
    expect(st).toEqual({ data: "failed", g1: "failed", holdout: "failed", g2a: "pending", g2b: "pending", promotion: "blocked", live: "never" });
  });
  it("passes G2a only with sessions, streak and 90% agreement all met", () => {
    const ok = snap({ g2: { incident_free_streak: 20 } });
    expect(ladder(raw, ok).find((x) => x.key === "g2a")?.state).toBe("passed");
    const lowAgree = snap({ g2: { incident_free_streak: 20, agreement_agree: 20 } });
    expect(ladder(raw, lowAgree).find((x) => x.key === "g2a")?.state).toBe("pending");
  });
  it("marks G2b failed once the stop rule fired", () => {
    const r = ladder(raw, snap({ stop_rule: { fired: "cum_r", cum_r: -6.1 } }));
    expect(r.find((x) => x.key === "g2b")?.state).toBe("failed");
  });
  it("never offers promotion while any step has not passed, and never offers real money", () => {
    const allPass: Evidence = {
      ...raw,
      evidence: { ...raw.evidence, corrective_reruns_done: 5 },
      g1: { ...raw.g1, items: raw.g1.items.map((i) => ({ ...i, pass: true })) },
      holdout: { ...raw.holdout, ci95: [0.01, 0.3] },
    };
    const r = ladder(allPass, snap({ g2: { incident_free_streak: 20, trades: 50 } }));
    expect(r.find((x) => x.key === "promotion")?.state).toBe("pending");
    expect(r.find((x) => x.key === "live")?.state).toBe("never");
    expect(blockers(allPass, snap({ g2: { incident_free_streak: 20, trades: 400 } }))).toEqual([]);
  });
  it("survives a missing snapshot and a missing evidence file", () => {
    const r = ladder(null, null);
    expect(r.map((x) => x.state)).toEqual(["pending", "pending", "pending", "pending", "pending", "blocked", "never"]);
    expect(blockers(null, null)).toEqual(["The research evidence file is missing"]);
  });
});

describe("blockers", () => {
  it("are numeric and name the failed G1 item, the holdout and the paper sample", () => {
    const b = blockers(raw, snap());
    expect(b[0]).toMatch(/^Evidence is pre-correction: 0 of 5 corrective re-runs done/);
    expect(b.some((x) => /^G1 · Deflated Sharpe 0\.669 \(needs > 0\.95\)$/.test(x))).toBe(true);
    expect(b.some((x) => /^Holdout CI \[−0\.122R, \+0\.309R\] includes zero$/.test(x))).toBe(true);
    expect(b.some((x) => /^Paper has 9 trades; telling the backtest edge from zero needs about 325$/.test(x))).toBe(true);
  });
});

describe("the paper desk now", () => {
  it("reads the stop line and the account", () => {
    const p = paperNow(snap(), NOW);
    expect(p.cumR).toBe(-3.29);
    expect(p.stopUsed).toBeCloseTo(3.29 / 6);
    expect(p.trades).toBe(9);
    expect(p.ageHours).toBeCloseTo(1);
    expect(deskState(p)).toEqual({ word: "Paper trading", tone: "info" });
  });
  it("handles a snapshot without a stop rule (the fixture today)", () => {
    const p = paperNow(snap({ stop_rule: null }), NOW);
    expect(p.stopLine).toBeNull();
    expect(p.stopUsed).toBeNull();
    expect(p.cumR).toBe(-3.29); // falls back to the paper total
  });
  it("orders the desk's state: stopped, latched, kill, failed run", () => {
    expect(deskState(paperNow(snap({ stop_rule: { fired: "cum_r" } }), NOW)).word).toBe("Stopped by its rule");
    expect(deskState(paperNow(snap({ virtual: { latched: true } }), NOW)).word).toBe("Latched");
    expect(deskState(paperNow(snap({ kill: true }), NOW)).word).toBe("Paused: kill switch on");
    expect(deskState(paperNow(snap({ job: "failed" }), NOW)).tone).toBe("warn");
  });
  it("never calls B live", () => {
    for (const v of [snap(), snap({ kill: true }), snap({ virtual: { latched: true } }), snap({ stop_rule: { fired: "x" } })]) {
      expect(deskState(paperNow(v, NOW)).word.toLowerCase()).not.toContain("live");
    }
  });
  it("has no age without a time", () => {
    const s = snap();
    (s as { as_of?: string | null }).as_of = null;
    expect(paperNow(s, NOW).ageHours).toBeNull();
    expect(paperNow(null, NOW).trades).toBeNull();
  });
  it("clamps the stop meter when the line is crossed", () => {
    expect(paperNow(snap({ stop_rule: { cum_r: -7 } }), NOW).stopUsed).toBe(1);
    expect(paperNow(snap({ stop_rule: { cum_r: 2 } }), NOW).stopUsed).toBe(0);
  });
});

describe("estimates on one axis", () => {
  it("lists the recorded evidence and paper, and the axis contains zero and every range", () => {
    const rows = estimates(raw, paperNow(snap(), NOW));
    expect(rows.map((r) => r.key)).toEqual(["backtest", "walk_forward", "holdout", "paper"]);
    const paper = rows[3]!;
    expect(paper.mean).toBe(-0.365);
    expect(paper.lo).toBeCloseTo(-0.365 - (1.96 * raw.backtest.sd_r) / 3);
    const ax = axis(rows);
    expect(ax.min).toBeLessThan(paper.lo ?? 0);
    expect(ax.max).toBeGreaterThan(raw.holdout.ci95[1] ?? 0);
    expect(ax.min).toBeLessThan(0);
  });
  it("leaves paper out until it has a trade", () => {
    const rows = estimates(raw, paperNow(snap({ trades: 0, mean_r: 0, total_r: 0, stop_rule: { trades: 0, cum_r: 0 }, g2: { trades: 0 } }), NOW));
    expect(rows.map((r) => r.key)).toEqual(["backtest", "walk_forward", "holdout"]);
    expect(axis([])).toEqual({ min: -0.1, max: 0.1 });
  });
});
