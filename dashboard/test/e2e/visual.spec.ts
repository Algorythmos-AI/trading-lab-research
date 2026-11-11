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
const shot = (page: Page, name: string) => expect(page).toHaveScreenshot(name, { fullPage: true, mask: [page.getByRole("banner")], stylePath: NO_STRIP });

/**
 * The feed health strip is pictured on its own (below), in a fixed state: in the desk's pictures it is taken out of
 * the page, so they show the desk exactly as before it and a feed's state never changes a picture of the desk.
 */
const NO_STRIP = path.join(__dirname, "no-strip.css");

for (const theme of ["dark", "light"] as const) {
  test.describe(`the options desk, ${theme}`, () => {
    test.beforeEach(async ({ context, baseURL, isMobile }) => {
      // A phone is pictured in the dark theme only: the light one differs in colour, which the desktop covers.
      test.skip(isMobile && theme === "light", "the phone is pictured once");
      await useTheme(context, theme);
      // No option feed either: the positions' greeks are fetched after the page is up and priced against the real
      // clock, so with them a picture depended on when it was taken (seen: the phone's live view, 33px taller).
      await context.addCookies([{ name: "fx", value: "frozen.quotes-off.chain-off", url: baseURL! }]);
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

// The Options page as it reads in the session (the scripted morning at step 3: QQQ in its entry zone, SPY's failed
// break live, AAPL with no trade): the status rail, the hero, the glance, the board and the cards with their ladders.
// The rail's countdown, the session bar's now tick and the feed line's ages follow the running clock, so they are masked.
for (const theme of ["dark", "light"] as const) {
  test(`the glance page in the session, ${theme}`, async ({ page, context, baseURL, isMobile }) => {
    test.skip(isMobile && theme === "light", "the phone is pictured once");
    await useTheme(context, theme);
    await context.addCookies([
      { name: "fx", value: "focus.quotes-script.chain-off", url: baseURL! },
      { name: "fxstep", value: "3", url: baseURL! },
    ]);
    await page.goto("/options");
    await expect(page.locator("section[data-trade-now]")).toHaveAttribute("data-trade-now", "live", { timeout: 20_000 });
    await expect(page.locator("[data-board-row]").first()).toHaveAttribute("data-board-state", "enter_zone");
    await expect(page.locator("[data-hero-word]")).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    // A desktop is pictured from the top to the first row of cards (the desk below has its own pictures): the whole
    // page is over the repository's 500 KB limit for a file. A phone's whole page fits under it.
    if (!isMobile) await page.setViewportSize({ width: 1280, height: 2000 });
    await expect(page).toHaveScreenshot(`glance-live-${theme}.png`, {
      fullPage: isMobile,
      // The feed line's two ages follow the running clock too: masked, the words around them pictured.
      mask: [page.getByRole("banner"), page.locator("[data-rail-countdown]"), page.locator("[data-session-bar]"), page.locator("[data-age-slot]")],
      stylePath: NO_STRIP,
    });
  });
}


// The feed health strip on its own, stood still with a mix of states: the edition late (for an earlier session), the
// pre-open refresh on time, the prices failed (no keys), the bars not due, the journal late and the server check late.
for (const theme of ["dark", "light"] as const) {
  test(`the feed health strip, ${theme}`, async ({ page, context, baseURL, isMobile }) => {
    test.skip(isMobile && theme === "light", "the phone is pictured once");
    await useTheme(context, theme);
    await context.addCookies([{ name: "fx", value: "frozen.quotes-off.chain-off.feeds-late", url: baseURL! }]);
    await draw(page, "/options?view=brief&s=SPY", '[aria-label="Options desk"]');
    await expect(page.locator('[data-feed-chip="shadow"]')).toHaveAttribute("data-feed-state", "late");
    await expect(page.locator("[data-feed-strip]")).toHaveScreenshot(`feed-strip-${theme}.png`);
  });
}
