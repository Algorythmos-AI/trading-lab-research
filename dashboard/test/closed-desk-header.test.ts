// The header on a closed desk's page (DEC-0036): the freshness pill says the desk is closed, and there are no sections.
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({ pathname: "/crypto" }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname }));

const { DeskFreshnessPill } = await import("@/components/client/freshness-pill");
const { NavTabs } = await import("@/components/client/nav-tabs");

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const stale = { asOf: "2026-10-01T00:00:00Z", windows: [{ session: "always", start: "2026-09-01T00:00:00Z", end: "2027-01-01T00:00:00Z" }], initial: { state: "stopped" as const, ageMin: 30_000 } };
const desks = { stocks: stale, crypto: stale, hft: stale };

describe("the header on the closed crypto desk", () => {
  it("shows 'Desk closed' in place of the age of a snapshot that will never update", () => {
    nav.pathname = "/crypto";
    const html = renderToString(createElement(DeskFreshnessPill, { desks }));
    expect(text(html)).toBe("Desk closed");
    expect(html).toContain('role="status"');
    expect(html).not.toMatch(/Stopped|Late|Updated|No data/);
  });

  it("renders no section tabs: one page, no empty landmark", () => {
    nav.pathname = "/crypto";
    expect(renderToString(createElement(NavTabs))).toBe("");
  });

  it("leaves the stocks and HFT desks as they were", () => {
    for (const path of ["/", "/hft"]) {
      nav.pathname = path;
      expect(text(renderToString(createElement(DeskFreshnessPill, { desks })))).toMatch(/^Stopped: /);
      const tabs = renderToString(createElement(NavTabs));
      expect(tabs).toContain('aria-label="Sections"');
      expect(tabs).toContain(`href="${path}"`);
    }
  });
});
