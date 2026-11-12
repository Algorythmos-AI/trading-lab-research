// The board's bad-data guards (quote-guards.ts) and the quote's shape (quote-shape.ts): each guard switched off, on
// and tripped, on and not tripped, at its exact boundary and with its inputs missing; where they sit in the engine's
// order; the page and the server agreeing with each switch on and off; and the probe and the guards reading every
// definition alike. Times are UTC instants; nothing depends on the machine's time zone.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NowHero } from "@/components/client/now-hero";
import { type Board, BoardContext, TradeNowBoard } from "@/components/client/trade-now";
import { evaluateSlot, stateRows } from "@/lib/desk-eval";
import { suspectQuote, suspectReasonFor } from "@/lib/fixture-suspect";
import { SCRIPT_ANSWER_LAG_MS, SCRIPT_SYMBOLS, scriptBars, scriptQuote, stepInstant } from "@/lib/fixture-script";
import { focusOptions } from "@/lib/fixture-variants";
import type { LiveQuote, Options } from "@/lib/options";
import { normalise } from "@/lib/quote";
import { activeGuards, GUARD_REASONS, type GuardQuote, type GuardReason, guardLine, PRIOR_CLOSE_LIMIT, priorMove, quoteGuards } from "@/lib/quote-guards";
import { type NameFacts, probeSnapshot } from "@/lib/quote-probe";
import { QUOTE_SHAPES, quoteShape } from "@/lib/quote-shape";
import { type BoardInput, boardRows, rowView } from "@/lib/trade-now";
import { CLOSE_GRACE_MS, SERVER_SETTLE_MS } from "@/lib/trade-state";
import optionsJson from "./fixtures/options.v1.json";

const ALL: GuardReason[] = [...GUARD_REASONS];

// ---- the quote's shape ----------------------------------------------------------------------------------------------
describe("quoteShape", () => {
  it("reads every shape, with the spread in basis points of the mid", () => {
    expect(quoteShape(99.98, 100.02, 1, 1)).toEqual({ shape: "normal", spread_bps: 4 });
    expect(quoteShape(100, 100, 5, 5)).toEqual({ shape: "locked", spread_bps: 0 });
    expect(quoteShape(100.02, 99.98, 1, 1)).toEqual({ shape: "crossed", spread_bps: -4 });
    expect(quoteShape(0, 100)).toEqual({ shape: "one-sided", spread_bps: null });
    expect(quoteShape(100, 0)).toEqual({ shape: "one-sided", spread_bps: null });
    expect(quoteShape(0, 0)).toEqual({ shape: "empty", spread_bps: null });
    // no sizes sent: each side goes by its price
    expect(quoteShape(99.98, 100.02)).toEqual({ shape: "normal", spread_bps: 4 });
    expect(quoteShape(99.98, 100.02, null, null)).toEqual({ shape: "normal", spread_bps: 4 });
  });

  it("a zero size is no active side, like a zero price: one-sided or empty, never crossed", () => {
    expect(quoteShape(100.02, 99.98, 0, 1).shape).toBe("one-sided");
    expect(quoteShape(100.02, 99.98, 1, 0).shape).toBe("one-sided");
    expect(quoteShape(100.02, 99.98, 0, 0).shape).toBe("empty");
    expect(quoteShape(0, 99.98, 1, 0).shape).toBe("empty");
    expect(quoteShape(100.02, 0, 1, 1).shape).toBe("one-sided");
  });

  it("anything it cannot read is invalid, and it never throws", () => {
    for (const [b, a, bs, as] of [
      [-1, 100, 1, 1],
      [100, -0.01, 1, 1],
      ["100", 100, 1, 1],
      [100, Number.NaN, 1, 1],
      [100, Number.POSITIVE_INFINITY, 1, 1],
      [99, 100, -1, 1],
      [99, 100, 1, "5"],
      [undefined, 100, 1, 1],
      [null, null, null, null],
      [{}, [], 1, 1],
    ] as unknown[][])
      expect(quoteShape(b, a, bs, as), JSON.stringify([b, a, bs, as])).toEqual({ shape: "invalid", spread_bps: null });
  });

  it("names every shape it can give", () => {
    const seen = new Set([quoteShape(1, 2).shape, quoteShape(2, 2).shape, quoteShape(3, 2).shape, quoteShape(0, 2).shape, quoteShape(0, 0).shape, quoteShape(-1, 2).shape]);
    expect([...seen].sort()).toEqual([...QUOTE_SHAPES].sort());
  });
});

