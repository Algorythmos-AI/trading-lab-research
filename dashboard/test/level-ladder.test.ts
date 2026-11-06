import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LadderMark, LadderNote, tagY } from "@/components/client/ladder-live";
import { geometryFor, LadderMini, LevelLadder } from "@/components/level-ladder";
import { spread as ledgerSpread } from "@/components/ledger";
import { LINE, LINE_SVG } from "@/lib/chart-code";
import { spread } from "@/lib/chart-geometry";
import { altTriggers, chartLevels, focusPlan } from "@/lib/focus-plan";
import { focusOptions } from "@/lib/fixture-variants";
import {
  CONNECTING_CAPTION,
  FRAMES,
  LADDER_MAX_ATR,
  LADDER_MIN_ATR,
  ladderDomain,
  ladderGeometry,
  type LadderLiveInput,
  ladderLiveView,
  OFF_CAPTION,
  PAUSED_CAPTION,
  placeLabels,
  type LadderRow,
} from "@/lib/level-ladder";
import type { Options, OptionsTicker } from "@/lib/options";
import optionsJson from "./fixtures/options.v1.json";

const edition = focusOptions(optionsJson as unknown as Options, true) as Options;
const items = edition.focus!.items;
const tickerOf = (s: string) => edition.tickers.find((t) => t.symbol === s) as OptionsTicker | undefined;
const spy = items.find((i) => i.symbol === "SPY")!;

/** The text a reader sees or a screen reader hears: the markup without its tags. */
const textOf = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/g, " ");

describe("ladder scale", () => {
  it("keeps a narrow day at least LADDER_MIN_ATR tall", () => {
    const d = ladderDomain([100, 100.2, 100.4], 2, { ceiling: 100.4, floor: 100 });
    expect(d.hi - d.lo).toBeCloseTo(LADDER_MIN_ATR * 2, 9);
    expect(d.lo).toBeLessThan(100);
    expect(d.hi).toBeGreaterThan(100.4);
  });

  it("clamps a wide one to LADDER_MAX_ATR, centred on the no-trade box", () => {
    const d = ladderDomain([60, 99, 101, 140], 1, { ceiling: 101, floor: 99 });
    expect(d.hi - d.lo).toBeCloseTo(LADDER_MAX_ATR, 9);
    expect((d.hi + d.lo) / 2).toBeCloseTo(100, 9);
  });

  it("draws higher prices higher up, and the ceiling above the floor", () => {
    for (const item of items) {
      const g = geometryFor(item, tickerOf(item.symbol), null, FRAMES.desktop);
      for (let p = g.domain.lo; p < g.domain.hi; p += (g.domain.hi - g.domain.lo) / 50) expect(g.y(p + 0.01)).toBeLessThan(g.y(p));
      const ceiling = g.rows.find((r) => r.role === "ceiling")!;
      const floor = g.rows.find((r) => r.role === "floor")!;
      expect(ceiling.price).toBeGreaterThan(floor.price);
      expect(ceiling.y).toBeLessThan(floor.y);
      expect(g.box).not.toBeNull();
      expect(g.box!.top).toBeCloseTo(ceiling.y, 9);
      expect(g.box!.bottom).toBeCloseTo(floor.y, 9);
      // Rows come highest price first.
      for (let k = 1; k < g.rows.length; k++) expect(g.rows[k]!.price).toBeLessThanOrEqual(g.rows[k - 1]!.price);
    }
  });

  it("turns a level off the scale into an edge chevron that keeps its price", () => {
    const far = { ...spy, target_up: { price: spy.resistance!.price + 20 * spy.atr!, name: "52WH" } };
    const g = geometryFor(far, tickerOf("SPY"), null, FRAMES.desktop);
    const t2 = g.rows.find((r) => r.price === far.target_up.price)!;
    expect(t2.offscale).toBe("above");
    expect(t2.y).toBe(g.frame.top);
    expect(g.domain.hi - g.domain.lo).toBeCloseTo(LADDER_MAX_ATR * spy.atr!, 6);
    const html = renderToStaticMarkup(createElement(LevelLadder, { item: far, ticker: tickerOf("SPY"), session: edition.session, halfDay: false, closeDate: edition.built_from ?? null, live: false, size: "desktop" }));
    expect(textOf(html)).toContain(far.target_up.price.toFixed(2));
    expect(html).toContain("off the scale above");
  });
});

