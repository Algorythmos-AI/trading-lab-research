import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import fixtureDoc from "./fixtures/journal.v1.json";
import { PatternsPanel } from "@/components/overview/home";
import { jumpLinks, TRADES_GROUPS, TRADES_QUICK } from "@/components/trades-jump-bar";
import { TradesBody } from "@/components/trades-page";
import { parseFilter, type JournalDoc } from "@/lib/journal";

// The clone's pane boundary asks for the router; no app router is mounted under a static render.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  usePathname: () => "/trades",
  useSearchParams: () => new URLSearchParams(),
}));

const doc = fixtureDoc as unknown as JournalDoc;
const now = new Date("2026-10-16T20:00:00Z");
const ids = (html: string) => new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]!));
const hrefs = (html: string) => {
  const bar = html.match(/<nav aria-label="On this page"[\s\S]*?<\/nav>/)?.[0] ?? "";
  return [...bar.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]!);
};
const render = (q: Record<string, string>, ok = true) =>
  renderToStaticMarkup(
    createElement(TradesBody, {
      result: ok ? { status: "ok", doc, source: "fixture" } : { status: "missing" },
      clone: { status: "missing" },
      q,
      now,
    }),
  );

describe("the Trades page's jump bar", () => {
  it("links only to ids the page draws, with the journal, a view with no trades, and no journal", () => {
    for (const html of [render({}), render({ s: "ZZZZ" }), render({}, false)]) {
      const links = hrefs(html);
      expect(links.length).toBeGreaterThan(0);
      const drawn = ids(html);
      expect(links.filter((h) => !drawn.has(h))).toEqual([]);
    }
  });

  it("lists every group and panel link when the journal has trades and money in view", () => {
    const html = render({});
    expect(hrefs(html)).toEqual([...Object.values(TRADES_GROUPS), ...Object.values(TRADES_QUICK)].map((x) => x.id));
    // The anchors other pages link to still land.
    for (const id of ["today", "lessons", "trades", "clone", "rules"]) expect(ids(html).has(id)).toBe(true);
  });

  it("drops the links to panels a view does not draw", () => {
    expect(hrefs(render({ s: "ZZZZ" }))).not.toContain(TRADES_QUICK.trades.id);
    expect(jumpLinks({ journal: false }).map((l) => l.href)).toEqual([`#${TRADES_GROUPS.clone.id}`]);
    expect(jumpLinks({ journal: true }).map((l) => l.href)).not.toContain(`#${TRADES_GROUPS.history.id}`);
  });
});

describe("the home page's ticker links", () => {
  it("open the Trades page filtered to that ticker", () => {
    const html = renderToStaticMarkup(createElement(PatternsPanel, { trades: doc.trades, now }));
    const links = [...html.matchAll(/href="\/trades\?([^"#]*)"/g)].map((m) => m[1]!.replace(/&amp;/g, "&"));
    expect(links.length).toBeGreaterThan(0);
    for (const query of links) expect(parseFilter(Object.fromEntries(new URLSearchParams(query))).symbol).not.toBeNull();
  });
});