// ---- the guards on one quote -----------------------------------------------------------------------------------------
const T = "2026-10-12T14:30:00.000Z";
/** A healthy quote the guards can read in full: nothing trips. */
const healthy = (over: Partial<GuardQuote> = {}): GuardQuote => ({
  price: 100,
  at: T,
  open: 99,
  high: 101,
  low: 98,
  prev_close: 98,
  bar_ok: true,
  prev_bar_ok: true,
  bid: 99.99,
  ask: 100.01,
  bid_size: 3,
  ask_size: 2,
  ...over,
});

describe("quoteGuards", () => {
  it("a healthy quote, no quote at all, and an old quote without the snapshot's fields trip nothing", () => {
    expect(quoteGuards(healthy())).toEqual([]);
    expect(quoteGuards(null)).toEqual([]);
    expect(quoteGuards(undefined)).toEqual([]);
    expect(quoteGuards({ price: 100, at: T, open: 120, high: 90, low: 95, prev_close: 10 })).toEqual([]);
  });

  it("the day bar's high below its low trips it (and so does the open, which cannot be inside such a range)", () => {
    expect(quoteGuards(healthy({ high: 97.99 }))).toEqual(["bar-high-below-low", "bar-open-outside-range"]);
    // at the boundary: a high equal to the low is not below it
    expect(quoteGuards(healthy({ open: 98, high: 98, low: 98 }))).toEqual([]);
  });

  it("the day bar's open outside its high and low trips it; on either edge it does not", () => {
    expect(quoteGuards(healthy({ open: 101.01 }))).toEqual(["bar-open-outside-range"]);
    expect(quoteGuards(healthy({ open: 97.99 }))).toEqual(["bar-open-outside-range"]);
    expect(quoteGuards(healthy({ open: 101 }))).toEqual([]);
    expect(quoteGuards(healthy({ open: 98 }))).toEqual([]);
  });

  it("the bar guards need a readable bar: no bar_ok, a missing or non-positive price, nothing trips", () => {
    for (const over of [{ bar_ok: false }, { bar_ok: undefined }, { high: null }, { low: null }, { open: null }, { open: 0 }, { low: -1 }] as Partial<GuardQuote>[]) {
      expect(quoteGuards(healthy({ high: 97, ...over })), JSON.stringify(over)).toEqual([]);
      expect(quoteGuards(healthy({ open: 120, ...over })), JSON.stringify(over)).toEqual([]);
    }
  });

  it("more than 25% from the prior close trips it, either way; exactly 25% is at the limit and does not", () => {
    expect(PRIOR_CLOSE_LIMIT).toBe(0.25);
    const far = (price: number, prev: number) => quoteGuards(healthy({ price, prev_close: prev, open: price, high: price, low: price, bid: price - 0.01, ask: price + 0.01 }));
    expect(far(125.01, 100)).toEqual(["price-far-from-prior-close"]);
    expect(far(74.99, 100)).toEqual(["price-far-from-prior-close"]);
    expect(far(125, 100)).toEqual([]);
    expect(far(75, 100)).toEqual([]);
    expect(far(12.75, 10.2)).toEqual([]); // 25% in floating point: at the limit by the probe's own tolerance
    expect(priorMove(12.75, 10.2).move).toBe("at-limit");
    expect(far(12.7501, 10.2)).toEqual(["price-far-from-prior-close"]);
    expect(far(124.99, 100)).toEqual([]);
  });

  it("the prior-close guard needs a readable prior bar and trade: without them nothing trips", () => {
    const base = { price: 200, open: 200, high: 200, low: 200, bid: 199.99, ask: 200.01 };
    expect(quoteGuards(healthy({ ...base, prev_close: 100 }))).toEqual(["price-far-from-prior-close"]);
    for (const over of [{ prev_bar_ok: false }, { prev_bar_ok: undefined }, { prev_close: null }, { prev_close: 0 }, { at: "nope" }, { at: "0001-01-01T00:00:00Z" }] as Partial<GuardQuote>[])
      expect(quoteGuards(healthy({ ...base, prev_close: 100, ...over })), JSON.stringify(over)).toEqual([]);
  });

  it("a crossed quote trips it; locked, one-sided, empty or a quote it cannot read does not", () => {
    expect(quoteGuards(healthy({ bid: 100.02, ask: 99.98 }))).toEqual(["quote-crossed"]);
    expect(quoteGuards(healthy({ bid: 100.02, ask: 99.98, bid_size: undefined, ask_size: undefined }))).toEqual(["quote-crossed"]);
    expect(quoteGuards(healthy({ bid: 100, ask: 100 }))).toEqual([]);
    expect(quoteGuards(healthy({ bid: 100.02, ask: 99.98, bid_size: 0 }))).toEqual([]);
    expect(quoteGuards(healthy({ bid: 100.02, ask: 99.98, ask_size: 0 }))).toEqual([]);
    expect(quoteGuards(healthy({ bid: 100.02, ask: 0 }))).toEqual([]);
    expect(quoteGuards(healthy({ bid: 0, ask: 0 }))).toEqual([]);
    expect(quoteGuards(healthy({ bid: undefined }))).toEqual([]);
    expect(quoteGuards(healthy({ ask: undefined }))).toEqual([]);
    expect(quoteGuards(healthy({ bid: -1, ask: -2 }))).toEqual([]);
  });

  it("names every reason that applies, in the board's order, and its switch decides whether it pauses", () => {
    const bad = healthy({ high: 97, prev_close: 50, bid: 100.02, ask: 99.98 });
    expect(quoteGuards(bad)).toEqual(ALL);
    expect(activeGuards(quoteGuards(bad), [])).toEqual([]);
    expect(activeGuards(quoteGuards(bad), undefined)).toEqual([]);
    expect(activeGuards(quoteGuards(bad), null)).toEqual([]);
    expect(activeGuards(quoteGuards(bad), ["quote-crossed"])).toEqual(["quote-crossed"]);
    expect(activeGuards(quoteGuards(bad), ["quote-crossed", "bar-high-below-low"])).toEqual(["bar-high-below-low", "quote-crossed"]);
    expect(activeGuards(quoteGuards(healthy()), ALL)).toEqual([]);
  });

  it("says the reason in the page's plain words, after the paused wording the board already uses", () => {
    expect(guardLine(["bar-high-below-low"])).toBe("Suspect data, the day's high reads below its low: check your platform");
    expect(guardLine(["bar-open-outside-range"])).toBe("Suspect data, the day's open reads outside its high and low: check your platform");
    expect(guardLine(["price-far-from-prior-close"])).toBe("Suspect data, the price is more than 25% from the prior close: check your platform");
    expect(guardLine(["quote-crossed"])).toBe("Suspect data, the bid is above the ask: check your platform");
    expect(guardLine(["bar-high-below-low", "bar-open-outside-range"])).toBe(
      "Suspect data, the day's high reads below its low and the day's open reads outside its high and low: check your platform",
    );
  });
});

