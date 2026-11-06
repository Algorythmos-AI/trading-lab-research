// The review of the price ladder (draft #357): each finding has its test here, written before its fix.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { geometryFor, LadderMini, LevelLadder } from "@/components/level-ladder";
import { spread } from "@/lib/chart-geometry";
import { altTriggers, focusPlan } from "@/lib/focus-plan";
import { focusOptions } from "@/lib/fixture-variants";
import { FRAMES, ladderLiveState, NO_PRICE_CAPTION, OFF_CAPTION, type LadderFeed } from "@/lib/level-ladder";
import type { LiveQuote, Options, OptionsTicker } from "@/lib/options";
import { FEED_STALE_MS, TRADE_STALE_MS } from "@/lib/trade-state";
import optionsJson from "./fixtures/options.v1.json";

const edition = focusOptions(optionsJson as unknown as Options, true) as Options;
const items = edition.focus!.items;
const tickerOf = (s: string) => edition.tickers.find((t) => t.symbol === s) as OptionsTicker | undefined;
const spy = items.find((i) => i.symbol === "SPY")!;
const textOf = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/g, " ");
/** The drawing only: the desktop SVG's own text, not the hidden list. */
const drawn = (html: string) => textOf(/<svg[^>]*data-testid="ladder-svg-desktop"[\s\S]*?<\/svg>/.exec(html)?.[0] ?? "");

// ---- the price dot: every case on the board's own clock ---------------------------------------------------------
const SESSION = "2026-10-12"; // a Monday; New York is on EDT (UTC−4)
const ny = (hh: number, mm: number, ss = 0) => Date.UTC(2026, 9, 12, hh + 4, mm, ss);
const quote = (at: number, price = 778.9, day: string | null = SESSION): LiveQuote => ({
  price,
  at: new Date(at).toISOString(),
  open: 778.3,
  high: 779,
  low: 778.2,
  day,
  prev_close: 778.55,
  vwap: 778.6,
});
/** A feed that answered `feedAgeMs` ago (browser time) with the server's clock at `now` when it answered. */
const feedAt = (now: number, q: LiveQuote | undefined, feedAgeMs = 1000): { feed: LadderFeed; browserNow: number } => ({
  feed: { status: "ok", asOf: new Date(now - feedAgeMs).toISOString(), receivedAt: 1_000_000, quotes: q ? { SPY: q } : {} },
  browserNow: 1_000_000 + feedAgeMs,
});
const base = { symbol: "SPY", session: SESSION, halfDay: false, premarket: null, close: 778.55, closeDate: "2026-10-09", ceiling: 779.4, floor: 775.16, atr: 6.26, move: 5 };
const state = (f: { feed: LadderFeed; browserNow: number }, over: Partial<typeof base> = {}) => ladderLiveState({ ...base, ...over, ...f });

describe("the dot follows the board's staleness rule", () => {
  it("a trade 31 s old is still live (the board's TRADE_STALE_MS, not liveRead's 30 s)", () => {
    const now = ny(10, 14, 31);
    expect(state(feedAt(now, quote(ny(10, 14))))).toMatchObject({ dot: { kind: "live", label: "live 10:14" } });
  });

  it("the trade's age boundary", () => {
    const now = ny(10, 20);
    expect(state(feedAt(now, quote(now - TRADE_STALE_MS))).dot?.kind).toBe("live");
    const late = state(feedAt(now, quote(now - TRADE_STALE_MS - 1000)));
    expect(late.dot).toBeNull();
    expect(late.caption).toMatch(/^Prices paused 121 s/);
  });

  it("the feed's age boundary", () => {
    const now = ny(10, 20);
    expect(state(feedAt(now, quote(now - 1000), FEED_STALE_MS)).dot?.kind).toBe("live");
    expect(state(feedAt(now, quote(now - 1000), FEED_STALE_MS + 1)).dot).toBeNull();
  });

  it("no quote, or a quote from another day, in the session: paused, no dot", () => {
    const now = ny(10, 20);
    expect(state(feedAt(now, undefined)).dot).toBeNull();
    expect(state(feedAt(now, quote(now - 1000, 770, "2026-10-09"))).dot).toBeNull();
  });

  it("prices off or the feed failing: no dot", () => {
    expect(state({ feed: { status: "off" }, browserNow: ny(10, 20) })).toMatchObject({ dot: null, caption: OFF_CAPTION });
    expect(state({ feed: { status: "error" }, browserNow: ny(10, 20) }).dot).toBeNull();
  });
});

