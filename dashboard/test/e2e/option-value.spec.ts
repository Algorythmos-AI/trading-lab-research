import { expect, test, type BrowserContext, type Page } from "@playwright/test";

// CI-only. The option's own market in fixture mode (option-value.ts): the manage card's live value for the one QQQ
// call the `journal-option-lot` journal holds, on the sample OPRA feed (`chain-opra`), and withheld on the indicative
// one; and the ticket's live bid × ask line with its above-the-ask warning. The board walks the scripted morning at
// step 3 (10:28 New York), the server's page clock and the journal stand still (`frozen`), and the browser's wall
// clock is set to the same instant, so the journal is current and the position total shows.

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

test("the journal's QQQ call shows its live value at the bid, the total, the stop and the quote line", async ({ page, context, baseURL }) => {
  await open(page, context, baseURL, "frozen.focus.quotes-script.chain-opra.journal-option-lot");
  const c = card(page);
  await expect(c).toBeVisible();
  const value = c.locator('[data-manage-value="live"]');
  await expect(value).toBeVisible({ timeout: 15_000 });
  await expect(value).toContainText(/Live option value: \$[\d,]+\.\d\d a contract at the bid \(\$[\d,]+\.\d\d at the mid\)/);
  await expect(value.locator("[data-manage-value-pnl]")).toContainText("a contract at the bid, fees in");
  await expect(value.locator("[data-manage-value-total]")).toContainText("on 2 contracts");
  await expect(value.locator("[data-manage-value-stop]")).toContainText("above the −25% stop $0.90, from your journal average $1.20");
  await expect(value.locator("[data-manage-value-quote]")).toContainText(/× .* · spread \$\d+\.\d\d · sample data · checked \d+ s ago/);
  await expect(value.locator("[data-manage-value-quote]")).not.toContainText("OPRA");
  await expect(c.locator('[data-manage-small="pnl"]')).toContainText("at the bid, below");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});

test("on the indicative feed the value is withheld, with the reason", async ({ page, context, baseURL }) => {
  await open(page, context, baseURL, "frozen.focus.quotes-script.journal-option-lot");
  const c = card(page);
  await expect(c.locator('[data-manage-value="withheld"]')).toContainText("Live option value not available: the option feed here is 15 minutes behind, not OPRA.", { timeout: 15_000 });
  await expect(c.locator('[data-manage-value="live"]')).toHaveCount(0);
  await expect(c.locator('[data-manage-small="pnl"]')).toContainText("see Webull");
});

test("with the option feed off there is no value, and the reason says so", async ({ page, context, baseURL }) => {
  await open(page, context, baseURL, "frozen.focus.quotes-script.chain-opra.chain-off.journal-option-lot");
  const c = card(page);
  await expect(c).toBeVisible();
  // chain-off takes the chain away too, so the contract cannot be confirmed: no line at all, never a guess
  await expect(c.locator("[data-manage-value]")).toHaveCount(0);
  await expect(c.locator('[data-manage-small="pnl"]')).toContainText("see Webull");
});

test("the ticket shows the live bid × ask beside a typed price, and warns when it is above the ask", async ({ page, context, baseURL }) => {
  await open(page, context, baseURL, "frozen.focus.quotes-script.chain-opra");
  // A call the fixture chain prices cheaply enough to size, with a sane quote: read from the route the page reads.
  const chain = (await (await page.request.get("/api/chain?s=QQQ&px=600")).json()) as {
    expiries: { date: string; contracts: { kind: string; strike: number; bid: number | null; ask: number | null }[] }[];
  };
  let pick: { date: string; strike: number } | null = null;
  for (const x of chain.expiries)
    for (const k of x.contracts)
      if (!pick && k.kind === "call" && k.bid !== null && k.ask !== null && k.bid >= 0.05 && k.ask >= 0.3 && k.ask <= 1.5 && (k.ask - k.bid) / ((k.ask + k.bid) / 2) <= 0.25) pick = { date: x.date, strike: k.strike };
  expect(pick, "a cheap call with a sane quote in the fixture chain").not.toBeNull();
  const occ = `QQQ${pick!.date.slice(2).replace(/-/g, "")}C${String(Math.round(pick!.strike * 1000)).padStart(8, "0")}`;
  const live = (await (await page.request.get(`/api/contract?s=${occ}`)).json()) as { contracts: Record<string, { ask: number }> };
  const above = (Math.ceil(live.contracts[occ]!.ask * 100) + 10) / 100;

  const ticket = page.locator('#focus-card-QQQ [data-ticket="call"]');
  await ticket.locator("summary").click();
  await ticket.locator("input[data-ticket-price]").fill(above.toFixed(2));
  await expect(ticket.locator("[data-ticket-size]")).toBeVisible();
  await ticket.getByLabel("Expiry").selectOption(pick!.date);
  await ticket.getByLabel("Strike", { exact: true }).fill(String(pick!.strike));
  const check = ticket.locator("[data-ticket-live]");
  await expect(check).toContainText(/Live quote \(sample data\) \$\d+\.\d\d × \$\d+\.\d\d · spread \$\d+\.\d\d · checked \d+ s ago/, { timeout: 15_000 });
  await expect(check.locator("[data-ticket-live-warn]")).toHaveText(/^Your price is above the ask \(\$\d+\.\d\d\)\.$/);
  await expect(check.locator("[data-ticket-live-cost]")).toContainText("A round trip at this spread:");
  await expect(check.locator("[data-ticket-live-cost]")).toContainText("planned risk");
});