// ---- the snapshot's quote reaches the engine ----------------------------------------------------------------------------
const NOW = Date.parse("2026-10-12T14:30:30Z");
const iso = (t: number) => new Date(t).toISOString();
function snap(over: Record<string, unknown> = {}) {
  return {
    latestTrade: { t: iso(NOW - 1_000), x: "V", p: 100, s: 10, c: ["@"], i: 1, z: "C" },
    latestQuote: { t: iso(NOW - 2_000), ax: "V", ap: 100.02, as: 1, bx: "V", bp: 99.98, bs: 1, c: ["R"], z: "B" },
    minuteBar: { t: iso(Date.parse("2026-10-12T14:30:00Z")), o: 100, h: 100.1, l: 99.9, c: 100, v: 5, n: 2, vw: 100 },
    dailyBar: { t: "2026-10-12T04:00:00Z", o: 99, h: 101, l: 98, c: 100, v: 1000, n: 50, vw: 99.5 },
    prevDailyBar: { t: "2026-10-09T04:00:00Z", o: 97, h: 99, l: 96, c: 98, v: 900, n: 40, vw: 97.5 },
    ...over,
  };
}

describe("normalise reads the snapshot's quote", () => {
  it("keeps the two sides, their sizes and the quote's time, and says both bars are readable", () => {
    expect(normalise(snap())).toMatchObject({ bid: 99.98, ask: 100.02, bid_size: 1, ask_size: 1, quote_at: iso(NOW - 2_000), bar_ok: true, prev_bar_ok: true });
  });

  it("leaves the quote out when it cannot be read, a size out when none was sent, the time out when unreadable", () => {
    for (const q of [undefined, null, "x", [], { bp: -1, ap: 100 }, { bp: 99, ap: 100, bs: "1" }, { bp: "99", ap: 100 }]) {
      const n = normalise(snap({ latestQuote: q }))!;
      expect(n, JSON.stringify(q)).not.toHaveProperty("bid");
      expect(n).not.toHaveProperty("ask");
      expect(n).not.toHaveProperty("quote_at");
    }
    const noSizes = normalise(snap({ latestQuote: { t: "nope", bp: 99, ap: 100 } }))!;
    expect(noSizes).toMatchObject({ bid: 99, ask: 100 });
    expect(noSizes).not.toHaveProperty("bid_size");
    expect(noSizes).not.toHaveProperty("ask_size");
    expect(noSizes).not.toHaveProperty("quote_at");
    expect(normalise(snap({ latestQuote: { bp: 0, ap: 0, bs: 0, as: 0 } }))).toMatchObject({ bid: 0, ask: 0, bid_size: 0, ask_size: 0 });
  });

  it("marks a bar the probe cannot read: not positive, no close, no readable time", () => {
    expect(normalise(snap({ dailyBar: { t: "2026-10-12T04:00:00Z", o: 99, h: 101, l: 98, c: 0 } }))!.bar_ok).toBe(false);
    expect(normalise(snap({ dailyBar: { t: "0001-01-01T00:00:00Z", o: 99, h: 101, l: 98, c: 100 } }))!.bar_ok).toBe(false);
    expect(normalise(snap({ dailyBar: null }))!.bar_ok).toBe(false);
    expect(normalise(snap({ prevDailyBar: { t: "2026-10-09T04:00:00Z", o: 97, h: 99, l: 96 } }))!.prev_bar_ok).toBe(false);
  });

  it("the fields it already had are unchanged", () => {
    const n = normalise(snap())!;
    expect({ price: n.price, at: n.at, open: n.open, high: n.high, low: n.low, day: n.day, prev_close: n.prev_close, vwap: n.vwap }).toEqual({
      price: 100,
      at: iso(NOW - 1_000),
      open: 99,
      high: 101,
      low: 98,
      day: "2026-10-12",
      prev_close: 98,
      vwap: 99.5,
    });
  });
});

