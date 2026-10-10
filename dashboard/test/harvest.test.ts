// The crypto desk's data harvest (DEC-0027) as the pages read it, from the crypto snapshot's `harvest`.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Crypto } from "@/lib/crypto";
import { harvest, harvestBookLabel, harvestLine } from "@/lib/harvest";

const fixture = (): Crypto => JSON.parse(readFileSync(new URL("./fixtures/crypto.v1.json", import.meta.url), "utf8")) as Crypto;

describe("the data harvest", () => {
  it("names each book by its rule and bar length", () => {
    expect(harvestBookLabel("h-trend", 240)).toBe("Trend, 4-hour");
    expect(harvestBookLabel("h-dip-60m", 60)).toBe("Dip, 1-hour");
    expect(harvestBookLabel("h-explore", 60)).toBe("Random entries, 1-hour");
    expect(harvestBookLabel("h-other", null)).toBe("other");
  });

  it("reads the counts, the days and the books from the snapshot", () => {
    const h = harvest(fixture());
    expect(h.available).toBe(true);
    expect(h.switchOn).toBe(true);
    expect(h.coins).toBe(30);
    expect(h.days).toHaveLength(14);
    expect(h.days.at(-1)!.signals).toBe(h.signalsToday);
    expect(h.books.map((b) => b.label)).toContain("Random entries, 1-hour");
    expect(h.books.reduce((a, b) => a + b.signals7d, 0)).toBe(h.signals7d);
    expect(h.perDay7d).toBeCloseTo(h.days.slice(-7).reduce((a, d) => a + d.signals, 0) / 7);
    expect(harvestLine(h)).toMatch(/^\d+ signals and \d+ paper entries today across 30 coins; \d+ trades labelled so far\.$/);
  });

  it("says so when the harvest is absent or off", () => {
    const s = fixture();
    expect(harvest({ ...s, harvest: undefined }).available).toBe(false);
    expect(harvestLine(harvest({ ...s, harvest: undefined }))).toMatch(/not recorded/);
    expect(harvestLine(harvest({ ...s, harvest: { ...s.harvest!, switch: "off" } }))).toMatch(/switched off/);
  });
});