describe("outside the session the edition's close is never shown as today's", () => {
  it("after the close with today's quote: the last trade with its time, never 'close'", () => {
    const now = ny(16, 30);
    const v = state(feedAt(now, quote(ny(16, 0), 780.1)));
    expect(v.dot).toEqual({ kind: "last", price: 780.1, label: "last trade 16:00" });
  });

  it("after the close with no quote, or yesterday's: no dot and 'No price for today yet'", () => {
    const now = ny(16, 30);
    for (const q of [undefined, quote(ny(16, 0) - 3 * 86_400_000, 770, "2026-10-09")]) {
      const v = state(feedAt(now, q));
      expect(v.dot).toBeNull();
      expect(v.caption).toBe(NO_PRICE_CAPTION);
    }
  });

  it("before the open: the edition's close, labelled with its date", () => {
    const v = state(feedAt(ny(8, 0), undefined));
    expect(v.dot).toEqual({ kind: "close", price: 778.55, label: "close Fri 9 Oct 778.55" });
    expect(v.distances).toEqual([]);
    expect(state(feedAt(ny(8, 0), undefined), { premarket: 777.2 } as never).dot).toMatchObject({ kind: "pre", label: "pre 777.20" });
  });

  it("a half day closes at 13:00", () => {
    const now = ny(13, 30);
    const q = quote(ny(13, 0), 779.2);
    expect(state(feedAt(now, q), { halfDay: true } as never).dot).toEqual({ kind: "last", price: 779.2, label: "last trade 13:00" });
    expect(state(feedAt(now, quote(now - 1000)), { halfDay: false } as never).dot?.kind).toBe("live");
  });
});

describe("the ladder's own data", () => {
  it("a target the chart lines merged into a nearby level is drawn once, at the plan's price", () => {
    // The plan's T2 is 781.62; last week's high is 781.60, inside chartLevels' merge distance (0.02 ATR).
    const item = { ...spy, target_up: { price: 781.62, name: "PWH" } };
    const t = { ...tickerOf("SPY")!, levels: [{ name: "PWH", price: 781.6 }] };
    const g = geometryFor(item, t, null, FRAMES.desktop);
    const t2 = g.rows.filter((r) => r.side === "call" && /T2/.test(r.tag));
    expect(t2).toHaveLength(1);
    expect(t2[0]!.price).toBe(781.62);
    expect(g.rows.some((r) => r.price === 781.6)).toBe(false);
    const html = renderToStaticMarkup(createElement(LevelLadder, { item, ticker: t, session: SESSION, halfDay: false, closeDate: null, live: false }));
    expect(html).toContain("drawn on the 781.60 level");
  });

  it("the mini draws an off-scale ceiling or floor as an edge chevron", () => {
    const wide = { ...spy, atr: 0.5 }; // a 4.24 box is 8.5 ATRs: both triggers fall off an 8-ATR scale
    const html = renderToStaticMarkup(createElement(LadderMini, { item: wide, ticker: tickerOf("SPY"), session: SESSION, halfDay: false, closeDate: null, live: false }));
    expect(html).toContain('data-offscale="above"');
    expect(html).toContain('data-offscale="below"');
  });

  it("the mini carries a one-line price note for a screen reader", () => {
    const html = renderToStaticMarkup(createElement(LadderMini, { item: spy, ticker: tickerOf("SPY"), session: SESSION, halfDay: false, closeDate: null }));
    expect(html).toMatch(/<p class="sr-only" data-testid="ladder-mini-note">SPY: [^<]+<\/p>/);
  });
});

describe("every plan price is on the drawing itself", () => {
  for (const item of items)
    for (const side of ["call", "put"] as const)
      it(`${item.symbol}, ${side} side highlighted`, () => {
        const plan = focusPlan(item);
        const html = renderToStaticMarkup(createElement(LevelLadder, { item, ticker: tickerOf(item.symbol), session: SESSION, halfDay: false, closeDate: null, highlight: side, live: false }));
        const text = drawn(html);
        for (const p of [plan.call!, plan.put!]) for (const v of [p.level, p.target1, p.target2?.price]) if (typeof v === "number") expect(text).toContain(v.toFixed(2));
        const lit = plan[side]!;
        expect(text).toContain(lit.entry!.toFixed(2));
        expect(text).toContain(lit.stop!.toFixed(2));
        expect(text).toContain(side === "call" ? "▲" : "▼");
        expect(text).toContain("×");
        // Each alternative trigger has its marker on the drawing, at a level the drawing labels.
        for (const a of altTriggers(plan, item.atr)) expect(text).toContain(a.level.toFixed(2));
        expect((html.match(/data-alt="/g) ?? []).length / 2).toBe(4); // desktop and phone frames
      });
});

describe("spread", () => {
  it("keeps the order and moves no label further than the crowd needs", () => {
    const start = [40, 41, 41.5, 42, 120, 121, 200, 300];
    const ls = start.map((y, i) => ({ y, i }));
    const gap = 19;
    spread(ls, gap, 14, 306);
    const byStart = [...ls].sort((a, b) => a.i - b.i);
    for (let k = 1; k < byStart.length; k++) expect(byStart[k]!.y - byStart[k - 1]!.y).toBeGreaterThanOrEqual(gap - 1e-9);
    for (const l of byStart) expect(Math.abs(l.y - start[l.i]!)).toBeLessThanOrEqual(3 * gap);
    // A label with room keeps its own height.
    expect(byStart[7]!.y).toBe(300);
  });
});