// ---- the probe and the guards read alike ----------------------------------------------------------------------------------
/** The guard reasons the probe's facts say would apply. */
function probeReasons(f: NameFacts): GuardReason[] {
  const out: GuardReason[] = [];
  if (f.high_below_low === true) out.push("bar-high-below-low");
  if (f.open_outside === true) out.push("bar-open-outside-range");
  if (f.prior_move === "beyond") out.push("price-far-from-prior-close");
  if (f.quote === "crossed") out.push("quote-crossed");
  return out;
}

/** Snapshots over every shape the guards read: each part healthy, at a boundary, tripped, missing or unreadable. */
function snapshots(): Record<string, unknown>[] {
  const days: unknown[] = [
    { t: "2026-10-12T04:00:00Z", o: 99, h: 101, l: 98, c: 100 },
    { t: "2026-10-12T04:00:00Z", o: 99, h: 97, l: 98, c: 100 },
    { t: "2026-10-12T04:00:00Z", o: 98, h: 98, l: 98, c: 98 },
    { t: "2026-10-12T04:00:00Z", o: 101.5, h: 101, l: 98, c: 100 },
    { t: "2026-10-12T04:00:00Z", o: 97.5, h: 101, l: 98, c: 100 },
    { t: "2026-10-12T04:00:00Z", o: 101, h: 101, l: 98, c: 100 },
    { t: "2026-10-12T04:00:00Z", o: 99, h: 97, l: 98, c: 0 },
    { t: "2026-10-12T04:00:00Z", o: 99, h: 97, l: 98 },
    { t: "0001-01-01T00:00:00Z", o: 99, h: 97, l: 98, c: 100 },
    { o: 99, h: 97, l: 98, c: 100 },
    { t: "2026-10-12T04:00:00Z", o: "99", h: 97, l: 98, c: 100 },
    null,
    undefined,
    "bar",
  ];
  const prevs: unknown[] = [
    { t: "2026-10-09T04:00:00Z", o: 97, h: 99, l: 96, c: 98 },
    { t: "2026-10-09T04:00:00Z", o: 70, h: 80, l: 70, c: 80 },
    { t: "2026-10-09T04:00:00Z", o: 70, h: 80, l: 70, c: 80.1 },
    { t: "2026-10-09T04:00:00Z", o: 120, h: 140, l: 120, c: 133.33 },
    { t: "2026-10-09T04:00:00Z", o: 70, h: 80, l: 70, c: 79.9 },
    { t: "2026-10-09T04:00:00Z", o: 0, h: 80, l: 70, c: 70 },
    { t: "nope", o: 70, h: 80, l: 70, c: 70 },
    null,
    undefined,
  ];
  const quotes: unknown[] = [
    { t: iso(NOW - 2_000), bp: 99.98, ap: 100.02, bs: 1, as: 1 },
    { t: iso(NOW - 2_000), bp: 100.02, ap: 99.98, bs: 1, as: 1 },
    { t: iso(NOW - 2_000), bp: 100, ap: 100, bs: 1, as: 1 },
    { bp: 100.02, ap: 99.98 },
    { bp: 100.02, ap: 99.98, bs: 0, as: 1 },
    { bp: 100.02, ap: 99.98, bs: 1, as: 0 },
    { bp: 100.02, ap: 0, bs: 1, as: 1 },
    { bp: 0, ap: 0 },
    { bp: 100.02, ap: 99.98, bs: null, as: null },
    { bp: 100.02, ap: 99.98, bs: "1", as: 1 },
    { bp: -1, ap: 99.98 },
    "quote",
    null,
    undefined,
  ];
  const trades: unknown[] = [
    { t: iso(NOW - 1_000), p: 100 },
    { t: "0001-01-01T00:00:00Z", p: 100 },
    { t: iso(NOW - 1_000), p: 0 },
    null,
  ];
  const out: Record<string, unknown>[] = [];
  for (const d of days) for (const p of prevs) for (const q of quotes) for (const t of trades) out.push(snap({ dailyBar: d, prevDailyBar: p, latestQuote: q, latestTrade: t }));
  return out;
}

