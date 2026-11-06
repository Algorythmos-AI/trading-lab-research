import { expect, test, type BrowserContext, type Page } from "@playwright/test";

// CI-only. The "Trade now" board on the Options desk, on the scripted morning (`quotes-script`, fixture-script.ts):
// the `fxstep` cookie holds the step, and the feed's answer is dated at it, so the board reads the step's clock
// whatever the browser's clock says.

async function at(context: BrowserContext, baseURL: string | undefined, step: number) {
  await context.addCookies([
    { name: "fx", value: "focus.quotes-script", url: baseURL! },
    { name: "fxstep", value: String(step), url: baseURL! },
  ]);
}

const board = (page: Page) => page.locator("[data-trade-now]");
const rows = (page: Page) => board(page).locator("[data-board-row]");

test("shows a row per focus name, most urgent first, with only the entry expanded", async ({ page, context, baseURL }) => {
  await at(context, baseURL, 3);
  await page.goto("/options");
  await expect(board(page)).toHaveAttribute("data-trade-now", "live");
  await expect(rows(page).first()).toHaveAttribute("data-board-state", "enter_zone");
  await expect(rows(page)).toHaveCount(3);
  expect(await rows(page).evaluateAll((els) => els.map((e) => `${e.getAttribute("data-board-row")}:${e.getAttribute("data-board-state")}`))).toEqual([
    "QQQ:enter_zone",
    "SPY:plan_off",
    "AAPL:no_trade",
  ]);
  // the entry and the live failed break open up with their numbers; the runner plan stays folded
  await expect(board(page).locator('[data-expanded="true"]')).toHaveCount(2);
  const entry = rows(page).first();
  await expect(entry).toContainText("ENTER ZONE · CALL");
  await expect(entry).toContainText("Retest holding 752.86: call setup ready");
  await expect(entry.locator("[data-board-grid]")).toContainText("~752.95");
  await expect(entry).toContainText("Semis against");
  await expect(entry.locator("[data-board-runner]")).not.toHaveAttribute("open", "");
  await expect(entry.getByText(/^Sell half at/)).toBeHidden();
  await entry.getByText("Runner plan").click();
  await expect(entry.getByText(/^Sell half at/)).toBeVisible();
  const spy = rows(page).nth(1);
  await expect(spy).toContainText("FAILED BREAK · PUT");
  await expect(spy.locator("[data-testing-tag]")).toBeVisible();
  await expect(board(page).getByRole("link", { name: /Testing · not proven yet/ })).toHaveAttribute("href", "/strategies");
});

test("before 10:00 it shows the trigger prices only", async ({ page, context, baseURL }) => {
  await at(context, baseURL, 0);
  await page.goto("/options");
  await expect(board(page)).toHaveAttribute("data-trade-now", "opening");
  await expect(board(page)).toContainText("Opening range forming: first entries from 10:00");
  await expect(board(page).locator('[data-board-state="plan"]')).toHaveCount(3);
});

test("with the live prices off it says so and draws no rows", async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: "fx", value: "focus.quotes-off", url: baseURL! }]);
  // With no feed the board reads the browser's clock: stand it on the fixture's session, or the card reads as old.
  await page.clock.setFixedTime(new Date("2026-10-12T14:31:00Z"));
  await page.goto("/options");
  await expect(board(page)).toHaveAttribute("data-trade-now", "off");
  await expect(board(page)).toContainText("Live prices off: use the plans below");
  await expect(rows(page)).toHaveCount(0);
});

test("a notice fires once when a name enters the zone or its plan goes off", async ({ page, context, baseURL }) => {
  await at(context, baseURL, 2);
  await page.goto("/options");
  await expect(rows(page).first()).toHaveAttribute("data-board-state", "get_ready");
  await expect(page.locator("[data-board-notice]")).toHaveCount(0);
  await at(context, baseURL, 3);
  await expect(rows(page).first()).toHaveAttribute("data-board-state", "enter_zone", { timeout: 15_000 });
  await expect(page.locator("[data-board-notice]")).toHaveCount(2);
  await expect(page.locator('[data-board-notice="QQQ"]')).toContainText("QQQ: ENTER ZONE, call");
  // more polls of the same step announce nothing new
  await page.waitForTimeout(5_000);
  await expect(page.locator("[data-board-notice]")).toHaveCount(2);
  await page.getByRole("button", { name: "Dismiss the notice for QQQ" }).click();
  await expect(page.locator("[data-board-notice]")).toHaveCount(1);
});

test("an old focus card hides the rows and says which day it is for", async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: "fx", value: "focus.quotes-off", url: baseURL! }]);
  await page.clock.setFixedTime(new Date("2026-10-14T14:31:00Z"));
  await page.goto("/options");
  await expect(board(page)).toHaveAttribute("data-trade-now", "old");
  await expect(board(page)).toContainText("Focus card is for Mon 12 Oct");
  await expect(rows(page)).toHaveCount(0);
});

test("on a phone one notice shows at a time, below the board, with a count of the rest", async ({ page, context, baseURL, isMobile }) => {
  test.skip(!isMobile, "the phone's layout");
  await at(context, baseURL, 2);
  await page.goto("/options");
  await expect(rows(page).first()).toHaveAttribute("data-board-state", "get_ready");
  await at(context, baseURL, 3);
  await expect(page.locator("[data-board-notice]")).toHaveCount(2, { timeout: 15_000 });
  await expect(page.locator("[data-board-notice]:visible")).toHaveCount(1);
  await expect(page.locator("[data-board-more]")).toHaveText("+1 more");
  const b = (await board(page).boundingBox())!;
  const n = (await page.locator("[data-board-notice]:visible").boundingBox())!;
  expect(n.y >= b.y + b.height || n.y + n.height <= b.y).toBe(true);
});

test("on a phone the alert switches sit behind one bell", async ({ page, context, baseURL, isMobile }) => {
  test.skip(!isMobile, "the phone's layout");
  await at(context, baseURL, 3);
  await page.goto("/options");
  const bell = page.getByRole("button", { name: "Alerts: sound and browser notification" });
  await expect(bell).toHaveAttribute("aria-expanded", "false");
  await bell.click();
  await expect(bell).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#trade-now-alerts").getByRole("button", { name: "Sound" })).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("Escape");
  await expect(bell).toHaveAttribute("aria-expanded", "false");
  await expect(bell).toBeFocused();
});

test("tapping a row brings its focus card into view", async ({ page, context, baseURL }) => {
  await at(context, baseURL, 3);
  await page.goto("/options");
  await expect(rows(page).first()).toHaveAttribute("data-board-state", "enter_zone");
  await rows(page).filter({ hasText: "AAPL" }).getByRole("button").click();
  await expect(page.locator("#focus-card-AAPL")).toBeFocused();
});

test("fits a 375 px screen with no sideways scroll", async ({ page, context, baseURL }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await at(context, baseURL, 3);
  await page.goto("/options");
  await expect(rows(page).first()).toHaveAttribute("data-board-state", "enter_zone");
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(over).toBeLessThanOrEqual(0);
  const box = await board(page).boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(375);
});
