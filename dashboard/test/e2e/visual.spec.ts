import { existsSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { useTheme } from "./axe";

// Pictures of the Options desk, compared with the committed ones (test/e2e/__screenshots__). CI only, like every
// browser test here. The page is drawn from fixture data with the clock stood still on the server (`frozen`) and
// in the browser, and with no live feed, so the same code gives the same picture.
//
// When a change is meant to alter a picture, CI fails here and uploads what it drew as the artifact
// `screenshots`: look at them, and commit the ones that are right (docs/runbooks/dashboard-screenshots.md).

/** The instant the `frozen` fixture flag stands the server at (FROZEN_NOW in src/lib/fixture-variants.ts). */
const FROZEN_NOW = "2026-10-12T15:01:00Z";
const BASELINES = path.join(__dirname, "__screenshots__");
// Nothing to compare with until the first pictures are committed; the CI step that makes them sets VISUAL_UPDATE.
test.skip(!existsSync(BASELINES) && !process.env.VISUAL_UPDATE, "no committed screenshots yet");

async function draw(page: Page, url: string, ready: string) {
  await page.clock.setFixedTime(new Date(FROZEN_NOW));
  await page.goto(url);
  await expect(page.locator(ready)).toHaveAttribute("data-ready", "true");
  await page.evaluate(() => document.fonts.ready);
}

/** The site's own header shows two running clocks and the feed's age: it is not the desk, and is left out. */
const shot = (page: Page, name: string) => expect(page).toHaveScreenshot(name, { fullPage: true, mask: [page.getByRole("banner")] });

for (const theme of ["dark", "light"] as const) {
  test.describe(`the options desk, ${theme}`, () => {
    test.beforeEach(async ({ context, baseURL, isMobile }) => {
      // A phone is pictured in the dark theme only: the light one differs in colour, which the desktop covers.
      test.skip(isMobile && theme === "light", "the phone is pictured once");
      await useTheme(context, theme);
      await context.addCookies([{ name: "fx", value: "frozen.quotes-off", url: baseURL! }]);
    });

    for (const view of ["brief", "live", "review"] as const) {
      test(`${view} view`, async ({ page }) => {
        await draw(page, `/options?view=${view}&s=SPY`, '[aria-label="Options desk"]');
        await shot(page, `desk-${view}-${theme}.png`);
      });
    }

    test("a name on its own page, on the hourly range", async ({ page }) => {
      await draw(page, "/options/SPY", "[data-name-page]");
      await shot(page, `name-daily-${theme}.png`);
      await page.getByRole("group", { name: "Map range" }).getByRole("button", { name: "Hourly" }).click();
      await expect(page.locator('[data-map-range="hourly"]')).toBeVisible();
      await shot(page, `name-hourly-${theme}.png`);
    });
  });
}