describe("the probe and the guards", () => {
  it("read every definition alike: the same snapshots give the same reasons, and a snapshot without a usable trade is paused by the stale check instead", () => {
    const all = snapshots();
    expect(all.length).toBeGreaterThan(5_000);
    let compared = 0;
    let tripped = 0;
    for (const raw of all) {
      const f = probeSnapshot("SPY", raw, NOW);
      expect(f.source).toBe("fetched");
      const q = normalise(raw as Parameters<typeof normalise>[0]);
      if (q === null) {
        // no usable last trade: no quote reaches the engine, and the stale check pauses the name ("No price yet")
        expect((f as NameFacts).trade).not.toBe("ok");
        continue;
      }
      compared++;
      const want = probeReasons(f as NameFacts);
      if (want.length) tripped++;
      expect(quoteGuards(q), JSON.stringify(raw)).toEqual(want);
      // and the shape and spread are one definition
      const lq = (raw as { latestQuote?: { bp?: unknown; ap?: unknown; bs?: unknown; as?: unknown } }).latestQuote;
      if (lq && typeof lq === "object" && !Array.isArray(lq)) {
        expect(quoteShape(lq.bp, lq.ap, lq.bs, lq.as).shape).toBe((f as NameFacts).quote);
        expect(quoteShape(lq.bp, lq.ap, lq.bs, lq.as).spread_bps).toBe((f as NameFacts).spread_bps);
      }
    }
    expect(compared).toBeGreaterThan(3_000);
    expect(tripped).toBeGreaterThan(500);
  });
});

// ---- the guards on the board ----------------------------------------------------------------------------------------------
const E = focusOptions(optionsJson as unknown as Options, true);
const S = E.session; // 2026-10-12, a Monday on EDT
const ITEMS = E.focus!.items;