describe("labels", () => {
  it("spread keeps the gap with 8 labels on the same cent, inside the frame", () => {
    const ls = Array.from({ length: 8 }, () => ({ y: 150 }));
    spread(ls, 19, 14, 306);
    const ys = ls.map((l) => l.y).sort((a, b) => a - b);
    for (let k = 1; k < ys.length; k++) expect(ys[k]! - ys[k - 1]!).toBeGreaterThanOrEqual(19 - 1e-9);
    expect(ys[0]).toBeGreaterThanOrEqual(14);
    expect(ys.at(-1)).toBeLessThanOrEqual(306);
  });

  it("is the one the review charts use (moved, re-exported)", () => {
    expect(ledgerSpread).toBe(spread);
  });

  it("places the ceiling and floor at their own lines first, and nothing overlaps", () => {
    for (const f of [FRAMES.desktop, FRAMES.phone])
      for (const item of items) {
        const g = geometryFor(item, tickerOf(item.symbol), null, f);
        const ys = g.rows.filter((r) => r.visible).map((r) => r.labelY).sort((a, b) => a - b);
        for (let k = 1; k < ys.length; k++) expect(ys[k]! - ys[k - 1]!).toBeGreaterThanOrEqual(f.gap - 1e-6);
        // On the desktop frame there is room: the ceiling's and floor's labels sit exactly at their lines. A phone's
        // shorter frame may have to spread them too (a thin box with both stops in it), never overlapping.
        if (f.size === "desktop") for (const r of g.rows.filter((x) => x.role === "ceiling" || x.role === "floor")) expect(r.labelY).toBeCloseTo(r.y, 6);
        for (const r of g.rows) {
          expect(r.labelY).toBeGreaterThanOrEqual(g.frame.top - 1e-6);
          expect(r.labelY).toBeLessThanOrEqual(g.frame.bottom + 1e-6);
        }
      }
  });

  it("falls back to one spread when a stretch is too small", () => {
    const row = (price: number, y: number, role: LadderRow["role"] = "target"): LadderRow => ({ key: `${price}`, price, role, side: null, tag: "", name: "", style: "", beyondMove: false, visible: true, y, labelY: y, offscale: null });
    const rows = [row(10, 20, "ceiling"), ...Array.from({ length: 6 }, (_, k) => row(11 + k * 0.001, 15)), row(5, 200, "floor")];
    placeLabels(rows, 19, 14, 306);
    const ys = rows.map((r) => r.labelY).sort((a, b) => a - b);
    for (let k = 1; k < ys.length; k++) expect(ys[k]! - ys[k - 1]!).toBeGreaterThanOrEqual(19 - 1e-6);
  });

  it("marks a second target beyond the 1-day move", () => {
    const t = tickerOf("SPY")!;
    const move = 1; // SPY's T2 (781.62) is 3.07 from its close (778.55): past a 1.00 move, inside a 20.00 one.
    const far = geometryFor(spy, { ...t, expected_move: { day: move } }, null, FRAMES.desktop);
    expect(far.rows.find((r) => r.price === 781.62)?.beyondMove).toBe(true);
    expect(far.notes.some((n) => n.kind === "beyond" && n.text === "beyond 1-day move")).toBe(true);
    const near = geometryFor(spy, { ...t, expected_move: { day: 20 } }, null, FRAMES.desktop);
    expect(near.notes.some((n) => n.kind === "beyond")).toBe(false);
  });
});

describe("every plan price is on the ladder", () => {
  for (const item of items)
    it(`${item.symbol}: entry, stop, T1, T2 and the four alternative triggers`, () => {
      const plan = focusPlan(item);
      const alts = altTriggers(plan, item.atr);
      expect(alts).toHaveLength(4);
      const html = renderToStaticMarkup(createElement(LevelLadder, { item, ticker: tickerOf(item.symbol), session: edition.session, halfDay: false, closeDate: edition.built_from ?? null }));
      const text = textOf(html);
      for (const p of [plan.call, plan.put]) {
        expect(p).not.toBeNull();
        for (const v of [p!.level, p!.entry, p!.stop, p!.target1, p!.target2?.price]) if (typeof v === "number") expect(text).toContain(v.toFixed(2));
      }
      for (const a of alts) expect(text).toContain(a.level.toFixed(2));
      // The markers carry their glyph and side, muted; the hidden list names each one.
      for (const m of ["↩ put", "↩ call", "⤒ put", "⤓ call"]) expect(text).toContain(m);
      expect(text).toContain("failed break, a put (testing)");
      expect(text).toContain("sweep, a call (testing)");
      expect(text).toContain("no trade inside");
      // Accessible: an image labelled by a title and an ordered list of every level.
      expect(html).toContain('role="img"');
      expect(html).toContain(`aria-labelledby="ladder-title-${item.symbol} ladder-list-${item.symbol}"`);
      expect(html).toContain(`<ol id="ladder-list-${item.symbol}" class="sr-only">`);
    });

  it("the chart lines it draws are the card's chart lines", () => {
    const g = ladderGeometry({ lines: chartLevels(spy, tickerOf("SPY")?.levels), plans: focusPlan(spy), alts: [], atr: spy.atr, height: 320 });
    for (const l of chartLevels(spy, tickerOf("SPY")?.levels)) expect(g.rows.some((r) => r.price === l.price)).toBe(true);
  });
});

