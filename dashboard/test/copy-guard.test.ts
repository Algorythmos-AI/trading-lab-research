import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The desk shows the study's practices in our own words only (AGENTS.md data classes): no handle, no setup name from
// the record's glossary, in the source text of the files that write the desk's copy.
const FILES = [
  "../src/lib/entry-checks.ts",
  "../src/lib/trade-state.ts",
  "../src/lib/trade-now.ts",
  "../src/lib/bars.ts",
  "../src/lib/bars-route.ts",
  "../src/lib/fixture-script.ts",
  "../src/components/client/trade-now.tsx",
  "../src/components/client/use-bars.ts",
  "../src/lib/focus-plan.ts",
  "../src/components/options-focus.tsx",
  "../src/components/client/contract-iv.tsx",
  "../src/lib/trade-manage.ts",
  "../src/components/client/trade-manage.tsx",
  "../src/lib/trade-rules.ts",
  "../src/components/client/options-desk.tsx",
  "../src/components/client/options-detail.tsx",
  "../src/components/client/map-frame.tsx",
  "../src/components/options-charts.tsx",
  "../src/components/client/options-glance.tsx",
  "../src/lib/level-ladder.ts",
  "../src/lib/chart-code.ts",
  "../src/lib/chart-geometry.ts",
  "../src/components/level-ladder.tsx",
  "../src/components/client/ladder-live.tsx",
  "../src/lib/focus-card.ts",
  "../src/components/client/status-rail.tsx",
  "../src/components/client/now-hero.tsx",
  "../src/components/client/focus-glance.tsx",
  "../src/components/client/cockpit.tsx",
  "../src/lib/session-timeline.ts",
  "../src/lib/wake-lock.ts",
  "../src/components/client/focus-card-live.tsx",
  "../src/lib/what-if.ts",
  "../src/components/client/use-chain.ts",
  "../src/components/client/use-now.ts",
  "../src/lib/chain.ts",
  "../src/lib/owner-positions.ts",
  "../src/lib/trades-view.ts",
  "../src/components/journal.tsx",
  "../src/components/client/journal-table.tsx",
  "../src/components/trades-page.tsx",
  "../src/components/trades-jump-bar.tsx",
  "../src/components/trade-rules.tsx",
  "../src/components/panel.tsx",
  "../src/lib/ticket.ts",
  "../src/components/client/ticket.tsx",
];

const BANNED = [
  "Desi",
  "Desiano",
  "Desi_Trade",
  "Insiders",
  "Ripper",
  "Reclaim Ripper",
  "Pop and Fade",
  "Pop & fade",
  "trap",
  "fade into supply",
  "B&R",
  "B/R",
  "break & retest",
  "Retest rejection",
  "bear-flag",
  "Gap fill",
  "gap close reversal",
  "Holy Grail",
  "4HR retest",
  "VWAP reclaim",
  "VWAP retest",
  "Pullback long",
  "20DMA pullback",
  "NTZ",
  "no-trade zone",
  "ride the cloud",
  "One & done",
  "LVLS",
  "TTL",
  "Trust The Levels",
];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/&]/g, "\\$&");
/** A whole-word, case-insensitive match: "Desi" must not trip on "design". */
const pattern = (word: string) => new RegExp(`(?<![A-Za-z0-9])${escape(word)}(?![A-Za-z0-9])`, "i");

describe("copy guard", () => {
  for (const f of FILES)
    it(`${f.replace("../", "")} names no handle and no recorded setup`, () => {
      const text = readFileSync(fileURLToPath(new URL(f, import.meta.url)), "utf8");
      const hits = BANNED.filter((w) => pattern(w).test(text));
      expect(hits).toEqual([]);
    });

  it("the matcher is whole-word and case-insensitive", () => {
    expect(pattern("Desi").test("a design")).toBe(false);
    expect(pattern("Desi").test("from desi.")).toBe(true);
    expect(pattern("trap").test("setups.trap")).toBe(true);
    expect(pattern("Gap fill").test("Gap not filled")).toBe(false);
  });
});
