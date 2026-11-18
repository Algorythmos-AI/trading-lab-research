import { expect, test, type BrowserContext, type Page } from "@playwright/test";

// CI-only. The cockpit's keyboard shortcut, its screen-awake dot and its separate Full screen button, on the scripted
// morning's live step (fixture-script.ts).

async function at(context: BrowserContext, baseURL: string | undefined, step = 3) {
  await context.addCookies([
    { name: "fx", value: "focus.quotes-script", url: baseURL! },
    { name: "fxstep", value: String(step), url: baseURL! },
  ]);
}
const toggle = (page: Page) => page.locator("[data-cockpit-switch]");
const ladders = (page: Page) => page.locator("[data-cockpit-ladders]");

/** A stand-in for the browser's Wake Lock: grants, or refuses, each request. */
async function wakeLock(page: Page, grant: boolean) {
  await page.addInitScript((g) => {
    Object.defineProperty(navigator, "wakeLock", {
      configurable: true,
      value: { request: () => (g ? Promise.resolve({ release: () => Promise.resolve(), addEventListener: () => undefined }) : Promise.reject(new Error("refused"))) },
    });
  }, grant);
}

test("C turns the cockpit on and off", async ({ page, context, baseURL, isMobile }) => {
  test.skip(isMobile, "a keyboard shortcut");
  await at(context, baseURL);
  await page.goto("/options");
  await expect(page.locator("[data-trade-now] [data-board-row]").first()).toHaveAttribute("data-board-state", "enter_zone");
  await expect(toggle(page)).toHaveAttribute("aria-keyshortcuts", "C");
  await page.keyboard.press("c");
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");
  await expect(ladders(page)).toBeVisible();
  await page.keyboard.press("Shift+C");
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
  await expect(ladders(page)).toHaveCount(0);
});

test("C is never the cockpit's while typing, with a modifier, or with a rail menu open", async ({ page, context, baseURL, isMobile }) => {
  test.skip(isMobile, "a keyboard shortcut");
  await at(context, baseURL);
  await page.goto("/options");
  await expect(page.locator("[data-trade-now] [data-board-row]").first()).toHaveAttribute("data-board-state", "enter_zone");
  // typing in a field
  await page.evaluate(() => {
    const i = document.createElement("input");
    i.id = "probe";
    document.body.append(i);
  });
  await page.locator("#probe").type("cc");
  await expect(page.locator("#probe")).toHaveValue("cc");
  await page.locator("#probe").blur();
  // a modifier: Ctrl+C / Cmd+C copy, they never switch
  await page.keyboard.press("Control+c");
  await page.keyboard.press("Meta+c");
  // a rail menu open: the menu has the keyboard
  await page.getByRole("button", { name: /^Alerts/ }).click();
  await expect(page.locator("#trade-now-alerts")).toBeVisible();
  await page.keyboard.press("c");
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
});

test("in the cockpit a green dot says the screen is kept awake", async ({ page, context, baseURL }) => {
  await at(context, baseURL);
  await wakeLock(page, true);
  await page.goto("/options");
  await expect(page.locator("[data-trade-now] [data-board-row]").first()).toHaveAttribute("data-board-state", "enter_zone");
  await expect(toggle(page).locator("[data-awake-dot]")).toHaveCount(0);
  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute("data-awake", "held");
  await expect(toggle(page).locator("[data-awake-dot]")).toHaveClass(/bg-good-fill/);
  await expect(toggle(page)).toHaveAttribute("title", /Screen kept awake/);
  await toggle(page).click();
  await expect(toggle(page).locator("[data-awake-dot]")).toHaveCount(0);
});

test("a browser that refuses to keep the screen awake shows an amber dot and says so", async ({ page, context, baseURL }) => {
  await at(context, baseURL);
  await wakeLock(page, false);
  await page.goto("/options");
  await expect(page.locator("[data-trade-now] [data-board-row]").first()).toHaveAttribute("data-board-state", "enter_zone");
  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute("data-awake", "refused");
  await expect(toggle(page).locator("[data-awake-dot]")).toHaveClass(/bg-warn-fill/);
  await expect(toggle(page).locator("[data-awake-dot]")).toContainText("This browser may let the screen sleep");
});

test("Full screen shows only in the cockpit, and leaving it keeps the cockpit on", async ({ page, context, baseURL }) => {
  await at(context, baseURL);
  await page.goto("/options");
  await expect(page.locator("[data-trade-now] [data-board-row]").first()).toHaveAttribute("data-board-state", "enter_zone");
  await expect(page.locator("[data-fullscreen]")).toHaveCount(0);
  await toggle(page).click();
  const fs = page.locator("[data-fullscreen]");
  await expect(fs).toBeVisible();
  await fs.click();
  await expect(fs).toHaveAttribute("aria-pressed", "true");
  // leaving full screen the browser's way (its own Esc): the cockpit stays
  await page.evaluate(() => document.exitFullscreen());
  await expect(fs).toHaveAttribute("aria-pressed", "false");
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");
  await expect(ladders(page)).toBeVisible();
});

test("turning the cockpit off in full screen leaves full screen too, so nothing is left without a way back", async ({ page, context, baseURL }) => {
  await at(context, baseURL);
  await page.goto("/options");
  await expect(page.locator("[data-trade-now] [data-board-row]").first()).toHaveAttribute("data-board-state", "enter_zone");
  await toggle(page).click();
  await page.locator("[data-fullscreen]").click();
  await expect(page.locator("[data-fullscreen]")).toHaveAttribute("aria-pressed", "true");
  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
});