describe("the price dot", () => {
  const at = "2026-10-12T14:14:00.000Z"; // 10:14 New York
  const base: LadderLiveInput = {
    mode: "live",
    phase: "in",
    today: { price: 779.0, at },
    fresh: true,
    ageS: 2,
    premarket: null,
    close: 778.55,
    closeDate: "2026-10-09",
    ceiling: 779.4,
    floor: 775.16,
    atr: 6.26,
    move: 5,
  };

  it("is filled and labelled live only while the board would use the price, with the distances", () => {
    const v = ladderLiveView(base);
    expect(v.dot).toEqual({ kind: "live", price: 779, label: "live 10:14" });
    expect(v.from).toBe("live");
    expect(v.distances.map((d) => d.text)).toEqual(["0.40 away · 0.1× move", "3.84 away · 0.8× move"]);
    expect(ladderLiveView({ ...base, mode: "opening" }).dot?.kind).toBe("live");
  });

  it("past a trigger, reads in ATRs past it", () => {
    const v = ladderLiveView({ ...base, today: { price: 781.9, at } });
    expect(v.distances[0]!.text).toBe("+0.4 ATR past");
  });

  it("shows nothing when prices are off, old or paused", () => {
    for (const mode of ["off", "old"] as const) expect(ladderLiveView({ ...base, mode })).toEqual({ dot: null, caption: OFF_CAPTION, distances: [], from: null });
    expect(ladderLiveView({ ...base, fresh: false, ageS: 34 })).toEqual({ dot: null, caption: "Prices paused 34 s: static plan", distances: [], from: null });
    expect(ladderLiveView({ ...base, today: null, ageS: null })).toEqual({ dot: null, caption: PAUSED_CAPTION, distances: [], from: null });
    expect(ladderLiveView({ ...base, mode: "loading" })).toEqual({ dot: null, caption: CONNECTING_CAPTION, distances: [], from: null });
  });

  it("before the open: a pre-market diamond with distances from pre, else the dated close with none", () => {
    const next = { ...base, mode: "next" as const, phase: "before" as const, today: null };
    const pre = ladderLiveView({ ...next, premarket: 776.2 });
    expect(pre.dot).toEqual({ kind: "pre", price: 776.2, label: "pre 776.20" });
    expect(pre.from).toBe("pre");
    expect(pre.distances).toHaveLength(2);
    const close = ladderLiveView(next);
    expect(close.dot).toEqual({ kind: "close", price: 778.55, label: "close Fri 9 Oct 778.55" });
    expect(close.distances).toEqual([]);
    const after = ladderLiveView({ ...next, phase: "after", today: { price: 780.1, at: "2026-10-12T20:00:00.000Z" }, premarket: 776.2 });
    expect(after.dot).toEqual({ kind: "last", price: 780.1, label: "last trade 16:00" });
    expect(after.distances).toEqual([]);
  });

  it("renders each mode: filled, diamond, hollow last trade, or nothing", () => {
    const domain = { lo: 770, hi: 785 };
    const f = FRAMES.desktop;
    const mark = (input: LadderLiveInput) => renderToStaticMarkup(createElement(LadderMark, { view: ladderLiveView(input), frame: f, domain }));
    const note = (input: LadderLiveInput) => renderToStaticMarkup(createElement(LadderNote, { view: ladderLiveView(input) }));
    const live = mark(base);
    expect(live).toContain('data-dot="live"');
    expect(live).toContain('fill="var(--warn)"');
    expect(live).toMatch(/r="7"/);
    expect(live).toContain("live 10:14");
    expect(note(base)).toContain("Ceiling 779.40 · 0.40 away · 0.1× move");
    // The nearer trigger first and bold, the far one muted.
    expect(note(base)).toMatch(/data-near="yes" class="[^"]*font-bold[^"]*">Ceiling/);
    expect(note(base)).toMatch(/text-muted-foreground font-medium">Floor 775.16 · 3.84 away/);
    const next = { ...base, mode: "next" as const, phase: "before" as const, today: null };
    const pre = mark({ ...next, premarket: 776.2 });
    expect(pre).toContain('data-dot="pre"');
    expect(pre).toContain("<rect");
    expect(pre).toContain("pre 776.20");
    expect(note({ ...next, premarket: 776.2 })).toContain("from pre");
    expect(mark(next)).toContain("close Fri 9 Oct 778.55");
    const last = mark({ ...next, phase: "after", today: { price: 780.1, at: "2026-10-12T20:00:00.000Z" } });
    expect(last).toContain('data-dot="last"');
    expect(last).toContain('stroke-dasharray="3 2"');
    for (const mode of ["off", "old"] as const) {
      expect(mark({ ...base, mode })).toBe("");
      expect(note({ ...base, mode })).toContain(OFF_CAPTION);
    }
    expect(mark({ ...base, fresh: false })).toBe("");
    expect(note({ ...base, fresh: false, ageS: 34 })).toContain("Prices paused 34 s");
    // Off the scale the dot sits at the edge and says which way.
    expect(mark({ ...base, today: { price: 790, at } })).toContain("live 10:14 ↑");
  });

  it("the whole ladder with no live feed draws no dot", () => {
    const html = renderToStaticMarkup(createElement(LevelLadder, { item: spy, ticker: tickerOf("SPY"), session: edition.session, halfDay: false, closeDate: edition.built_from ?? null }));
    expect(html).not.toContain("data-dot");
    expect(html).toContain(CONNECTING_CAPTION);
    expect(html).toContain('data-highlight="none"');
    const lit = renderToStaticMarkup(createElement(LevelLadder, { item: spy, ticker: tickerOf("SPY"), session: edition.session, halfDay: false, closeDate: edition.built_from ?? null, highlight: "put" }));
    expect(lit).toContain('data-highlight="put"');
    expect(lit).toContain("group-data-[highlight=put]/ladder:opacity-40");
  });
});

describe("the mini ladder", () => {
  it("labels only the ceiling and floor prices", () => {
    const html = renderToStaticMarkup(createElement(LadderMini, { item: spy, ticker: tickerOf("SPY"), session: edition.session, halfDay: false, closeDate: edition.built_from ?? null }));
    const text = textOf(html);
    expect(text).toContain("779.40");
    expect(text).toContain("775.16");
    expect(text).not.toContain("T1");
    expect(text).not.toContain("sweep");
    expect(html).toContain('aria-label="SPY small price ladder, ceiling 779.40, floor 775.16"');
    expect(html).not.toContain("ladder-note");
  });
});

describe("size and colour code", () => {
  it("labels at 16 px on a desktop and 15 on a phone; nothing below 14", () => {
    expect(FRAMES.desktop.font).toBe(16);
    expect(FRAMES.phone.font).toBe(15);
    expect(FRAMES.desktop.height).toBe(320);
    expect(FRAMES.phone.height).toBe(240);
    expect(FRAMES.mini.height).toBe(120);
    for (const f of Object.values(FRAMES)) expect(Math.min(f.font, f.small)).toBeGreaterThanOrEqual(14);
    const html = renderToStaticMarkup(createElement(LevelLadder, { item: spy, ticker: tickerOf("SPY"), session: edition.session, halfDay: false, closeDate: edition.built_from ?? null }));
    const sizes = [...html.matchAll(/font-size="([\d.]+)"/g)].map((m) => Number(m[1]));
    expect(sizes.length).toBeGreaterThan(0);
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(14);
  });

  it("the ladder's strokes are the card's colour code, and the focus card reads LINE from here", () => {
    for (const k of ["ceiling", "floor", "week"] as const) expect(LINE[k].ball.replace("bg-", "--")).toBe(LINE_SVG[k].stroke.replace(/^var\((.*)\)$/, "$1"));
    expect(LINE.month.ball).toBe("bg-chart-7");
    expect(LINE_SVG.month.stroke).toBe("var(--chart-7)");
    expect(LINE_SVG.ceiling.width).toBe(3);
    expect(LINE_SVG.floor.width).toBe(3);
    // One source: the focus card draws its balls and swatches from chart-code's LINE, and keeps no copy of its own.
    const card = readFileSync(fileURLToPath(new URL("../src/components/options-focus.tsx", import.meta.url)), "utf8");
    expect(card).toMatch(/import \{[^}]*\bLINE\b[^}]*\} from "@\/lib\/chart-code"/);
    expect(card).not.toMatch(/const LINE\b/);
  });
});

