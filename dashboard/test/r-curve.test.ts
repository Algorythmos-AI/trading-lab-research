import { describe, expect, it } from "vitest";
import { rCurve } from "@/lib/r-curve";

describe("rCurve", () => {
  it("runs the total and the fall from the earlier high, trade by trade", () => {
    const c = rCurve([
      { day: "2026-10-01", r: 1, code: "e1" },
      { day: "2026-10-02", r: -0.5 },
      { day: "2026-10-03", r: -1 },
      { day: "2026-10-04", r: 2 },
    ]);
    expect(c.points.map((p) => [p.i, p.cum, p.dd])).toEqual([
      [1, 1, 0],
      [2, 0.5, -0.5],
      [3, -0.5, -1.5],
      [4, 1.5, 0],
    ]);
    expect(c).toMatchObject({ total: 1.5, maxDd: -1.5, wins: 2, losses: 2 });
    expect(c.points[0]!.code).toBe("e1");
    expect(c.points[1]!.code).toBeNull();
  });

  it("counts a first loss as a drawdown from zero", () => {
    expect(rCurve([{ day: null, r: -1 }]).points[0]).toMatchObject({ cum: -1, dd: -1, day: "—" });
  });

  it("skips a trade with no R instead of counting it as zero", () => {
    const c = rCurve([{ day: "a", r: 1 }, { day: "b", r: null }, { day: "c", r: Number.NaN }, { day: "d", r: -1 }]);
    expect(c.points.map((p) => [p.i, p.day])).toEqual([
      [1, "a"],
      [2, "d"],
    ]);
  });

  it("keeps sums free of float dust", () => {
    const c = rCurve([{ day: "a", r: 0.1 }, { day: "b", r: 0.2 }]);
    expect(c.total).toBe(0.3);
  });

  it("is empty for no trades", () => {
    expect(rCurve([])).toEqual({ points: [], total: 0, maxDd: 0, wins: 0, losses: 0 });
  });
});
