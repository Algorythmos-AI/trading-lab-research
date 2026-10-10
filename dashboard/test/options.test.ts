import { beforeEach, describe, expect, it, vi } from "vitest";
import { sign } from "@/lib/hmac";
import { CORNER_COST, editionState, findingsOf, ladder, liveNeighbours, liveState, mapView, moveBands, nearest, ONE_SIGMA_PCT, structureView, needsALook, extendTrail, liveRead, sessionShare, STALE_MS, TRAIL_MS, niceStep, nyClock, roomView, ROOM_REACH, ruleLabel, spreadLabels, type LiveQuote, type Options, type OptionsTicker } from "@/lib/options";
import { OPTIONS_SCHEMA, isOptions, validateOptionsEdition } from "@/lib/validate";
import { fixture } from "./helpers";
import optionsJson from "./fixtures/options.v1.json";

// In-memory stand-in for the private Blob store, with etags and an injectable conflict.
const blob = vi.hoisted(() => {
  class PreconditionFailed extends Error {}
  const store = new Map<string, { text: string; etag: string }>();
  let seq = 0;
  const state = { conflicts: 0 };
  return {
    store,
    state,
    PreconditionFailed,
    reset() {
      store.clear();
      seq = 0;
      state.conflicts = 0;
    },
    put(pathname: string, text: string) {
      const etag = `"e${++seq}"`;
      store.set(pathname, { text, etag });
      return etag;
    },
  };
});

vi.mock("@/lib/blob", () => ({
  LATEST_PATH: "snapshots/latest.json",
  SHADOW_LATEST_PATH: "shadow/latest.json",
  HISTORY_PREFIX: "snapshots/history/",
  ALERT_STATE_PATH: "alerts/state.json",
  PreconditionFailed: blob.PreconditionFailed,
  readText: vi.fn(async (pathname: string) => blob.store.get(pathname) ?? null),
  readForUpdate: vi.fn(async (pathname: string) => blob.store.get(pathname) ?? null),
  writeText: vi.fn(async (pathname: string, body: string, opts: { ifMatch?: string | null } = {}) => {
    if (blob.state.conflicts > 0 && pathname === "snapshots/latest.json") {
      blob.state.conflicts--;
      blob.put(pathname, blob.store.get(pathname)?.text ?? "{}"); // someone else wrote meanwhile
      throw new blob.PreconditionFailed();
    }
    const cur = blob.store.get(pathname);
    if (opts.ifMatch && cur?.etag !== opts.ifMatch) throw new blob.PreconditionFailed();
    return { etag: blob.put(pathname, body) };
  }),
}));

const { handleIngest } = await import("@/lib/ingest");

const DEFAULT_SECRET = "test-default-secret";
const RADAR_SECRET = "test-radar-secret";
const NOW = new Date("2026-10-09T21:30:00Z");
const NOW_S = Math.floor(NOW.getTime() / 1000);

function edition(mutate?: (r: Record<string, unknown>) => void): Record<string, unknown> {
  const r = structuredClone(optionsJson) as unknown as Record<string, unknown>;
  mutate?.(r);
  return r;
}

function post(body: unknown, opts: { secret?: string; keyId?: string } = {}): Request {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-wt-timestamp": String(NOW_S),
    "x-wt-signature": sign(opts.secret ?? RADAR_SECRET, NOW_S, Buffer.from(text, "utf8")),
  };
  if (opts.keyId !== "") headers["x-wt-key-id"] = opts.keyId ?? "radar";
  return new Request("https://lab.example/api/ingest", { method: "POST", body: text, headers });
}

beforeEach(() => {
  blob.reset();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.stubEnv("VERCEL_ENV", "production");
  vi.stubEnv("DASHBOARD_INGEST_SECRET", DEFAULT_SECRET);
  vi.stubEnv("RADAR_INGEST_SECRET", RADAR_SECRET);
});

const tickers = (r: Record<string, unknown>) => r.tickers as Record<string, unknown>[];

