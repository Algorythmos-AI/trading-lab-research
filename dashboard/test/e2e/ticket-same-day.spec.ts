import { expect, test, type BrowserContext, type Page } from "@playwright/test";

// CI-only. The ticket's same-day line on a typed contract: with the chain off, the expiry is a typed date, so every
// number comes from what was typed (price, strike, expiry) and the live stock price. The board walks the scripted
// morning at step 3 and the page and browser clocks stand at the fixture session's 11:01 New York (`frozen`).

const FROZEN_NOW = "2026-10-12T15:01:00Z";
const SESSION = "2026-10-12";

async function open(page: Page, context: BrowserContext, baseURL: string | undefined) {
  await context.addCookies([
    { name: "fx", value: "frozen.focus.quotes-script.chain-off", url: baseURL! },
    { name: "fxstep", value: "3", url: baseURL! },
  ]);
  await page.clock.setFixedTime(new Date(FROZEN_NOW));
  await page.goto("/options");
  const ticket = page.locator('#focus-card-QQQ [data-ticket="call"]');
  await ticket.locator("summary").click();
  return ticket;
}

test("a same-day call says it expires today and that the premium stop fires first, with each loss after fees", async ({ page, context, baseURL }) => {
  const ticket = await open(page, context, baseURL);
  await ticket.locator("input[data-ticket-price]").fill("1.50");
  await ticket.getByLabel("Strike", { exact: true }).fill("755");
  await ticket.getByLabel("Expiry").fill(SESSION);
  const block = ticket.locator("[data-ticket-same-day]");
  await expect(block).toBeVisible({ timeout: 15_000 });
  await expect(block).toContainText("Expires today");
  const compare = block.locator("[data-ticket-same-day-compare]");
  await expect(compare).toHaveAttribute("data-ticket-same-day-compare", "premium");
  // The premium stop's loss is the sized one the ticket shows; the chart stop's is the estimate's, both fees in.
  await expect(compare).toContainText(/^The −25% premium stop fires first, before the stock reaches the chart stop: −\$[\d,]+\.\d\d at the −25% premium stop \$\d+\.\d\d; ≈ −\$[\d,]+\.\d\d at the chart stop \d+\.\d\d\. Fees in\./);
  const risk = (await ticket.locator("[data-ticket-risk] dd").first().innerText()).trim();
  const stop = (await ticket.locator("[data-ticket-stop] dd").first().innerText()).trim();
  await expect(compare).toContainText(`${risk} at the −25% premium stop ${stop};`);
  const est = await ticket.locator('[data-ticket-est="stop"]').innerText();
  const chartLoss = est.match(/\((−\$[\d,]+\.\d\d) on \d+\)/)?.[1];
  expect(chartLoss).toBeTruthy();
  await expect(compare).toContainText(`≈ ${chartLoss} at the chart stop`);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});

test("a contract that expires next week has no same-day line", async ({ page, context, baseURL }) => {
  const ticket = await open(page, context, baseURL);
  await ticket.locator("input[data-ticket-price]").fill("1.50");
  await ticket.getByLabel("Strike", { exact: true }).fill("755");
  await ticket.getByLabel("Expiry").fill("2026-10-19");
  await expect(ticket.locator('[data-ticket-est="stop"]')).toBeVisible({ timeout: 15_000 });
  await expect(ticket.locator("[data-ticket-same-day]")).toHaveCount(0);
});

test("without an estimate the same-day line stands alone, with no comparison", async ({ page, context, baseURL }) => {
  const ticket = await open(page, context, baseURL);
  await ticket.locator("input[data-ticket-price]").fill("1.50");
  await ticket.getByLabel("Expiry").fill(SESSION);
  // No strike: no estimate, so no order of stops is guessed.
  await expect(ticket.locator("[data-ticket-same-day]")).toContainText("Expires today", { timeout: 15_000 });
  await expect(ticket.locator("[data-ticket-same-day-compare]")).toHaveCount(0);
  await expect(ticket.locator("[data-ticket-no-estimate]")).toContainText("No estimate without a strike.");
});
