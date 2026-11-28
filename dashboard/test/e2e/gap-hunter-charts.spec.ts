import { expect, test } from "@playwright/test";
import { scan, useTheme } from "./axe";

// CI-only. Gap Hunter's closed trades as pictures: the running R total with its drawdown, and each booked trade's R.
// They draw from two booked trades: the fixture's default document has one (no picture), `gap-flat` adds a second.

test("the R pictures appear once two trades are booked, with no symbol in them", async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: "fx", value: "frozen.gap-flat", url: baseURL! }]);
  await page.goto("/gap-hunter");
  const charts = page.getByTestId("gap-r-charts");
  await expect(charts).toBeVisible();
  await expect(charts.getByRole("img")).toHaveCount(2);
  await expect(charts).toContainText("1 up, 1 down");
  // SAFE figures only: the symbols stay in the table below, never in the pictures or their captions.
  await expect(charts).not.toContainText("AAAA");
  await expect(charts).not.toContainText("DDDD");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("one booked trade draws no picture", async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: "fx", value: "frozen", url: baseURL! }]);
  await page.goto("/gap-hunter");
  await expect(page.getByText("Closed trades").first()).toBeVisible();
  await expect(page.getByTestId("gap-r-charts")).toHaveCount(0);
});

for (const width of [375, 768] as const) {
  for (const theme of ["dark", "light"] as const) {
    test(`Gap Hunter with its R pictures passes the accessibility scan at ${width} px in ${theme}`, async ({ browser, baseURL, isMobile }) => {
      test.skip(isMobile, "the widths are set here; run once, on the desktop project");
      const context = await browser.newContext({ baseURL, viewport: { width, height: 900 } });
      await useTheme(context, theme);
      await context.addCookies([{ name: "fx", value: "frozen.gap-flat", url: baseURL! }]);
      const page = await context.newPage();
      await page.goto("/gap-hunter");
      await expect(page.getByTestId("gap-r-charts")).toBeVisible();
      expect(await scan(page)).toEqual([]);
      await context.close();
    });
  }
}