function atStep(step: number, bend: (sym: string, q: LiveQuote, i: number) => LiveQuote = (_s, q) => q, over: Partial<BoardInput> = {}): BoardInput {
  const quotes: Record<string, LiveQuote> = {};
  SCRIPT_SYMBOLS.forEach((s, i) => {
    quotes[s] = bend(s, scriptQuote(s, S, step)!, i);
  });
  const at = stepInstant(S, step) + SCRIPT_ANSWER_LAG_MS;
  return {
    session: S,
    halfDay: false,
    items: ITEMS,
    tickers: E.tickers,
    quotes,
    trails: {},
    serverBars: Object.fromEntries(ITEMS.map((i) => [i.symbol, scriptBars(i.symbol, S, step)])),
    serverFetchedAt: Object.fromEntries(ITEMS.map((i) => [i.symbol, stepInstant(S, step) + SERVER_SETTLE_MS])),
    now: at + 1_000,
    receivedAt: at,
    dayLimitUsed: false,
    wonToday: false,
    ...over,
  };
}
const crossedQQQ = (s: string, q: LiveQuote) => (s === "QQQ" ? suspectQuote(q, "quote-crossed") : q);
const states = (input: BoardInput) => Object.fromEntries(boardRows(input, true).map((r) => [r.symbol, r.state!]));

describe("a guard on the board", () => {
  it("off, the suspect quote changes nothing; on and tripped, the name is paused with its reason; on and not tripped, nothing changes", () => {
    expect(states(atStep(3)).QQQ!.state).toBe("enter_zone");
    expect(boardRows(atStep(3, crossedQQQ), true)).toEqual(boardRows(atStep(3), true));
    expect(boardRows(atStep(3, crossedQQQ, { guards: { on: [] } }), true)).toEqual(boardRows(atStep(3), true));
    const on = states(atStep(3, crossedQQQ, { guards: { on: ["quote-crossed"] } }));
    expect(on.QQQ).toMatchObject({ state: "paused", tone: "neutral", line: "Suspect data, the bid is above the ask: check your platform", guards: ["quote-crossed"], cautions: [], alt: null, plan: null });
    expect(rowView(on.QQQ!)).toEqual({ badge: { word: "PRICES PAUSED", tone: "neutral", side: null, alt: null }, testing: false, headline: "Suspect data, the bid is above the ask: check your platform", grid: null });
    // only the guard that is on pauses: another guard's switch leaves a crossed quote alone
    expect(boardRows(atStep(3, crossedQQQ, { guards: { on: ["bar-high-below-low", "price-far-from-prior-close"] } }), true)).toEqual(boardRows(atStep(3), true));
    // every guard on, healthy quotes: nothing changes
    expect(boardRows(atStep(3, undefined, { guards: { on: ALL } }), true)).toEqual(boardRows(atStep(3), true));
  });

  it("a paused name never reads enter zone, at any step, with any guard tripped", () => {
    for (let step = 0; step < 6; step++)
      for (const g of GUARD_REASONS) {
        const rows = boardRows(atStep(step, (_s, q) => suspectQuote(q, g), { guards: { on: [g] } }), true);
        for (const r of rows) {
          if (r.state!.state !== "paused") continue;
          expect(r.state!.guards).toContain(g);
          expect(rowView(r.state!).badge.word).not.toBe("ENTER ZONE");
          expect(r.runner).toBeNull();
        }
        // in the session from the open, every scripted name with a quote is paused: none reads an entry
        if (step > 0) expect(rows.every((r) => r.state!.state === "paused")).toBe(true);
      }
  });

  it("sits with the stale check: after it (no fresh price says so first), before the clock gates and every state", () => {
    // stale and suspect: the stale line, no guard named
    const stale = states(atStep(3, crossedQQQ, { guards: { on: ALL }, receivedAt: stepInstant(S, 3) - 60_000 }));
    expect(stale.QQQ!.state).toBe("paused");
    expect(stale.QQQ!.line).toMatch(/^No new price for \d+ s: check your platform$/);
    expect(stale.QQQ!.guards).toBeUndefined();
    // AAPL sits in the middle of yesterday's range (no trade) at step 3: a tripped guard pauses it all the same
    const bentAapl = states(atStep(3, (s, q) => (s === "AAPL" ? suspectQuote(q, "bar-open-outside-range") : q), { guards: { on: ALL } }));
    expect(bentAapl.AAPL).toMatchObject({ state: "paused", guards: ["bar-open-outside-range"] });
    // the opening range (09:30 to 09:35) and lunch are clock gates: the guard comes first, in the session
    const at = (hhmm: string) => Date.parse(`${S}T${hhmm}:00-04:00`);
    for (const hhmm of ["09:31", "11:45", "15:20"]) {
      const t = at(hhmm);
      const quotes = Object.fromEntries(Object.entries(atStep(3).quotes).map(([s, q]) => [s, { ...suspectQuote(q, "quote-crossed"), at: new Date(t - 1_000).toISOString() }]));
      const rows = boardRows(atStep(3, undefined, { quotes, now: t, receivedAt: t - 500, serverBars: {}, serverFetchedAt: {}, guards: { on: ["quote-crossed"] } }), true);
      expect(rows.map((r) => r.state!.state), hhmm).toEqual(rows.map(() => "paused"));
    }
    // outside the session the stale check does not run, and neither do the guards: the clock's no trade stands
    for (const hhmm of ["09:20", "16:05"]) {
      const t = at(hhmm);
      const quotes = Object.fromEntries(Object.entries(atStep(3).quotes).map(([s, q]) => [s, { ...suspectQuote(q, "quote-crossed"), at: new Date(t - 1_000).toISOString() }]));
      const rows = boardRows(atStep(3, undefined, { quotes, now: t, receivedAt: t - 500, serverBars: {}, serverFetchedAt: {}, guards: { on: ALL } }), true);
      expect(rows.every((r) => r.state!.state === "no_trade" && r.state!.guards === undefined), hhmm).toBe(true);
    }
  });

  it("reads the guard quote it is given, when it is another day's quote, nothing trips", () => {
    const base = atStep(3);
    const yesterday = { ...suspectQuote(base.quotes.QQQ!, "quote-crossed"), day: "2026-10-09" };
    expect(boardRows({ ...base, guards: { on: ALL, quotes: { QQQ: yesterday } } }, true)).toEqual(boardRows(base, true));
    // and no guard quote for a name: nothing trips for it
    expect(boardRows({ ...base, guards: { on: ALL, quotes: {} } }, true)).toEqual(boardRows(base, true));
  });

  it("the board names the reason on its own line, apart from the names paused for no fresh price", () => {
    const rows = boardRows(atStep(3, crossedQQQ, { guards: { on: ["quote-crossed"] } }), true);
    const html = renderToStaticMarkup(createElement(TradeNowBoard, { mode: { kind: "live" }, rows, now: atStep(3).now, paused: false, onOpen: () => undefined }));
    expect(html).toContain('data-board-guard="QQQ"');
    expect(html).toContain('data-board-guards="quote-crossed"');
    expect(html.replaceAll("&#x27;", "'")).toContain("QQQ: prices paused. Suspect data, the bid is above the ask: check your platform");
    expect(html).not.toContain("data-board-paused");
    expect(html).not.toContain('data-board-state="enter_zone"');
  });
});

