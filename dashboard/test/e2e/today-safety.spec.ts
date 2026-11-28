import { expect, test } from "@playwright/test";
import { scan, useTheme } from "./axe";

// CI-only. The Today page leads with its safety switches: one tile per kill file and loss latch, each green or red
// with words and an icon, the sources' "as of" stamps under them, at every width without sideways scroll.
// Fixture mode serves test/fixtures/snapshot.v3.json: the root kill file on, Gap Hunter's file off and not latched
// (`gap-latched` latches its live document); the options clone's document has no latch unless `clone-latched` is set. `frozen` stands the clock still.

test("Today shows the safety switches, red where a file is on", async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: "fx", value: "frozen", url: baseURL! }]);
  await page.goto("/today");
  const panel = page.locator("#safety");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("Safety switches");
  const tiles = panel.getByRole("list", { name: "Safety switches" }).getByRole("listitem");
  await expect(tiles).toHaveCount(4);
  await expect(panel.locator('[data-switch="kill-root"]')).toHaveAttribute("data-on", "true");
  await expect(panel.locator('[data-switch="kill-root"]')).toContainText("On");
  await expect(panel.locator('[data-switch="kill-s"]')).toHaveAttribute("data-on", "false");
  await expect(panel.locator('[data-switch="kill-s"]')).toContainText("Off");
  await expect(panel.locator('[data-switch="latch-clone"]')).toHaveAttribute("data-on", "false");
  await expect(panel).toContainText("1 switch on");
  await expect(panel.getByRole("list", { name: "Where these states came from" }).locator("[data-source]")).toHaveCount(3);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("a clone loss latch turns its tile red", async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: "fx", value: "frozen.clone-latched", url: baseURL! }]);
  await page.goto("/today");
  const tile = page.locator('#safety [data-switch="latch-clone"]');
  await expect(tile).toHaveAttribute("data-on", "true");
  await expect(tile).toContainText("Latched");
  await expect(tile).toContainText("Day loss limit");
});

test("a Gap Hunter safety stop turns its tile red, read from its live document as on its own page", async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: "fx", value: "frozen.gap-latched", url: baseURL! }]);
  await page.goto("/today");
  const tile = page.locator('#safety [data-switch="latch-s"]');
  await expect(tile).toHaveAttribute("data-on", "true");
  await expect(tile).toContainText("Safety stops: X3");
  await expect(page.locator('#safety [data-source="gap"]')).toContainText("live document");
});

test("a clone that has sent nothing reads Not sent, never Clear", async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: "fx", value: "frozen.clone-off", url: baseURL! }]);
  await page.goto("/today");
  const tile = page.locator('#safety [data-switch="latch-clone"]');
  await expect(tile).toHaveAttribute("data-on", "unknown");
  await expect(tile).toContainText("Not sent");
  await expect(tile).not.toContainText("Clear");
});

for (const width of [375, 768] as const) {
  for (const theme of ["dark", "light"] as const) {
    test(`Today passes the accessibility scan at ${width} px in ${theme}`, async ({ browser, baseURL, isMobile }) => {
      test.skip(isMobile, "the widths are set here; run once, on the desktop project");
      const context = await browser.newContext({ baseURL, viewport: { width, height: 900 } });
      await useTheme(context, theme);
      // The red state too: its muted and warn text sit on a tinted tile.
      await context.addCookies([{ name: "fx", value: "frozen.clone-latched", url: baseURL! }]);
      const page = await context.newPage();
      await page.goto("/today");
      await expect(page.locator("#safety")).toBeVisible();
      expect(await scan(page)).toEqual([]);
      await context.close();
    });
  }
}
