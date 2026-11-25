import { describe, expect, it } from "vitest";
import { armBooks } from "@/lib/paper";
import type { PaperOptions } from "@/lib/paper-options.types";
import {
  armCurve,
  armProgress,
  COUNT,
  gateTrack,
  heatmap,
  insideWindow,
  labProgress,
  lastClosedSession,
  MILESTONES,
  milestoneStates,
  NEXT_TABLES,
  recordHref,
  RUNWAY_SESSIONS,
  SHADOW_HYPS,
  TRIALS,
  WINDOW,
  WINDOW_SESSIONS,
  wireStates,
} from "@/lib/research-arms";
import { BAND_ACCEPTED, BANDED, armBand, band, mulberry32, percentile, unitsOf, type Unit } from "@/lib/research-arms-band";
import { FAMILY_O, LINEAGE_EDGES, LINEAGE_NODES } from "@/lib/research-lineage";
import paperV1 from "./fixtures/paper-options.v1.json";
import paperV2 from "./fixtures/paper-options.v2.json";

const v1 = () => structuredClone(paperV1) as unknown as PaperOptions;
const v2 = () => structuredClone(paperV2) as unknown as PaperOptions;

/** A virtual trade of a given New York session, opened at 10:30 and closed at 11:00 New York (winter time). */
const arm = (session: string, vid: string, pnl = 10) => ({
  vid,
  session,
  side: "call" as const,
  contract: "SPY261120C00600000",
  opened_at: `${session}T15:30:00Z`,
  closed_at: `${session}T16:00:00Z`,
  fill: 1,
  exit_fill: 1 + pnl / 100,
  exit_reason: "target",
  pnl_usd: pnl,
  rop: pnl / 100,
});
const withArm = (hyp: string, trades: ReturnType<typeof arm>[]) => {
  const d = v1();
  d.arms = [{ hyp, truncated: 0, trades }];
  return armBooks(d)![0]!;
};

describe("the trials", () => {
  it("are the fourteen of EXP-0030: ten tag, four shadow, ids HYP-0034 to HYP-0047", () => {
    expect(TRIALS).toHaveLength(14);
    expect(TRIALS.filter((t) => t.kind === "tag")).toHaveLength(10);
    expect(SHADOW_HYPS).toEqual(["HYP-0044", "HYP-0045", "HYP-0046", "HYP-0047"]);
    expect(TRIALS.map((t) => t.hyp)).toEqual(Array.from({ length: 14 }, (_, i) => `HYP-00${34 + i}`));
  });

  it("ride on the control's two trials, or on their own trigger", () => {
    for (const t of TRIALS) expect([null, "HYP-0029", "HYP-0030"]).toContain(t.base);
    expect(TRIALS.filter((t) => t.base === null).map((t) => t.hyp)).toEqual(["HYP-0046", "HYP-0047"]);
  });

  it("are named by category only: no registered name, setup or rule word", () => {
    const text = JSON.stringify(TRIALS) + JSON.stringify(MILESTONES) + JSON.stringify(NEXT_TABLES);
    expect(text).not.toMatch(/OC-|\bH-[A-Z]|retest|rejection|reclaim|runner|\btrap\b|\bNTZ\b|leader|(?<!model )\bgap\b|sector|volatil|\biv\b|\bearly\b|\blate\b|second contract|\bQQQ\b|\bSMH\b/i);
    expect(new Set(TRIALS.filter((t) => t.kind === "tag").map((t) => t.label)).size).toBe(5);
  });

  it("link to the record's own page", () => {
    expect(recordHref("HYP-0044")).toBe("/research/records/HYP-0044");
  });
});

