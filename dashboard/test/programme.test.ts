import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OptionsClone } from "@/lib/options-clone.types";
import { CLONE_MIN_SESSIONS, CLONE_MIN_TRADES, cloneRow, programme, stocksRow, stoppedRow } from "@/lib/programme";
import type { Snapshot } from "@/lib/types";

const snap = (paper: Record<string, unknown>) => ({ ops: { paper } }) as unknown as Snapshot;
const G2 = { trades: 4, trades_needed: 50, sessions: 14, sessions_needed: 30, incident_free_streak: 3, incident_free_needed: 20, agreement_level: "bar", agreement_days: 5, agreement_agree: 4 };
const RULE = { present: true, decision: "DEC-0037", cum_r: -2.94, cum_r_max_loss: -6, trades: 4, review_at_trades: 30, stop_date: "2027-01-30", fired: null };

describe("the programme", () => {
  it("holds the clone's verdict thresholds equal to wt.options.review", () => {
    const py = readFileSync(path.join(__dirname, "../../src/wt/options/review.py"), "utf8");
    const m = py.match(/^MIN_TRADES, MIN_SESSIONS = (\d+), (\d+)$/m);
    expect(m && [Number(m[1]), Number(m[2])]).toEqual([CLONE_MIN_TRADES, CLONE_MIN_SESSIONS]);
  });

  it("reads strategy B from G2 and the stop rule, each against its line", () => {
    const r = stocksRow(snap({ g2: G2, stop_rule: RULE }));
    expect(r).toMatchObject({ desk: "Stocks · strategy B", state: "Paper trading", tone: "info", record: "DEC-0037" });
    expect(r.lines).toEqual([
      "G2a, the desk runs the rule: 14 of 30 clean sessions · 3 of 20 incident-free in a row · agreement at the bar 4 of 5 (90% needed)",
      "G2b, the rule earns: 4 of 50 trades",
      "Stop rule: −2.94R against the −6.00R line · 4 of 30 trades to the review · ends 30 January 2027",
    ]);
  });

  it("says when the stop rule fired, and when no rule exists, loudly; an older snapshot without it stays quiet", () => {
    const fired = stocksRow(snap({ g2: G2, stop_rule: { ...RULE, cum_r: -6.1, fired: "cum_r" } }));
    expect(fired).toMatchObject({ tone: "bad", state: "Stopped by its rule" });
    expect(fired.lines.at(-1)).toMatch(/^The stop rule fired \(cum_r\)/);
    expect(stocksRow(snap({ g2: G2, stop_rule: { present: false } }))).toMatchObject({ tone: "bad" });
    const old = stocksRow(snap({ g2: { ...G2, agreement_level: "day" } }));
    expect(old.tone).toBe("info");
    expect(old.lines).toContain("Stop rule: not in this snapshot");
    expect(old.lines[0]).toMatch(/agreement at the bar not readable yet$/);
  });

  it("counts the clone toward its verdict and names a hypothesis that got one", () => {
    const doc = { setups: [{ hyp: "HYP-0029", trades: 4, sessions: 3, verdict: "none" }, { hyp: "all", trades: 6, sessions: 3, verdict: "none" }] } as unknown as OptionsClone;
    expect(cloneRow(doc)).toMatchObject({ state: "Paper trading", lines: ["Toward the verdict: 6 of 30 trades · 3 of 20 sessions"] });
    const done = { setups: [{ hyp: "HYP-0029", trades: 31, sessions: 21, verdict: "falsified" }, { hyp: "all", trades: 31, sessions: 21, verdict: "falsified" }] } as unknown as OptionsClone;
    expect(cloneRow(done)).toMatchObject({ state: "Falsified", tone: "bad" });
    expect(cloneRow(done).lines).toContain("HYP-0029: falsified");
    expect(cloneRow(null)).toMatchObject({ state: "No document", tone: "neutral" });
  });

  it("takes the stopped desks from desks.json, with their records", () => {
    expect(stoppedRow("crypto", "Crypto")).toMatchObject({ state: "Closed", record: "DEC-0036", lines: ["Closed since 24 October 2026: no trial runs and nothing is scheduled"] });
    expect(stoppedRow("hft", "HFT (forex)")).toMatchObject({ state: "Parked", record: "HFT-DEC-0005" });
    expect(programme(null, null).map((r) => r.desk)).toEqual(["Stocks · strategy B", "Options clone", "Crypto", "HFT (forex)"]);
  });
});
