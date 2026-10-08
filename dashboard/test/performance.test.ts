// The tournament's performance views: drawdown, monthly returns and the signal funnel.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Crypto } from "@/lib/crypto";
import { deskFunnel, drawdownLines, monthlyReturns, signalFunnels } from "@/lib/performance";
import type { EquityLine } from "@/lib/tournament";

const fixture = (): Crypto => JSON.parse(readFileSync(new URL("./fixtures/crypto.v1.json", import.meta.url), "utf8")) as Crypto;
const at = (iso: string) => Date.parse(iso);
const line = (name: string, marks: [string, number][], baseline = false): EquityLine => ({
  name,
  label: name,
  baseline,
  points: marks.map(([t, pct]) => ({ t: at(t), pct })),
  lastPct: marks.at(-1)?.[1] ?? null,
  worstDrawdownPct: null,
});

describe("drawdown", () => {
  it("is the fall from the book's own running high, and the start counts as a high", () => {
    const [d] = drawdownLines([line("trend", [["2026-10-01T00:00:00Z", -2], ["2026-10-02T00:00:00Z", 10], ["2026-10-03T00:00:00Z", 4.5], ["2026-10-04T00:00:00Z", 10]])]);
    expect(d!.points.map((p) => Number(p.pct.toFixed(4)))).toEqual([-2, 0, -5, 0]); // 1.045 / 1.10 - 1
    expect(d!.worstPct).toBeCloseTo(-5, 6);
    expect(d!.nowPct).toBe(0);
    expect(d!.points.every((p) => p.pct <= 0)).toBe(true);
  });

  it("says nothing about a book with one mark, and keeps the baseline flag", () => {
    const [one, base] = drawdownLines([line("dip", [["2026-10-01T00:00:00Z", -1]]), line("baseline", [], true)]);
    expect(one!.worstPct).toBeNull();
    expect(one!.nowPct).toBeNull();
    expect(base!.baseline).toBe(true);
    expect(base!.points).toEqual([]);
  });
});

describe("monthly returns", () => {
  it("compares each month's last mark with the month before, and the first month with the start", () => {
    const m = monthlyReturns([
      line("trend", [["2026-08-20T00:00:00Z", 5], ["2026-08-31T20:00:00Z", 10], ["2026-09-30T20:00:00Z", -1], ["2026-10-05T00:00:00Z", 8.9]]),
      line("break", [["2026-10-02T00:00:00Z", -3]]),
    ]);
    expect(m.months).toEqual(["2026-08", "2026-09", "2026-10"]);
    const trend = m.books[0]!.byMonth;
    expect(trend["2026-08"]).toBeCloseTo(10, 6);
    expect(trend["2026-09"]).toBeCloseTo((0.99 / 1.1 - 1) * 100, 6); // -10%
    expect(trend["2026-10"]).toBeCloseTo((1.089 / 0.99 - 1) * 100, 6); // +10%
    // Compounding the months gives the return since the start.
    const total = Object.values(trend).reduce((a, r) => a * (1 + r / 100), 1);
    expect((total - 1) * 100).toBeCloseTo(8.9, 6);
    expect(Object.keys(m.books[1]!.byMonth)).toEqual(["2026-10"]);
    expect(m.books[1]!.byMonth["2026-10"]).toBeCloseTo(-3, 6);
  });

  it("orders marks by time, uses UTC months, and has nothing for a book with no mark", () => {
    const m = monthlyReturns([line("trend", [["2026-10-01T00:30:00Z", 2], ["2026-09-30T23:30:00Z", 1]]), line("dip", [])]);
    expect(m.months).toEqual(["2026-09", "2026-10"]);
    expect(m.books[0]!.byMonth["2026-09"]).toBeCloseTo(1, 6);
    expect(m.books[0]!.byMonth["2026-10"]).toBeCloseTo((1.02 / 1.01 - 1) * 100, 6);
    expect(m.books[1]!.byMonth).toEqual({});
  });
});

describe("the signal funnel", () => {
  it("reads each sleeve's counts from the snapshot, and the refusals add up to what was not bought", () => {
    const fs = signalFunnels(fixture());
    expect(fs.map((f) => f.name)).toEqual(["trend", "break", "dip"]); // the challenger has recorded no signal
    for (const f of fs) {
      expect(f.refused.reduce((a, r) => a + r.count, 0)).toBe(f.fired - f.entered);
      expect(f.takenShare).toBeCloseTo(f.entered / f.fired, 9);
    }
    const breakout = fs[1]!;
    expect([breakout.fired, breakout.entered]).toEqual([4, 2]);
    expect(breakout.refused.map((r) => r.code).sort()).toEqual(["desk_coin", "stop_too_tight"]);
  });

  it("adds the sleeves up for the desk and survives a snapshot from before the funnel existed", () => {
    const fs = signalFunnels(fixture());
    const desk = deskFunnel(fs);
    expect(desk.fired).toBe(fs.reduce((a, f) => a + f.fired, 0));
    expect(desk.refused.reduce((a, r) => a + r.count, 0)).toBe(desk.fired - desk.entered);
    expect(desk.refused[0]!.code).toBe("stop_too_tight"); // three sleeves refused one each
    const old = fixture();
    for (const x of old.sleeves ?? []) if (x) delete (x as { funnel?: unknown }).funnel;
    expect(signalFunnels(old)).toEqual([]);
    expect(deskFunnel([])).toEqual({ fired: 0, entered: 0, refused: [] });
  });
});