describe("eyeball pass", () => {
  const visible = (g: ReturnType<typeof geometryFor>) => g.rows.filter((r) => r.visible);

  it("labels entry and stop only for the highlighted side, and neither with no highlight", () => {
    const none = geometryFor(spy, tickerOf("SPY"), null, FRAMES.desktop);
    expect(visible(none).some((r) => r.role === "entry" || r.role === "stop")).toBe(false);
    const call = geometryFor(spy, tickerOf("SPY"), null, FRAMES.desktop, "call");
    expect(visible(call).filter((r) => r.role === "entry" || r.role === "stop").map((r) => r.key).sort()).toEqual(["call-entry", "call-stop"]);
    // Hidden ones stay in the hidden list.
    const html = renderToStaticMarkup(createElement(LevelLadder, { item: spy, ticker: tickerOf("SPY"), session: edition.session, halfDay: false, closeDate: edition.built_from ?? null, live: false }));
    expect(html).toContain("call entry, entry");
    expect(html).toContain("not labelled on the drawing");
    expect(html).toContain("No side is highlighted.");
    const lit = renderToStaticMarkup(createElement(LevelLadder, { item: spy, ticker: tickerOf("SPY"), session: edition.session, halfDay: false, closeDate: edition.built_from ?? null, live: false, highlight: "put" }));
    expect(lit).toContain("The put side is highlighted; the call side is dimmed.");
  });

  it("keeps the labels few and at their own height, with short straight leaders", () => {
    for (const item of items) {
      const g = geometryFor(item, tickerOf(item.symbol), null, FRAMES.desktop);
      expect(visible(g).length).toBeLessThanOrEqual(7);
      // Most labels sit at their own height; one moves only where two truly collide, and then by under a label's room.
      const own = visible(g).filter((r) => Math.abs(r.labelY - r.y) < 1e-6).length;
      expect(own / visible(g).length).toBeGreaterThanOrEqual(0.6);
      for (const r of visible(g)) expect(Math.abs(r.labelY - r.y)).toBeLessThan(FRAMES.desktop.gap);
      const lit = geometryFor(item, tickerOf(item.symbol), null, FRAMES.desktop, "call");
      expect(visible(lit).length).toBeLessThanOrEqual(8);
    }
    for (const f of [FRAMES.desktop, FRAMES.phone]) expect(f.tagX - 3 - f.lineTo).toBeLessThanOrEqual(12);
    const html = renderToStaticMarkup(createElement(LevelLadder, { item: spy, ticker: tickerOf("SPY"), session: edition.session, halfDay: false, closeDate: edition.built_from ?? null, live: false, size: "desktop" }));
    expect(html).not.toMatch(/<path d="M\d/); // leaders are single straight lines now
  });

  it("gives the drawing at least 55% of the desktop width", () => {
    const f = FRAMES.desktop;
    expect((f.lineTo - f.lineFrom) / f.width).toBeGreaterThanOrEqual(0.55);
  });

  it("labels a week or month level only near the price or as a target", () => {
    const g = ladderGeometry({
      lines: [
        { price: 110, kind: "ceiling", codes: ["PDH"], targets: [] },
        { price: 100, kind: "floor", codes: ["PDL"], targets: [] },
        { price: 111, kind: "week", codes: ["PWH"], targets: [] },
        { price: 104.2, kind: "month", codes: ["PMH"], targets: [] },
        { price: 98, kind: "week", codes: ["PWL"], targets: ["put target 2"] },
      ],
      plans: { call: null, put: null },
      alts: [],
      atr: 2,
      price: 104.5,
      height: 320,
    });
    const v = (p: number) => g.rows.find((r) => r.price === p)!.visible;
    expect(v(111)).toBe(false);
    expect(v(104.2)).toBe(true);
    expect(v(98)).toBe(true);
  });

  it("draws the live alternative trigger in the warn tone with its word, the rest muted", () => {
    const html = renderToStaticMarkup(createElement(LevelLadder, { item: spy, ticker: tickerOf("SPY"), session: edition.session, halfDay: false, closeDate: edition.built_from ?? null, live: false, size: "desktop", liveAlt: { kind: "sweep_reclaim", side: "put" } }));
    expect(html).toMatch(/data-alt="sweep_reclaim" data-alt-side="put" data-alt-live="yes"/);
    expect(html).toContain("⤒ sweep → put");
    expect(html).toContain("live now on the board");
    expect((html.match(/data-alt-live/g) ?? []).length).toBe(1);
  });

  it("steps the dot's tag around the gutter's markers", () => {
    expect(tagY(100, [], 18, 14, 306)).toBe(100);
    const y = tagY(100, [100, 91], 18, 14, 306);
    expect(Math.min(...[100, 91].map((b) => Math.abs(b - y)))).toBeGreaterThanOrEqual(18);
  });
});
