import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LevelMap, RoomBar, roomMarks, zoneMembers, zoneWord } from "@/components/options-charts";
import { FocusStrip } from "@/components/options-focus";
import { focusOptions } from "@/lib/fixture-variants";
import { cardMarks, chartLevels, focusPlan } from "@/lib/focus-plan";
import { type Options, roomView } from "@/lib/options";
import { boardRows, type BoardInput } from "@/lib/trade-now";
import optionsJson from "./fixtures/options.v1.json";

// One source of truth: for every focus name, the card's ceiling and floor, the board's trigger prices and the Brief
// map's card marks are the same prices, under the same words, in the same colour (ceiling red, floor green). The
// edition's daily zones on the map are neutral, so a zone is never read as a trigger.
const v1 = optionsJson as unknown as Options;
const p2 = (v: number) => v.toFixed(2);

/** The fixture's focus with a third name whose triggers are set as breakout_above / hold_above (not zones). */
function withTriggerItem(): Options {
  const e = focusOptions(v1);
  const t = e.tickers.find((x) => !e.focus!.items.some((i) => i.symbol === x.symbol) && x.last?.close && x.atr14)!;
  const c = t.last!.close!;
  e.focus!.items.push({ symbol: t.symbol, rank: 3, bias: "breakout", breakout_above: Math.round((c + t.atr14! * 0.5) * 100) / 100, hold_above: Math.round((c - t.atr14! * 0.5) * 100) / 100, atr: t.atr14!, close: c });
  return e;
}

