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

  test(`the contract pane passes the accessibility scan on a phone in ${theme}`, async ({ page, context }) => {
    await useTheme(context, theme);
    await page.goto("/options?view=live&pane=name");
    await liveChips(page);
    const pane = page.getByRole("region", { name: "SPY contract", exact: true });
    await pane.getByRole("button", { name: "Price a call or put" }).click();
    await expect(pane).toHaveAttribute("data-contract", "ready");
    await pane.getByLabel("Paid, per share").fill("2");
    await expect(pane).not.toContainText("at the ask");
    expect(await scan(page)).toEqual([]);
  });

  test(`the Options desk in the edition's second format passes the accessibility scan on a phone in ${theme}`, async ({ page, context, baseURL }) => {
    await useTheme(context, theme);
    await context.addCookies([{ name: "fx", value: "v2", url: baseURL! }]);
    await page.goto("/options?view=live");
    await expect(page.locator("[data-desk-bar]")).toBeVisible();
    await liveChips(page);
    // The part of the day's line that only a phone folds away, open.
    await page.locator("[data-desk-day] summary").click();
    // The whole phrase: "next 6 days" alone is also in the earnings line.
    await expect(page.locator("[data-day-more]").getByText("Next 6 days: Fed decision", { exact: false })).toBeVisible();
    expect(await scan(page)).toEqual([]);
  });
}
