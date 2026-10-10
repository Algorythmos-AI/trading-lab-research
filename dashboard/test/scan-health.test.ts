// The scan's data in the banner and on the pages: a failed scan, the scan alerts, the loss limits, the near misses
// and the funnel of record. Every read tolerates a host that does not publish the field yet.
import { describe, expect, it } from "vitest";
import { computeHealth } from "@/lib/health";
import { near, ofRecord, scan } from "@/lib/today";
import type { Snapshot } from "@/lib/types";
import { cleanSnapshot, fixture, fixtureV3 } from "./helpers";

const IN_WINDOW = new Date("2026-09-29T12:10:00Z");
const codes = (s: Snapshot) => computeHealth(s, IN_WINDOW).reasons.map((r) => `${r.level}:${r.code}`);
const stage = (universe: number, traded: number, extra: Record<string, unknown> = {}) => ({
  stage: "tier1", as_of_et: "08:00", feed: "hybrid", stats: { universe, snapshot_symbols: traded, kept: 0 }, counts: { tier1: 0 }, tier1: [], tier2: [], primary: null, ...extra,
});
function withScan(date: string, st: Record<string, unknown>): Snapshot {
  const s = cleanSnapshot();
  return { ...s, market: { trading_day_et: "2026-09-29" }, ops: { ...s.ops, routine: { date, stages: [st] } } } as Snapshot;
}

describe("a scan with no data", () => {
  it("turns the banner RED when it is today's scan", () => {
    expect(codes(withScan("2026-09-29", stage(0, 0)))).toEqual(["red:scan-failed"]);
    expect(codes(withScan("2026-09-29", stage(4300, 0)))).toEqual(["red:scan-failed"]);
    expect(codes(withScan("2026-09-29", stage(4300, 700, { scan_failed: true })))).toEqual(["red:scan-failed"]);
  });

  it("says nothing for an ordinary morning, a quiet one, or an older session's scan", () => {
    expect(codes(withScan("2026-09-29", stage(4300, 700)))).toEqual([]);
    expect(codes(withScan("2026-09-29", stage(4300, 700, { scan_failed: false })))).toEqual([]);
    expect(codes(withScan("2026-09-28", stage(0, 0)))).toEqual([]);                    // yesterday's: not today's news
    expect(scan(withScan("2026-09-28", stage(0, 0))).failed).toBe(true);               // the strip still says so
    expect(codes(cleanSnapshot())).toEqual([]);                                        // no routine section at all
  });
});

describe("scan alerts and loss limits", () => {
  it("a scan-data alert is AMBER, never RED", () => {
    for (const key of ["forward:scan-failed:2026-09-29", "forward:scan-thin:2026-09-29", "routine:scan-failed:2026-09-29", "routine:sip-fallback:2026-09-29"]) {
      const s = cleanSnapshot({ alerts: { firing: [{ key, since: null, title: "Scan alert" }] } });
      expect(codes(s)).toEqual([`amber:alert:${key}`]);
    }
  });

  it("a loss limit close to its limit is AMBER and a used-up one is RED; a cap that is meant to be reached is neither", () => {
    const limits = (state: string, id = "day_loss") => cleanSnapshot({ risk: { limits: [{ id, label: "Daily loss latch", used: "-1.60%", state }] } } as Partial<Snapshot>);
    expect(codes(limits("ok"))).toEqual([]);
    expect(codes(limits("warn"))).toEqual(["amber:limit:day_loss"]);
    expect(codes(limits("at_limit"))).toEqual(["red:limit:day_loss"]);
    expect(codes(limits("at_limit", "entries_per_day"))).toEqual([]);                  // one entry a day, taken: normal
    expect(codes(limits("n/a"))).toEqual([]);
  });
});

describe("near misses and the funnel of record", () => {
  it("are absent until a host publishes them", () => {
    expect(near(fixture())).toBeNull();
    expect(ofRecord(fixture())).toBeNull();
    expect(scan(fixture()).failed).toBe(false);
    expect(near({} as Snapshot)).toBeNull();
    expect(ofRecord({ ops: { forward: { funnel: { session: "2026-10-09", counts: {} } } } } as Snapshot)).toBeNull();
  });

  it("read the v3 fixture: tickers, prices and the one filter in words", () => {
    const n = near(fixtureV3());
    expect(n?.total).toBe(3);
    expect(n?.rows.map((r) => [r.symbol, r.price, r.label])).toEqual([
      ["ZZZA", 4.13, "No qualifying news"],
      ["ZZZB", 9.5, "Too many shares"],
      ["ZZZC", 2.84, "Volume not unusual enough"],
    ]);
    const r = ofRecord(fixtureV3());
    expect(r?.session).toBe("2026-09-28");
    expect(r?.universe).toBe(4393);
    expect(r?.why.steps.map((x) => x.count)).toEqual([31, 2, 2, 1, 1, 1]);
    expect(r?.why.reasons[0]).toMatchObject({ code: "catalyst_missing", count: 22 });
  });

  it("a code the page does not know is shown without a name it could leak", () => {
    const s = { ops: { routine: { near: { total: 1, rows: [{ symbol: "ZZZA", price: 3, reason: "something_new" }] } } } } as Snapshot;
    expect(near(s)?.rows[0]?.label).toBe("Another filter");
  });
});
