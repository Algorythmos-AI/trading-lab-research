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

for (const [name, e] of [
  ["the fixture's focus", focusOptions(v1)],
  ["the scripted morning's focus", focusOptions(v1, true)],
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
        const marks = cardMarks(item, t.levels);
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
        expect(map).toMatch(new RegExp(`data-card-mark="ceiling"[^]*?stroke="var\\(--bad\\)"`));
        expect(map).toMatch(new RegExp(`data-card-mark="floor"[^]*?stroke="var\\(--good\\)"`));
        expect(card).toMatch(/border-bad-fill[^]*?Ceiling|Ceiling[^]*?border-bad-fill/);
        // The room bar (Live table, At a glance): the same two prices as red and green ticks, its zones neutral.
        const close = t.last!.close!;
        const room = renderToStaticMarkup(
          createElement(RoomBar, { view: roomView(t, close)!, label: t.symbol, marks: roomMarks(marks, close, t.atr14) }),
        );
        expect([...room.matchAll(/data-room-mark="(ceiling|floor)" data-price="([\d.]+)"/g)].map((m) => [m[1], m[2]])).toEqual([
          ["ceiling", p2(ceiling.price)],
          ["floor", p2(floor.price)],
        ]);
        expect(room).toMatch(/data-room-mark="ceiling"[^>]*class="[^"]*bg-bad[ "]/);
        expect(room).toMatch(/data-room-mark="floor"[^>]*class="[^"]*bg-good[ "]/);
        expect(room).not.toMatch(/--good-fill|--bad-fill/);
        // The zones never take the triggers' colours.
        const zones = map.slice(map.indexOf('data-layer="zones"'), map.indexOf('data-layer="candles"'));
        expect(zones.length).toBeGreaterThan(0);
        expect(zones).not.toMatch(/--good|--bad/);
      });
  });
}

describe("the map's zone words", () => {
  it("names zones by side, and writes the supply and demand bases out", () => {
    expect(zoneWord("support")).toBe("Support zone");
    expect(zoneWord("resistance")).toBe("Resistance zone");
    expect(zoneMembers(["PDL", "DEMAND"])).toEqual(["PDL", "Demand zone"]);
    expect(zoneMembers(["SUPPLY"])).toEqual(["Supply zone"]);
    expect(zoneMembers(null)).toEqual([]);
  });
});