describe("options edition schema", () => {
  it("accepts the fixture the publisher built", () => {
    expect(validateOptionsEdition(edition()).ok).toBe(true);
    expect(isOptions(optionsJson)).toBe(true);
    expect(optionsJson.schema).toBe(OPTIONS_SCHEMA);
  });

  it("rejects unknown keys, bad statuses, bad zone sides and a missing session", () => {
    expect(validateOptionsEdition(edition((r) => (r.extra = 1))).ok).toBe(false);
    expect(validateOptionsEdition(edition((r) => ((r.rules as Record<string, unknown>[])[0]!.status = "great"))).ok).toBe(false);
    expect(validateOptionsEdition(edition((r) => ((tickers(r)[0]!.zones as Record<string, unknown>[])[0]!.side = "up"))).ok).toBe(false);
    expect(validateOptionsEdition(edition((r) => delete r.session)).ok).toBe(false);
    // Recent bars are optional; a malformed one is refused.
    expect(validateOptionsEdition(edition((r) => tickers(r).forEach((t) => delete t.bars))).ok).toBe(true);
    expect(validateOptionsEdition(edition((r) => ((tickers(r)[0]!.bars as Record<string, unknown>[])[0]!.d = "9 Oct"))).ok).toBe(false);
    expect(validateOptionsEdition(edition((r) => ((tickers(r)[0]!.bars as Record<string, unknown>[])[0]!.v = 1))).ok).toBe(false);
    expect(validateOptionsEdition(edition((r) => (r.session = "12 Oct"))).ok).toBe(false);
  });

  it("refuses denylisted keys inside an options edition", () => {
    const r = validateOptionsEdition(edition((e) => (tickers(e)[0]!.setup = "x")));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toContain("/tickers/0/setup");
  });
});

describe("POST /api/ingest with an options edition", () => {
  it("stores latest and the per-session copy, touching nothing else", async () => {
    const res = await handleIngest(post(edition()), NOW);
    expect(res.status).toBe(200);
    expect([...blob.store.keys()].sort()).toEqual(["options/editions/2026-10-12.json", "options/latest.json"]);
  });

  it("is a duplicate on the same run_id and 409 when older", async () => {
    await handleIngest(post(edition()), NOW);
    expect((await (await handleIngest(post(edition()), NOW)).json()).status).toBe("duplicate");
    const older = edition((r) => {
      r.run_id = "options-older";
      r.as_of = "2026-10-09T20:00:00+00:00";
    });
    expect((await handleIngest(post(older), NOW)).status).toBe(409);
  });

  it("an options edition never lands in the radar's files, nor the reverse", async () => {
    await handleIngest(post(edition()), NOW);
    expect([...blob.store.keys()].some((k) => k.startsWith("radar/"))).toBe(false);
  });

  it("the radar key still cannot publish a stocks snapshot", async () => {
    const snap = fixture() as unknown as Record<string, unknown>;
    snap.run_id = "r1";
    snap.as_of = "2026-10-09T21:29:00+00:00";
    const res = await handleIngest(post(snap), NOW);
    expect(res.status).toBe(403);
    expect(blob.store.size).toBe(0);
  });

  it("401 with the wrong key; 422 on an invalid edition without echoing it", async () => {
    expect((await handleIngest(post(edition(), { secret: "wrong" }), NOW)).status).toBe(401);
    const res = await handleIngest(post(edition((r) => (r.private_note = "do-not-echo"))), NOW);
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).not.toContain("do-not-echo");
  });
});