describe("the window", () => {
  it("is the 9 market sessions of 5 to 17 Nov 2026, as DEC-0056 counts them", () => {
    expect(WINDOW_SESSIONS).toEqual(["2026-11-05", "2026-11-06", "2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-16", "2026-11-17"]);
    expect(WINDOW_SESSIONS).toHaveLength(WINDOW.maxSessions);
  });

  it("leaves a runway of sessions to the close, none in the window", () => {
    expect(RUNWAY_SESSIONS[0]).toBe("2026-11-18");
    expect(RUNWAY_SESSIONS.at(-1)).toBe("2027-11-05");
    expect(RUNWAY_SESSIONS.length).toBeGreaterThan(200);
  });

  it("cuts both ends: a session before 5 Nov or after 17 Nov is dropped, every one inside kept unchanged", () => {
    const book = withArm("HYP-0046", [arm("2026-11-04", "early"), arm("2026-11-05", "a"), arm("2026-11-17", "b"), arm("2026-11-18", "c"), arm("2026-11-20", "d")]);
    const cut = insideWindow(book);
    expect(cut.trades.map((t) => t.id)).toEqual(["a", "b"]);
    expect(cut.hyp).toBe("HYP-0046");
    expect(armProgress(cut.trades).sessions).toBeLessThanOrEqual(WINDOW.maxSessions);
  });

  it("returns the same book when nothing is outside", () => {
    const book = withArm("HYP-0046", [arm("2026-11-06", "a")]);
    expect(insideWindow(book)).toBe(book);
  });

  it("matches the records' dates", () => {
    expect(WINDOW).toMatchObject({ from: "2026-11-05", last: "2026-11-17", bookingOff: "2026-11-19", close: "2027-11-05", maxSessions: 9 });
  });
});

describe("progress toward the count", () => {
  it("counts trades and distinct sessions, each share capped at 1", () => {
    const trades = Array.from({ length: 40 }, (_, i) => arm(`2026-10-${String(1 + (i % 25)).padStart(2, "0")}`, `v${i}`));
    expect(armProgress(withArm("HYP-0046", trades).trades)).toEqual({ trades: 40, sessions: 25, tradeShare: 1, sessionShare: 1 });
  });

  it("is zero for an empty arm", () => {
    expect(armProgress([])).toEqual({ trades: 0, sessions: 0, tradeShare: 0, sessionShare: 0 });
  });

  it("draws each arm's running total led by 0", () => {
    const b = armBooks(v2())![0]!;
    const curve = armCurve(b.trades);
    expect(curve[0]).toBe(0);
    expect(curve.at(-1)).toBeCloseTo(b.trades.reduce((s, t) => s + t.pnl, 0));
  });
});

describe("the session heatmap", () => {
  it("counts each arm's trades per window session, and the rest apart, one row per arm sent", () => {
    const book = withArm("HYP-0047", [arm("2026-11-05", "a"), arm("2026-11-05", "b"), arm("2026-11-17", "c"), arm("2026-10-01", "d")]);
    const [row] = heatmap([book]);
    expect(row).toEqual({ hyp: "HYP-0047", cells: [2, 0, 0, 0, 0, 0, 0, 0, 1], outside: 1 });
    expect(heatmap([])).toEqual([]);
  });

  it("keeps TRIALS order and ignores a book that is not a shadow arm", () => {
    const d = v2();
    const rows = heatmap([...armBooks(d)!].reverse());
    expect(rows.map((r) => r.hyp)).toEqual(SHADOW_HYPS.filter((h) => d.arms!.some((a) => a.hyp === h)));
  });
});

describe("the lab", () => {
  it("is null without a lab block (version 1) or with an unreadable one", () => {
    expect(labProgress(v1())).toBeNull();
    expect(labProgress(null)).toBeNull();
    const d = v2();
    (d.lab as unknown as Record<string, unknown>).shadow_done = "five";
    expect(labProgress(d)).toBeNull();
  });

  it("says what is left of the shadow period and before the first tables", () => {
    const p = labProgress(v2())!;
    const lab = v2().lab!;
    expect(p.shadowLeft).toBe(Math.max(0, lab.shadow_needed - lab.shadow_done));
    expect(p.toFirstRead).toBe(Math.max(0, 20 - lab.counted));
  });
});

