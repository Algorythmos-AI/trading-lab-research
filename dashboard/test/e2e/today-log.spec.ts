import { expect, test, type BrowserContext, type Page } from "@playwright/test";

// CI-only. The rail's "Today" log on the scripted morning (fixture-script.ts): step 2 has QQQ getting ready, step 3 has
// it in the zone and SPY's break failed, so going from 2 to 3 adds lines (at least QQQ's and SPY's).

async function at(context: BrowserContext, baseURL: string | undefined, step: number) {
  await context.addCookies([
    { name: "fx", value: "focus.quotes-script", url: baseURL! },
    { name: "fxstep", value: String(step), url: baseURL! },
  ]);
}
const rows = (page: Page) => page.locator("[data-trade-now] [data-board-row]");
const button = (page: Page) => page.locator("[data-today-log-button]");
const log = (page: Page) => page.locator("#today-log");

/** Opens on step 2, moves to step 3, and returns how many lines the log then holds (two names changed, at least). */
async function toStep3(page: Page, context: BrowserContext, baseURL: string | undefined): Promise<number> {
  await at(context, baseURL, 2);
  await page.goto("/options");
  await expect(rows(page).first()).toHaveAttribute("data-board-state", "get_ready");
  await at(context, baseURL, 3);
  await expect(rows(page).first()).toHaveAttribute("data-board-state", "enter_zone", { timeout: 15_000 });
  await page.waitForTimeout(3_000); // the step's changes all landed
  const n = Number(await button(page).getAttribute("data-today-unread"));
  expect(n).toBeGreaterThanOrEqual(2);
  return n;
}

test("new changes are counted on the button until the log is opened", async ({ page, context, baseURL }) => {
  const n = await toStep3(page, context, baseURL);
  await expect(button(page).locator("[data-today-new]")).toContainText(String(n));
  await expect(button(page)).toHaveAccessibleName(`Today · ${n} ${n} new`);
  await button(page).click();
  await expect(log(page).locator("[data-log-line]")).toHaveCount(n);
  await page.keyboard.press("Escape");
  await expect(button(page)).toHaveAttribute("data-today-unread", "0");
  await expect(button(page).locator("[data-today-new]")).toHaveCount(0);
});

test("the log groups by hour, colours each line, and filters by name", async ({ page, context, baseURL }) => {
  const n = await toStep3(page, context, baseURL);
  await button(page).click();
  await expect(log(page).locator("[role=group] h3")).toHaveText(["10:00"]);
  await expect(log(page).locator('[data-log-line="QQQ"]').first()).toContainText("ENTER ZONE");
  await expect(log(page).locator('[data-log-line="QQQ"]').first()).toContainText("CALL");
  await log(page).locator('[data-log-filter="SPY"]').click();
  await expect(log(page).locator('[data-log-filter="SPY"]')).toHaveAttribute("aria-pressed", "true");
  const spy = await log(page).locator("[data-log-line]").count();
  expect(spy).toBeGreaterThanOrEqual(1);
  expect(spy).toBeLessThan(n);
  expect(await log(page).locator('[data-log-line]:not([data-log-line="SPY"])').count()).toBe(0);
  await log(page).locator('[data-log-filter="all"]').click();
  await expect(log(page).locator("[data-log-line]")).toHaveCount(n);
});

test("a reload keeps the log and adds no line twice", async ({ page, context, baseURL }) => {
  const n = await toStep3(page, context, baseURL);
  await page.reload();
  await expect(rows(page).first()).toHaveAttribute("data-board-state", "enter_zone");
  await page.waitForTimeout(4_000); // several polls of the same step
  await button(page).click();
  await expect(log(page).locator("[data-log-line]")).toHaveCount(n);
});

test("two tabs on the same session share one log and never overwrite each other", async ({ page, context, baseURL }) => {
  const n = await toStep3(page, context, baseURL);
  const other = await context.newPage();
  await other.goto("/options");
  await expect(rows(other).first()).toHaveAttribute("data-board-state", "enter_zone");
  // the second tab opened on step 3, so it saw no change itself, yet it shows the first tab's lines
  await other.locator("[data-today-log-button]").click();
  await expect(other.locator("#today-log [data-log-line]")).toHaveCount(n);
  // and the first tab still has all of them
  await button(page).click();
  await expect(log(page).locator("[data-log-line]")).toHaveCount(n);
  await other.close();
});

test("on a phone the log hangs inside the screen's gutters", async ({ page, context, baseURL, isMobile }) => {
  test.skip(!isMobile, "the phone's layout");
  await toStep3(page, context, baseURL);
  await button(page).click();
  const box = (await log(page).boundingBox())!;
  const vw = page.viewportSize()!.width;
  expect(box.x).toBeGreaterThanOrEqual(15);
  expect(box.x + box.width).toBeLessThanOrEqual(vw - 15);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});
