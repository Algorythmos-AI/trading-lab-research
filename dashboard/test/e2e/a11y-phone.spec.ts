import { expect, test } from "@playwright/test";
import { liveChips, scan, useTheme } from "./axe";

// CI-only. The Options desk at a phone's width, where it shows one pane at a time: each pane, in both themes, must
// pass the same scan as the desktop pages (a11y.spec.ts).
test.skip(({ isMobile }) => !isMobile, "these scans run on the phone project");

for (const theme of ["light", "dark"] as const) {
  for (const [pane, path] of [
    ["list of names", "/options?view=live"],
    ["open name", "/options?view=live&pane=name"],
  ] as const) {
    test(`the Options desk's ${pane} passes the accessibility scan on a phone in ${theme}`, async ({ page, context }) => {
      await useTheme(context, theme);
      await page.goto(path);
      expect(await page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(theme === "dark");
      // The bar that switches panes is the phone layout; without it this would be scanning the wide one.
      await expect(page.locator("[data-desk-bar]")).toBeVisible();
      await liveChips(page);
      expect(await scan(page)).toEqual([]);
    });
  }
}