describe("the gate tracker", () => {
  it("is null without a lab block", () => {
    expect(gateTrack(v1())).toBeNull();
    expect(gateTrack(null)).toBeNull();
  });

  it("has one cell per shadow session, and counted sessions plus pending cells up to 20", () => {
    const d = v2();
    const t = gateTrack(d)!;
    expect(t.shadow).toHaveLength(d.lab!.shadow_needed);
    expect(t.counting.filter((c) => c.state === "counted").length + t.counting.filter((c) => c.state === "pending").length).toBe(Math.max(20, t.counting.filter((c) => c.state === "counted").length));
    for (const c of [...t.shadow, ...t.counting]) expect(["counted", "would-count", "failed", "pending"]).toContain(c.state);
  });

  it("with no session yet: five pending shadow cells and twenty pending counted cells", () => {
    const d = v2();
    d.lab = { ...d.lab!, sessions: [], shadow_done: 0, counted: 0, recorded: 0, archived: 0 };
    const t = gateTrack(d)!;
    expect(t.shadow.map((c) => c.state)).toEqual(Array(5).fill("pending"));
    expect(t.counting).toHaveLength(20);
    expect(t.counting.every((c) => c.state === "pending")).toBe(true);
  });

  it("marks a shadow session that would have counted, a failed one, and a counted one after the shadow", () => {
    const d = v2();
    const base = d.lab!.sessions[0]!;
    const s = (date: string, shadow: boolean, counts: boolean) => ({ ...base, date, recorder: 2 as const, recorded: true, shadow, counts, why_not: counts ? [] : (["stale_run"] as const).slice() });
    d.lab = { ...d.lab!, first_v2: "2026-11-20", shadow_done: 2, counted: 1, recorded: 3, sessions: [s("2026-11-20", true, true), s("2026-11-21", true, false), s("2026-11-24", false, true)] };
    const t = gateTrack(d)!;
    expect(t.shadow.map((c) => c.state)).toEqual(["would-count", "failed", "pending", "pending", "pending"]);
    expect(t.counting[0]).toMatchObject({ state: "counted", date: "2026-11-24" });
    expect(t.counting.filter((c) => c.state === "pending")).toHaveLength(19);
  });

  it("names EXP-0052's four tables", () => {
    expect(NEXT_TABLES.map((t) => t.key)).toEqual(["stop_survival", "round_trip_cost", "limit_fill_band", "model_gap"]);
  });
});

describe("the live wiring", () => {
  const stale = () => false;

  it("knows nothing without a document, and booking is always off", () => {
    const w = wireStates(null, new Date("2026-11-25T15:00:00Z"), stale);
    expect(w).toMatchObject({ booking: { state: "off" }, document: { state: "unknown" }, recorder: { state: "unknown" }, upload: { state: "unknown" } });
  });

  it("is live when the latest lab session is the last closed one, stale two sessions behind", () => {
    const d = v2();
    const base = d.lab!.sessions[0]!;
    d.lab = { ...d.lab!, sessions: [{ ...base, date: "2026-11-24", archived: true, upload_after_close_min: 95 }] };
    const now = new Date("2026-11-25T15:00:00Z"); // 10:00 New York, before the close
    expect(lastClosedSession(now)).toBe("2026-11-24");
    expect(wireStates(d, now, stale)).toMatchObject({ document: { state: "live", seen: d.as_of }, recorder: { state: "live", seen: "2026-11-24" }, upload: { state: "live", seen: "2026-11-24", minutes: 95 } });
    const later = new Date("2026-11-27T22:00:00Z");
    expect(wireStates(d, later, stale).recorder.state).toBe("stale");
    expect(wireStates(d, now, () => true).document.state).toBe("stale");
  });

  it("calls the upload stale when the latest session is not archived a session later", () => {
    const d = v2();
    const base = d.lab!.sessions[0]!;
    d.lab = { ...d.lab!, sessions: [{ ...base, date: "2026-11-23", archived: true }, { ...base, date: "2026-11-24", archived: false }] };
    expect(wireStates(d, new Date("2026-11-25T22:00:00Z"), stale).upload).toMatchObject({ state: "stale", seen: "2026-11-23" });
  });
});

describe("the timeline", () => {
  const lab = (shadowLeft: number, toFirstRead: number) => ({ firstV2: "2026-11-20", shadowDone: 5 - shadowLeft, shadowNeeded: 5, shadowLeft, counted: 20 - toFirstRead, recorded: 6, archived: 6, toFirstRead });
  const at = (key: string) => MILESTONES.findIndex((m) => m.key === key);

  it("marks the dated past done and gives exactly one next step", () => {
    const s = milestoneStates("2026-11-25", lab(2, 20));
    expect(s.filter((x) => x === "next")).toHaveLength(1);
    expect(s[at("counting")]).toBe("next");
    expect(s[at("close")]).toBe("later");
    MILESTONES.forEach((m, i) => {
      if (m.date && m.date <= "2026-11-25") expect(s[i]).toBe("done");
    });
  });

  it("moves on as the lab does, and closes on 5 Nov 2027", () => {
    expect(milestoneStates("2026-12-20", lab(0, 4))[at("tables")]).toBe("next");
    expect(milestoneStates("2027-11-05", lab(0, 0)).every((x) => x === "done")).toBe(true);
  });

  it("without the lab's status, the lab's undated steps are unknown, never guessed", () => {
    const s = milestoneStates("2026-11-25", null);
    expect(s[at("counting")]).toBe("unknown");
    expect(s[at("tables")]).toBe("unknown");
    expect(s[at("close")]).toBe("next");
  });

  it("dates the switch-off on 18 Nov and says booking is off from 19 Nov", () => {
    const m = MILESTONES[at("switched-off")]!;
    expect(m.date).toBe("2026-11-18");
    expect(m.detail).toContain("19 Nov");
  });
});