/** The markup of the first element opened by `open` (a tag name and attribute), through its own closing tag. */
function element(html: string, tag: string, attr: string): string {
  const start = html.indexOf(`<${tag} ${attr}`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = html.indexOf(`</${tag}>`, start);
  return html.slice(start, end + tag.length + 3);
}

for (const [name, e] of [
  ["the fixture's focus", focusOptions(v1)],
  ["the scripted morning's focus", focusOptions(v1, true)],
  ["a focus with breakout_above / hold_above", withTriggerItem()],
] as const) {
  describe(`level agreement: ${name}`, () => {
    const items = e.focus!.items;
    const input: BoardInput = {
      session: e.session,
      halfDay: false,
      items,
      tickers: e.tickers,
      quotes: {},
      trails: {},
      serverBars: {},
      serverFetchedAt: {},
      now: Date.parse(`${e.session}T12:00:00Z`),
      receivedAt: null,
      dayLimitUsed: false,
      wonToday: null,
    };
    const rows = boardRows(input, false);
    const card = renderToStaticMarkup(createElement(FocusStrip, { e }));

    for (const item of items)
      it(`${item.symbol}: card, board and map agree on the ceiling and the floor`, () => {
        const t = e.tickers.find((x) => x.symbol === item.symbol)!;
        const plan = focusPlan(item);
        const lines = chartLevels(item, t.levels);
        const ceiling = lines.find((l) => l.kind === "ceiling")!;
        const floor = lines.find((l) => l.kind === "floor")!;
        // The card's own lines are the plan's trigger levels.
        expect(ceiling.price).toBe(plan.call!.level);
        expect(floor.price).toBe(plan.put!.level);
        expect(card).toContain(p2(ceiling.price));
        expect(card).toContain(p2(floor.price));

        // The board's trigger prices.
        const row = rows.find((r) => r.symbol === item.symbol)!;
        expect(row.triggers).toBe(`Calls above ${p2(ceiling.price)} · Puts below ${p2(floor.price)}`);

        // The map's card marks: the same prices, under the card's words.
        const marks = cardMarks(item);
        expect(marks).toEqual([
          { price: ceiling.price, kind: "ceiling", word: "Ceiling" },
          { price: floor.price, kind: "floor", word: "Floor" },
        ]);
        const map = renderToStaticMarkup(createElement(LevelMap, { t, cardMarks: marks }));
        const drawn = [...map.matchAll(/data-card-mark="(ceiling|floor)" data-price="([\d.]+)"/g)].map((m) => [m[1], m[2]]);
        expect(drawn).toEqual([
          ["ceiling", p2(ceiling.price)],
          ["floor", p2(floor.price)],
        ]);
        expect(map).toContain(`Ceiling ${p2(ceiling.price)}`);
        expect(map).toContain(`Floor ${p2(floor.price)}`);
        // One colour per role: red is the ceiling, green the floor, on the map and on the card.
        const onMap = (kind: string) => element(map, "g", `data-card-mark="${kind}"`);
        if (!/↑|↓/.test(onMap("ceiling"))) expect(onMap("ceiling")).toMatch(/<line [^>]*stroke="var\(--bad\)"/);
        if (!/↑|↓/.test(onMap("floor"))) expect(onMap("floor")).toMatch(/<line [^>]*stroke="var\(--good\)"/);
        expect(onMap("ceiling")).toMatch(/<text [^>]*style="fill:var\(--bad\)/);
        expect(onMap("floor")).toMatch(/<text [^>]*style="fill:var\(--good\)/);
        // On the card: the row with the ceiling's price says "Ceiling" and has the red ball; the floor's, green.
        const cardRow = (price: number) => card.split("<li ").find((li) => li.includes(`>${p2(price)}</span>`) && /Ceiling<|Floor</.test(li))!;
        expect(cardRow(ceiling.price)).toContain("Ceiling<");
        expect(cardRow(ceiling.price)).toMatch(/class="size-7 rounded-full bg-bad-fill"/);
        expect(cardRow(floor.price)).toContain("Floor<");
        expect(cardRow(floor.price)).toMatch(/class="size-7 rounded-full bg-good-fill"/);
        // The room bar (Live table, At a glance): the same two prices as red and green ticks, its zones neutral.
        const close = t.last!.close!;
        const room = renderToStaticMarkup(
          createElement(RoomBar, { view: roomView(t, close)!, label: t.symbol, marks: roomMarks(marks, close, t.atr14) }),
        );
        expect([...room.matchAll(/data-room-mark="(ceiling|floor)" data-price="([\d.]+)"/g)].map((m) => [m[1], m[2]])).toEqual([
          ["ceiling", p2(ceiling.price)],
          ["floor", p2(floor.price)],
        ]);
        const tick = (kind: string) => room.match(new RegExp(`<span data-room-mark="${kind}"[^>]*>`))![0];
        expect(tick("ceiling")).toMatch(/class="[^"]*\bbg-bad\b/);
        expect(tick("floor")).toMatch(/class="[^"]*\bbg-good\b/);
        expect(room).not.toMatch(/--good-fill|--bad-fill/);
        // The zones never take the triggers' colours.
        const zones = map.slice(map.indexOf('data-layer="zones"'), map.indexOf('data-layer="candles"'));
        expect(zones.length).toBeGreaterThan(0);
        expect(zones).not.toMatch(/--good|--bad/);
      });
  });
}

describe("the card's two marks are the plan's own triggers", () => {
  const item = { symbol: "SPY", rank: 1, bias: "breakout" as const, atr: 10, breakout_above: 700.05, hold_above: 700.0 };
  it("keeps both when the ceiling and floor sit within the chart's merge distance", () => {
    expect(chartLevels(item, []).filter((l) => l.kind === "ceiling" || l.kind === "floor")).toHaveLength(1); // merged on the card's list
    expect(cardMarks(item)).toEqual([
      { price: 700.05, kind: "ceiling", word: "Ceiling" },
      { price: 700.0, kind: "floor", word: "Floor" },
    ]);
    expect(roomMarks(cardMarks(item), 700, 10).map((m) => m.kind)).toEqual(["ceiling", "floor"]);
  });

  it("stacks the labels of two marks off the same edge of the map", () => {
    const e = focusOptions(v1);
    const t = e.tickers.find((x) => x.symbol === "SPY")!;
    for (const [hi, lo] of [
      [9_000, 8_999.99],
      [2, 1.99],
    ] as const) {
      const map = renderToStaticMarkup(
        createElement(LevelMap, { t, cardMarks: [{ price: hi, kind: "ceiling", word: "Ceiling" }, { price: lo, kind: "floor", word: "Floor" }] }),
      );
      const ys = ["ceiling", "floor"].map((k) => Number(element(map, "g", `data-card-mark="${k}"`).match(/<text [^>]*y="([\d.]+)"/)![1]));
      expect(Math.abs(ys[0]! - ys[1]!)).toBeGreaterThanOrEqual(10.5);
    }
  });
});

describe("the map's zone words", () => {
  it("names zones by side, and writes the supply and demand bases out", () => {
    expect(zoneWord("support")).toBe("Support zone");
    expect(zoneWord("resistance")).toBe("Resistance zone");
    expect(zoneMembers(["PDL", "DEMAND"])).toEqual(["PDL", "Demand zone"]);
    expect(zoneMembers(["SUPPLY"])).toEqual(["Supply zone"]);
    expect(zoneMembers(null)).toEqual([]);
  });
});
