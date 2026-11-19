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

  test(`the Trades page and its jump bar pass the accessibility scan on a phone in ${theme}`, async ({ page, context }) => {
    await useTheme(context, theme);
    await page.goto("/trades");
    expect(await page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(theme === "dark");
    const bar = page.getByRole("navigation", { name: "On this page" });
    await expect(bar).toBeVisible();
    // The bar scrolls sideways inside itself; the page does not.
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    expect(await scan(page)).toEqual([]);
  });

  for (const flag of ["frozen", "frozen.radar-refused"]) {
    test(`the Radar page's pipeline passes the accessibility scan on a phone in ${theme} under ${flag}`, async ({ page, context, baseURL }) => {
      await useTheme(context, theme);
      await context.addCookies([{ name: "fx", value: flag, url: baseURL! }]);
      await page.goto("/radar");
      expect(await page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(theme === "dark");
      await expect(page.getByRole("list", { name: /^The Radar pipeline for / }).getByRole("listitem")).toHaveCount(7);
      // Seven stages fit a phone's width: the page does not scroll sideways.
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      expect(await scan(page)).toEqual([]);
    });
  }

  test(`the Day review passes the accessibility scan on a phone in ${theme}`, async ({ page, context }) => {
    await useTheme(context, theme);
    await page.goto("/review");
    expect(await page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(theme === "dark");
    // The phone's cards, not the wide table.
    await expect(page.locator("[data-review-card]").first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    expect(await scan(page)).toEqual([]);
  });

  test(`the "Trade now" board, its alert menu and a notice pass the accessibility scan on a phone in ${theme}`, async ({ page, context, baseURL }) => {
    await useTheme(context, theme);
    await context.addCookies([
      { name: "fx", value: "focus.quotes-script", url: baseURL! },
      { name: "fxstep", value: "2", url: baseURL! },
    ]);
    await page.goto("/options");
    await expect(page.locator("[data-board-row]").first()).toHaveAttribute("data-board-state", "get_ready");
    await context.addCookies([{ name: "fxstep", value: "3", url: baseURL! }]);
    await expect(page.locator("[data-board-notice]")).toHaveCount(2, { timeout: 15_000 });
    await page.getByRole("button", { name: /^Alerts:/ }).click();
    expect(await scan(page)).toEqual([]);
  });

  test(`the "I'm in" form and the manage card pass the accessibility scan on a phone in ${theme}`, async ({ page, context, baseURL }) => {
    await useTheme(context, theme);
    await context.addCookies([
      { name: "fx", value: "focus.quotes-script", url: baseURL! },
      { name: "fxstep", value: "3", url: baseURL! },
    ]);
    await page.goto("/options");
    await page.getByRole("button", { name: "I'm in" }).first().click();
    const form = page.locator("[data-im-in-form]");
    await form.getByLabel(/price at your fill/).fill("900");
    await form.getByRole("button", { name: "Save note" }).click();
    await expect(form.getByRole("alert")).toBeVisible();
    expect(await scan(page)).toEqual([]);
    await form.getByLabel(/price at your fill/).fill("753.43");
    await form.getByRole("button", { name: "Save note" }).click();
    await expect(page.locator("[data-manage]")).toBeVisible();
    expect(await scan(page)).toEqual([]);
  });

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