describe("the lineage", () => {
  it("joins only records it lists, and family O goes 21 to 35", () => {
    const ids = new Set(LINEAGE_NODES.map((n) => n.id));
    for (const e of LINEAGE_EDGES) {
      expect(ids.has(e.from), e.from).toBe(true);
      expect(ids.has(e.to), e.to).toBe(true);
    }
    expect(FAMILY_O).toEqual({ before: 21, after: 35, by: "DEC-0041" });
    expect(LINEAGE_NODES.map((n) => n.id)).toEqual(["DEC-0041", "HYP-0034", "EXP-0030", "DEC-0056", "DEC-0059", "DEC-0060", "DEC-0067", "EXP-0052"]);
  });
});

describe("the descriptive band (DEC-0080, off until accepted)", () => {
  const u = (session: string, value: number, closedAt = `${session}T16:00:00Z`): Unit => ({ session, value, closedAt });

  it("ships switched off, for the two own-mean arms only", () => {
    expect(BAND_ACCEPTED).toBe(false);
    expect(BANDED).toEqual(["HYP-0046", "HYP-0047"]);
    expect(armBand(withArm("HYP-0044", [arm("2026-11-05", "a")]))).toBeNull();
    expect(armBand(null)).toBeNull();
  });

  it("uses a fixed seeded generator", () => {
    const a = mulberry32(7);
    const b = mulberry32(7);
    const xs = Array.from({ length: 5 }, () => a());
    expect(Array.from({ length: 5 }, () => b())).toEqual(xs);
    for (const x of xs) expect(x >= 0 && x < 1).toBe(true);
  });

  it("interpolates percentiles as numpy does", () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
    expect(percentile([0, 10], 2.5)).toBeCloseTo(0.25);
    expect(percentile([5], 97.5)).toBe(5);
  });

  it("gives the mean, the halves in order, and no range with one session", () => {
    const b = band([u("2026-11-05", 0.1), u("2026-11-05", -0.3)])!;
    expect(b).toMatchObject({ units: 2, sessions: 1, range: null, firstHalf: 0.1, secondHalf: -0.3 });
    expect(b.mean).toBeCloseTo(-0.1);
    expect(band([])).toBeNull();
  });

  it("brackets the mean with a range that is the same on every run", () => {
    const units = [u("2026-11-05", 0.2), u("2026-11-06", -0.25), u("2026-11-09", 0.05), u("2026-11-10", 0.4), u("2026-11-11", -0.1)];
    const a = band(units)!;
    const b = band(units)!;
    expect(a.range).toEqual(b.range);
    expect(a.range![0]).toBeLessThanOrEqual(a.mean);
    expect(a.range![1]).toBeGreaterThanOrEqual(a.mean);
    expect(a.range![0]).toBeGreaterThanOrEqual(-0.25);
    expect(a.range![1]).toBeLessThanOrEqual(0.4);
  });

  it("reads only the window's trades with a result on the premium, in session order", () => {
    const book = withArm("HYP-0046", [arm("2026-11-17", "b", 20), arm("2026-11-05", "a", -10), arm("2026-11-18", "late", 50)]);
    expect(unitsOf(book).map((x) => x.session)).toEqual(["2026-11-05", "2026-11-17"]);
    expect(armBand(book)!.units).toBe(2);
  });
});

describe("the fixtures", () => {
  it("still read as books, though their arm trades fall before the window", () => {
    const books = armBooks(v2())!;
    expect(books.length).toBe(4);
    for (const b of books) expect(insideWindow(b).trades).toHaveLength(0);
    expect(COUNT).toEqual({ units: 30, sessions: 20 });
  });
});