// ---- page and server agree ------------------------------------------------------------------------------------------------
describe("the page and the server", () => {
  /** The page at a slot's close and the server for that slot, on the same snapshot (each guard in turn by name). */
  function both(step: number, on: readonly GuardReason[] | undefined, bend: boolean) {
    const runAt = stepInstant(S, step) + 90_000;
    const end = Math.floor((runAt - SERVER_SETTLE_MS) / 120_000) * 120_000;
    const snapshots: Record<string, LiveQuote> = {};
    SCRIPT_SYMBOLS.forEach((s, i) => {
      const q = { ...scriptQuote(s, S, step)!, at: new Date(end - 1_000).toISOString() };
      snapshots[s] = bend ? suspectQuote(q, suspectReasonFor(i)) : q;
    });
    const bars = Object.fromEntries(ITEMS.map((i) => [i.symbol, scriptBars(i.symbol, S, step)]));
    const server = evaluateSlot({ slot: { day: S, end }, edition: E, journal: null, done: false, bars, fetchedAt: Object.fromEntries(ITEMS.map((i) => [i.symbol, runAt])), snapshots, ...(on ? { guardsOn: on } : {}) });
    const settled = Object.fromEntries(Object.entries(bars).map(([s, b]) => [s, b.filter((x) => x.end <= end)]));
    const now = end + CLOSE_GRACE_MS;
    const page = boardRows(
      { ...atStep(step), quotes: snapshots, serverBars: settled, serverFetchedAt: Object.fromEntries(ITEMS.map((i) => [i.symbol, end + SERVER_SETTLE_MS])), now, receivedAt: now - 500, ...(on ? { guards: { on } } : {}) },
      true,
    );
    return { server, page: page.flatMap((r) => stateRows(r.state!)), snapshots };
  }

  it("a tripped guard that is on pauses the name on both; with it off, or untripped, it changes neither", () => {
    for (let step = 1; step < 6; step++) {
      const off = both(step, undefined, true);
      const plain = both(step, undefined, false);
      const words = (rows: { symbol: string; side: string; state: string }[]) => rows.map((r) => `${r.symbol}/${r.side}:${r.state}`);
      expect(words(off.server.rows)).toEqual(words(plain.server.rows));
      for (const g of GUARD_REASONS) {
        const on = both(step, [g], true);
        const plainOn = both(step, [g], false);
        // healthy data with the switch on: as with it off
        expect(plainOn.server).toEqual(plain.server);
        expect(plainOn.page).toEqual(plain.page);
        for (const sym of ITEMS.map((i) => i.symbol)) {
          const trips = activeGuards(quoteGuards(on.snapshots[sym]), [g]).length > 0;
          const srv = on.server.rows.filter((r) => r.symbol === sym).map((r) => r.state);
          const pg = on.page.filter((r) => r.symbol === sym).map((r) => r.state);
          if (trips) {
            expect(srv, `${step} ${g} ${sym}`).toEqual(["paused", "paused"]);
            expect(pg, `${step} ${g} ${sym}`).toEqual(["paused", "paused"]);
          } else {
            // not tripped for this name: each side reads it exactly as with the switch off
            expect(srv).toEqual(off.server.rows.filter((r) => r.symbol === sym).map((r) => r.state));
            expect(pg).toEqual(off.page.filter((r) => r.symbol === sym).map((r) => r.state));
          }
        }
      }
    }
  });

  it("the server's stale flag stays for no fresh price: a guard's pause is not counted as stale", () => {
    const on = both(3, ALL, true);
    expect(on.server.rows.some((r) => r.state === "paused")).toBe(true);
    expect(on.server.day.stale).toBe(false);
  });
});

