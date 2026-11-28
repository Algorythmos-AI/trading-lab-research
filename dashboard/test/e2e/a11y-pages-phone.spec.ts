import { expect, test } from "@playwright/test";
import { scan, useTheme } from "./axe";

// CI-only. Stocks pages at a phone's width, where wide tables and diagrams pan inside their box: each such box must be
// a named region the keyboard can reach (axe scrollable-region-focusable), and a meter with no value must not claim
// the meter role (aria-required-attr). a11y.spec.ts scans these pages at desktop width only.
const PAGES = [
  { path: "/operations", fx: "frozen" },
  { path: "/strategies", fx: "frozen" },
  { path: "/engineering", fx: "frozen" },
  { path: "/research/arms", fx: "frozen" },
  { path: "/research/arms", fx: "empty" },
  { path: "/operations", fx: "empty" },
];

test.skip(({ isMobile }) => !isMobile, "these scans run on the phone project");

for (const theme of ["dark", "light"] as const) {
  for (const { path, fx } of PAGES) {
    test(`${path} (${fx}) passes the accessibility scan on a phone in ${theme}`, async ({ page, context, baseURL }) => {
      await useTheme(context, theme);
      await context.addCookies([{ name: "fx", value: fx, url: baseURL! }]);
      await page.goto(path);
      expect(await scan(page)).toEqual([]);
    });
  }
}
