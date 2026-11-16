import { expect, test, type BrowserContext, type Page } from "@playwright/test";

// CI-only. The owner's −25% premium stop on the manage card (held-marks.ts, held-store.ts): the journal's QQQ call
// bought at $17.00 (`journal-option-stop`), so the fixture's sample bid is under its $12.75 stop. Once two fresh quotes
// have read under it the card says EXIT with the stop's line, the notice is raised, the bar says the exit, and the
// day pill adds the open loss (rule 7). As option-value.spec.ts: the scripted morning at step 3, the server's clock
// and the journal standing still, the browser's wall clock set to the same instant.

const FROZEN_NOW = "2026-10-12T15:01:00Z";

async function open(page: Page, context: BrowserContext, baseURL: string | undefined, flags: string) {
  await context.addCookies([
    { name: "fx", value: flags, url: baseURL! },
    { name: "fxstep", value: "3", url: baseURL! },
  ]);
  await page.clock.setFixedTime(new Date(FROZEN_NOW));
  await page.goto("/options");
}

const card = (page: Page) => page.locator('[data-manage="QQQ"][data-manage-source="journal"]');

test("under its −25% stop the card says EXIT, with the stop's line, the notice and the bar", async ({ page, context, baseURL }) => {
  await open(page, context, baseURL, "frozen.focus.quotes-script.chain-opra.journal-option-stop");
  const c = card(page);
  await expect(c).toBeVisible();
  await expect(c).toHaveAttribute("data-manage-action", "exit", { timeout: 20_000 });
  await expect(c.locator("[data-manage-line]")).toContainText(/EXIT\s*Bid \$\d+\.\d\d under your −25% stop \$12\.75: exit/);
  const value = c.locator('[data-manage-value="live"]');
  await expect(value.locator("[data-manage-value-stop-label]")).toHaveText("Bid under the −25% stop: exit");
  await expect(value.locator("[data-manage-value-stop]")).toContainText(/\$\d+\.\d\d under/);
  await expect(value.locator("[data-manage-value-stop]")).toHaveAttribute("data-manage-value-band", "hit");
  await expect(page.locator('[data-manage-notice="QQQ"]')).toContainText("QQQ call: EXIT");
  // Rule 7: the open loss at the bid joins the day's figure, and the open-position line says it.
  await expect(page.locator("[data-rail-day]")).toContainText(/\$\d+ of \$100 · \$\d+ open/);
  await expect(page.locator("[data-day-open]")).toContainText(/1 position open: −\$\d+ at the bid, counted toward the \$100 day stop \(rule 7\)\./);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});

test("the stop stays fired across a reload", async ({ page, context, baseURL }) => {
  await open(page, context, baseURL, "frozen.focus.quotes-script.chain-opra.journal-option-stop");
  await expect(card(page)).toHaveAttribute("data-manage-action", "exit", { timeout: 20_000 });
  await page.reload();
  // Before any quote is read again, the latch in this browser already says EXIT.
  await expect(card(page)).toHaveAttribute("data-manage-action", "exit", { timeout: 10_000 });
});

test("above its stop the card is unchanged: HOLD, and the bar says the room", async ({ page, context, baseURL }) => {
  await open(page, context, baseURL, "frozen.focus.quotes-script.chain-opra.journal-option-lot");
  const c = card(page);
  const value = c.locator('[data-manage-value="live"]');
  await expect(value).toBeVisible({ timeout: 15_000 });
  await expect(value.locator("[data-manage-value-stop-label]")).toHaveText("Bid above the −25% stop");
  await expect(c).not.toHaveAttribute("data-manage-action", "exit");
  // A position in profit adds nothing to the day's figure.
  await expect(page.locator("[data-rail-day]")).not.toContainText(" open");
});