// ---- the hero -------------------------------------------------------------------------------------------------------
describe("the hero on a name a guard paused", () => {
  function heroBoard(input: BoardInput): Board {
    const rows = boardRows(input, true);
    const qqq = rows.find((r) => r.symbol === "QQQ")!;
    const ordered = [qqq, ...rows.filter((r) => r !== qqq)];
    return {
      on: true,
      session: S,
      halfDay: false,
      items: [...ITEMS].sort((a, b) => a.rank - b.rank),
      ticker: (s) => E.tickers.find((t) => t.symbol === s),
      premarket: {},
      closeDate: E.built_from ?? null,
      ageS: {},
      mode: { kind: "live" },
      now: input.now,
      rows: ordered,
      states: ordered.map((r) => r.state!),
      paused: false,
      barsDelayed: false,
      manage: { cards: null, rowExtra: () => null, notices: null, views: [], provisional: 0, journalLive: true } as unknown as Board["manage"],
      notices: [],
      dropNotice: () => undefined,
      log: [],
      spoken: "",
      doneFor: () => false,
      maskFor: () => null,
    };
  }
  const hero = (input: BoardInput) => renderToStaticMarkup(createElement(BoardContext.Provider, { value: heroBoard(input) }, createElement(NowHero))).replaceAll("&#x27;", "'");

  it("says the reason instead of old prices; off, or for no fresh price, the hero reads as before", () => {
    const on = hero(atStep(3, crossedQQQ, { guards: { on: ["quote-crossed"] } }));
    expect(on).toContain('data-hero-paused="true"');
    expect(on).toContain("Prices paused. Suspect data, the bid is above the ask: check your platform. No entry is shown on it.");
    expect(on).not.toContain("old prices");
    expect(on).not.toContain('data-hero-word="enter_zone"');
    // switched off: the enter zone stands, exactly as without the suspect quote
    expect(hero(atStep(3, crossedQQQ))).toBe(hero(atStep(3)));
    expect(hero(atStep(3))).toContain('data-hero-word="enter_zone"');
    const stale = hero(atStep(3, crossedQQQ, { guards: { on: ALL }, receivedAt: stepInstant(S, 3) - 60_000 }));
    expect(stale).toContain(": no entry is shown on old prices. Check your platform.");
    expect(stale).not.toContain("Suspect data");
  });
});