describe("options view helpers", () => {
  const e = optionsJson as unknown as Options;
  const spy = e.tickers.find((t) => t.symbol === "SPY")!;

  it("knows whether an edition is for the next session, today's, or out of date (New York dates)", () => {
    // Built Friday 9 Oct after the close for Monday 12 Oct.
    expect(editionState("2026-10-12", new Date("2026-10-09T21:30:00Z"))).toBe("next");
    expect(editionState("2026-10-12", new Date("2026-10-11T23:00:00Z"))).toBe("next"); // Sunday evening in New York
    expect(editionState("2026-10-12", new Date("2026-10-12T13:30:00Z"))).toBe("today");
    expect(editionState("2026-10-12", new Date("2026-10-13T03:59:00Z"))).toBe("today"); // still Monday in New York
    expect(editionState("2026-10-12", new Date("2026-10-13T13:30:00Z"))).toBe("stale");
  });

  it("orders the ladder outward from the close, without yesterday's close as a member", () => {
    const { above, at, below } = ladder(spy);
    expect(above.map((r) => r.zone.members)).toEqual([["PDH", "PWH", "52WH"]]);
    expect(at).toEqual([]);
    // PMH + PDL + PDC (775.14 to 778.55, weight 5) becomes PMH + PDL: 775.14 to 775.16, weight 4, not major.
    expect(below[0]!.zone).toMatchObject({ lo: 775.14, hi: 775.16, members: ["PMH", "PDL"], weight: 4, big: false });
    expect(below.map((r) => r.edge)).toEqual([...below.map((r) => r.edge)].sort((a, b) => b - a));
    expect(below.every((r) => r.zone.hi < 778.55)).toBe(true);
    const n = nearest(spy);
    expect(n.resistance!.edge).toBe(779.4);
    expect(n.resistance!.distPct).toBeCloseTo(((779.4 - 778.55) / 778.55) * 100, 6);
    expect(n.resistance!.distAtr).toBeCloseTo((779.4 - 778.55) / spy.atr14!, 6);
    expect(n.support!.distPct).toBeCloseTo(((775.16 - 778.55) / 778.55) * 100, 6);
  });

  it("drops a zone whose only member is yesterday's close, and keeps zones the close sits inside apart", () => {
    const t = {
      symbol: "X",
      last: { high: 105, low: 95, close: 100 },
      atr14: 2,
      levels: [
        { name: "PDC", price: 100, weight: 1 },
        { name: "DEMAND", price: 100, lo: 98, hi: 102, weight: 2 },
      ],
      zones: [
        { lo: 100, hi: 100, members: ["PDC"], side: "support", weight: 1 },
        { lo: 98, hi: 102, members: ["DEMAND"], side: "resistance", weight: 2 },
      ],
    } as OptionsTicker;
    const l = ladder(t);
    expect(l.above).toEqual([]);
    expect(l.below).toEqual([]);
    expect(l.at.map((r) => r.zone.members)).toEqual([["DEMAND"]]);
    expect(nearest(t)).toEqual({ support: null, resistance: null });
  });

  it("handles a ticker with no close or no zones", () => {
    const bare = { symbol: "X" } as OptionsTicker;
    expect(ladder(bare)).toEqual({ above: [], at: [], below: [] });
    expect(nearest({ ...spy, zones: [] })).toEqual({ support: null, resistance: null });
    expect(moveBands(bare)).toEqual({ day: null, week: null });
  });

  it("puts the expected move either side of the close", () => {
    const b = moveBands(spy);
    expect(b.day![0]).toBeCloseTo(778.55 - 5.85, 6);
    expect(b.week![1]).toBeCloseTo(778.55 + 13.07, 6);
  });

  it("names rules by label", () => {
    expect(ruleLabel(e, "brk_PDH_close")).toBe("Hourly close above yesterday's high");
    expect(ruleLabel(e, "unknown_rule")).toBe("unknown_rule");
  });

  describe("live state", () => {
    const q = (price: number, at: string, open: number | null = 778.55, day: string | null = "2026-10-12"): LiveQuote => ({
      price,
      at,
      open,
      high: null,
      low: null,
      day,
      prev_close: 778.55,
    });
    const S = "2026-10-12";
    const at = (ny: string) => `2026-10-12T${ny}:00-04:00`; // New York is on EDT in October

    it("reads New York time from an instant", () => {
      expect(nyClock("2026-10-12T13:45:00Z")).toEqual({ day: "2026-10-12", minutes: 9 * 60 + 45 });
    });

    it("is not open before the session or on a quote from an earlier day, and closed after the bell", () => {
      expect(liveState(spy, q(778.6, "2026-10-09T19:59:00Z", 776.24, "2026-10-09"), S)).toBe("NOT OPEN YET");
      expect(liveState(spy, q(778.6, at("09:00"), null, "2026-10-09"), S)).toBe("NOT OPEN YET");
      expect(liveState(spy, q(778.6, at("16:00")), S)).toBe("CLOSED");
      expect(liveState({ ...spy, half_day: true }, q(778.6, at("13:05")), S)).toBe("CLOSED");
      expect(liveState(spy, q(778.6, "2026-10-13T14:00:00Z", 778, "2026-10-13"), S)).toBe("CLOSED");
    });

    it("is NO TRADE for the first 15 minutes", () => {
      expect(liveState(spy, q(790, at("09:44")), S)).toBe("NO TRADE");
      expect(liveState(spy, q(790, at("09:45")), S)).not.toBe("NO TRADE");
    });

    it("calls a gap only while price stays beyond the level it gapped past", () => {
      expect(liveState(spy, q(785, at("10:30"), 784), S)).toBe("GAP ABOVE");
      expect(liveState(spy, q(770.5, at("10:30"), 771), S)).toBe("GAP BELOW");
    });

    it("tests a major zone within a quarter ATR, by where the zone lies against yesterday's close", () => {
      // PDH + PWH + 52WH 779.40 to 781.62 (weight 6) sits above the 778.55 close: resistance.
      expect(liveState(spy, q(779.0, at("10:30")), S)).toBe("TESTING RESISTANCE");
      // MA50 + MA20 + PWL 767.57 to 769.63 (weight 5): support. 770.5 is 0.14 ATR above it.
      expect(liveState(spy, q(770.5, at("10:30")), S)).toBe("TESTING SUPPORT");
    });

    it("otherwise is above yesterday's high, below its low, or inside", () => {
      expect(liveState(spy, q(786, at("11:00")), S)).toBe("ABOVE PDH");
      expect(liveState(spy, q(774.0, at("11:00")), S)).toBe("BELOW PDL");
      expect(liveState(spy, q(777.0, at("11:00")), S)).toBe("INSIDE");
    });

    it("finds the nearest zone edges around a live price", () => {
      const n = liveNeighbours(spy, 777);
      expect(n.up).toBe(779.4);
      expect(n.down).toBe(775.16);
      expect(n.upAtr).toBeCloseTo((779.4 - 777) / spy.atr14!, 6);
      // Inside PDH + PWH + 52WH (779.40 to 781.62): its own edges.
      expect(liveNeighbours(spy, 780.43)).toMatchObject({ up: 781.62, down: 779.4 });
    });
  });

  describe("pictures", () => {
    const e = optionsJson as unknown as Options;
    const spy = e.tickers.find((t) => t.symbol === "SPY")!;

    it("places zones on the room bar in ATRs from price, by side, within reach", () => {
      const v = roomView(spy, 778.55)!;
      const atr = spy.atr14!;
      // PDL + PMH 775.14 to 775.16 below the close is support; PDH + PWH + 52WH above is resistance.
      const sup = v.zones.find((z) => z.zone.members?.includes("PDL"))!;
      expect(sup.tone).toBe("support");
      expect(sup.to).toBeCloseTo((775.16 - 778.55) / atr, 6);
      expect(v.zones.find((z) => z.zone.members?.includes("PDH"))!.tone).toBe("resistance");
      expect(v.zones.every((z) => z.from >= -ROOM_REACH && z.to <= ROOM_REACH)).toBe(true);
      // The 52-week low is far below: left off the bar.
      expect(v.zones.some((z) => z.zone.members?.includes("52WL"))).toBe(false);
      expect(v.em).toBeCloseTo(spy.expected_move!.day! / atr, 6);
      expect(v.down).toBe(775.16);
      // A price inside a zone marks it "at".
      expect(roomView(spy, 780.43)!.zones.find((z) => z.zone.members?.includes("PDH"))!.tone).toBe("at");
      expect(roomView({ ...spy, atr14: null }, 778.55)).toBeNull();
    });

    it("frames the level map around the bars and the week's expected move, dropping far zones", () => {
      const v = mapView(spy)!;
      expect(v.bars).toHaveLength(40);
      const lows = Math.min(...v.bars.map((b) => b.l));
      expect(v.lo).toBeLessThan(lows);
      expect(v.hi).toBeGreaterThan(spy.last!.close + spy.expected_move!.week!);
      expect(v.zones.some((z) => z.zone.members?.includes("52WL"))).toBe(false);
      expect(v.zones.every((z) => (z.tone === "support" ? z.zone.hi < spy.last!.close : z.zone.lo > spy.last!.close))).toBe(true);
      // Without bars it still frames the close and the expected move.
      const bare = mapView({ ...spy, bars: undefined })!;
      expect(bare.bars).toHaveLength(0);
      expect(bare.lo).toBeLessThan(spy.last!.close - spy.expected_move!.week!);
      expect(mapView({ ...spy, last: null })).toBeNull();
    });

    it("picks round gridline steps and keeps labels apart", () => {
      expect(niceStep(50, 5)).toBe(10);
      expect(niceStep(7, 5)).toBe(1);
      expect(niceStep(0.3, 5)).toBeCloseTo(0.05, 9);
      expect(spreadLabels([10, 12, 100], 20, 0, 200)).toEqual([10, 30, 100]);
      // Kept inside the bottom edge, in input order.
      expect(spreadLabels([195, 190], 20, 0, 200)).toEqual([200, 180]);
    });
  });
  describe("live layer", () => {
    const e = optionsJson as unknown as Options;
    const spy = e.tickers.find((t) => t.symbol === "SPY")!;
    const S = e.session;
    const q = (price: number, at: string): LiveQuote => ({ price, at, open: 778.55, high: null, low: null, day: S, prev_close: 778.55 });
    const at = (ny: string) => `${S}T${ny}-04:00`;
    const ms = (iso: string) => Date.parse(iso);

    it("keeps a trail of newer prices over the last few minutes", () => {
      let trail = extendTrail([], q(779, at("10:00:00")));
      trail = extendTrail(trail, q(779.5, at("10:00:02")));
      // The same trade again, or an older one, adds nothing.
      trail = extendTrail(trail, q(779.5, at("10:00:02")));
      trail = extendTrail(trail, q(778, at("09:59:00")));
      expect(trail.map((x) => x.p)).toEqual([779, 779.5]);
      // Points older than the trail's reach drop off.
      trail = extendTrail(trail, q(780, new Date(ms(at("10:00:01")) + TRAIL_MS).toISOString()));
      expect(trail.map((x) => x.p)).toEqual([779.5, 780]);
    });

    it("reads a live quote, and calls it stale after 30 seconds", () => {
      const quote = q(781, at("11:00:00"));
      const fresh = liveRead(spy, quote, S, ms(at("11:00:05")), ms(at("11:00:04")));
      expect(fresh).toMatchObject({ price: 781, state: "TESTING RESISTANCE", inSession: true, stale: false, ageS: 5 });
      const old = liveRead(spy, quote, S, ms(at("11:00:00")) + STALE_MS + 1000, ms(at("11:00:30")));
      expect(old.stale).toBe(true);
      // A fresh trade but a feed that stopped answering is stale too.
      expect(liveRead(spy, quote, S, ms(at("11:00:40")), ms(at("11:00:01"))).stale).toBe(true);
      // Outside the session the price is the close and nothing is stale.
      const shut = liveRead(spy, q(781, at("16:30:00")), S, ms(at("17:30:00")), ms(at("17:30:00")));
      expect(shut).toMatchObject({ price: spy.last!.close, inSession: false, stale: false });
      expect(liveRead(spy, undefined, S, null, null)).toMatchObject({ price: spy.last!.close, state: null });
    });

    it("sorts names testing a major zone first, then gaps, and keeps order otherwise", () => {
      const read = (state: string | null, stale = false) => ({ price: 1, state, inSession: state !== null, stale, ageS: 0, q: null }) as ReturnType<typeof liveRead>;
      const rows = [
        { s: "A", r: read("INSIDE") },
        { s: "B", r: read("TESTING SUPPORT", true) },
        { s: "C", r: read("GAP ABOVE") },
        { s: "D", r: read("TESTING RESISTANCE") },
        { s: "E", r: read("INSIDE") },
        { s: "F", r: read(null) },
      ];
      expect(needsALook(rows, (x) => x.r).map((x) => x.s)).toEqual(["D", "B", "C", "A", "E", "F"]);
      // Out of session nothing moves.
      const shut = rows.map((x) => ({ ...x, r: read(null) }));
      expect(needsALook(shut, (x) => x.r).map((x) => x.s)).toEqual(["A", "B", "C", "D", "E", "F"]);
    });

    it("walks the live dot across the session", () => {
      expect(sessionShare(spy, at("09:30:00"))).toBe(0);
      expect(sessionShare(spy, at("12:45:00"))).toBeCloseTo(0.5, 6);
      expect(sessionShare(spy, at("16:00:00"))).toBe(1);
      expect(sessionShare({ ...spy, half_day: true }, at("11:15:00"))).toBeCloseTo(0.5, 6);
    });
  });
  it("places names on the close strength vs option price map and names the corners", () => {
    const e = optionsJson as unknown as Options;
    const v = structureView(e.tickers);
    expect(v.points).toHaveLength(10);
    expect(v.missing).toEqual([]);
    // NVDA closed at 5% of its range with options at the 2nd percentile; META weak with options at the 83rd.
    expect(v.corners["weak-cheap"]).toEqual(["NVDA"]);
    expect(v.corners["weak-rich"]).toEqual(["META"]);
    expect(v.corners["strong-cheap"]).toEqual(["SPY"]);
    expect(v.corners["strong-rich"]).toEqual(["MSFT", "AMZN"]);
    const gap = structureView([{ ...e.tickers[0]!, expected_move: null }]);
    expect(gap).toMatchObject({ points: [], missing: ["SPY"] });
  });
  it("marks every finding exploratory and words the page for single calls and puts", () => {
    const e = optionsJson as unknown as Options;
    const found = findingsOf(e);
    // No finding has a registered experiment behind it yet, so none may read as a result.
    expect(found).toHaveLength(3);
    expect(found.every((f) => f.exploratory)).toBe(true);
    // The expected-move check comes from the edition: 85% of 500 days, against the one-sigma share.
    expect(found[2]).toMatchObject({ value: 85, base: ONE_SIGMA_PCT, valueLabel: "of 500 days, SPY vs VIX, 2 years to 9 Oct 2026" });
    expect(found[2]!.use).toContain("within a week 30% of the time");
    // An edition without the check shows the two fixed figures only.
    expect(findingsOf({ ...e, expected_move_check: null })).toHaveLength(2);
    // The owner trades single calls and puts: nothing on the page may suggest a spread or selling premium.
    const copy = [...found.flatMap((f) => [f.title, f.use, f.valueLabel, f.baseLabel ?? ""]), ...Object.values(CORNER_COST)].join(" ");
    expect(copy).not.toMatch(/spread|selling premium|credit|debit/i);
    expect(CORNER_COST["weak-cheap"]).toBe(CORNER_COST["strong-cheap"]);
    expect(CORNER_COST["weak-rich"]).toBe(CORNER_COST["strong-rich"]);
  });
});
